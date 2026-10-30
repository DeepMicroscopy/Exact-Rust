use anyhow::{bail, Context};
use clap::{Parser, Subcommand};
use exact_core::Config;
use exact_db::schema;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "exact-cli", about = "EXACT management commands")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Write the live DB's table/column layout as the schema baseline (reads only).
    SchemaDump { out: PathBuf },
    /// Compare the live DB with a baseline file; exit non-zero on drift.
    SchemaCheck { baseline: PathBuf },
    /// Scan an image store (read-only) for damaged files, e.g. TIFFs whose zoom pyramid is not a copy of level 0.
    CheckImages {
        /// Folder to scan recursively (the image root or one image set folder).
        dir: PathBuf,
    },
    /// Measure how far the pyramid levels of a file are shifted against level 0 (a cause of tiles that "wobble" when zooming).
    LevelOffsets { file: PathBuf },
    /// Measure the pyramid level offsets of all images that need them (CZI, VSI, DICOM, OME/generic TIFF) and store them in
    /// `images_pyramidregistration`, so that the first opening of a slide in the viewer does not wait for the measurement.
    /// Reads the image files only; writes that one table. Safe to repeat and to interrupt: files already stored are skipped.
    PrecomputeOffsets {
        /// Files measured at the same time (each one uses a slideio helper process).
        #[arg(long, default_value_t = 2)]
        jobs: usize,
        /// Stop after this many measurements (to try it out).
        #[arg(long)]
        limit: Option<usize>,
        /// Measure again, also where a valid measurement is stored.
        #[arg(long)]
        force: bool,
        /// List what would be measured; touch nothing.
        #[arg(long)]
        dry_run: bool,
    },
    /// Repair one damaged TIFF in place: pyramid rebuilt from level 0, original kept as `<name>.orig.<ext>`.
    RepairImage { file: PathBuf },
    /// Read every stored passkey (`passkeys_userpasskey`) the way the server does and report those it cannot use (reads only).
    AuditPasskeys,
    /// Create the additive tables the Rust server needs (sessions). Safe to repeat; Django tables are untouched.
    Migrate {
        /// Must equal the configured database name; guards against running against the wrong database.
        #[arg(long)]
        confirm_db: String,
    },
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let cfg = Config::from_env()?;
    match Cli::parse().cmd {
        Cmd::SchemaDump { out } => {
            let pool = exact_db::connect(&cfg).await?;
            let t = schema::introspect(&pool).await?;
            std::fs::write(&out, serde_json::to_string_pretty(&t)?)?;
            println!("{} tables -> {}", t.len(), out.display());
        }
        Cmd::LevelOffsets { file } => {
            let slide = exact_wsi::formats::open(&file.to_string_lossy())?;
            let dims = slide.level_dimensions();
            let down = slide.level_downsamples();
            let off = exact_wsi::registration::estimate_level_offsets(slide.as_ref());
            println!(
                "{}  needs_registration={}",
                file.display(),
                slide.needs_registration()
            );
            for (i, ((w, h), d)) in dims.iter().zip(&down).enumerate() {
                let (dx, dy) = off.get(i).copied().unwrap_or((0.0, 0.0));
                println!("level {i}: {w} x {h}  downsample {d:.4}  offset ({dx:+.3}, {dy:+.3}) px of that level");
            }
        }
        Cmd::PrecomputeOffsets {
            jobs,
            limit,
            force,
            dry_run,
        } => precompute_offsets(&cfg, jobs.max(1), limit, force, dry_run).await?,
        Cmd::CheckImages { dir } => {
            let mut files = Vec::new();
            collect_tiffs(&dir, &mut files);
            files.sort();
            let (mut damaged, mut unreadable) = (0, 0);
            for f in &files {
                match exact_wsi::formats::open(&f.to_string_lossy()) {
                    Ok(s) if s.issues().is_empty() => {}
                    Ok(s) => {
                        damaged += 1;
                        println!("DAMAGED     {}  ({})", f.display(), s.issues().join(", "));
                    }
                    Err(e) => {
                        unreadable += 1;
                        println!("UNREADABLE  {}  ({e})", f.display());
                    }
                }
            }
            println!(
                "{} TIFF files checked: {damaged} damaged, {unreadable} unreadable",
                files.len()
            );
            if damaged > 0 {
                println!("repair one with: exact-cli repair-image <file>   (or from the viewer)");
            }
        }
        Cmd::RepairImage { file } => {
            let last = std::cell::Cell::new(-1i32);
            let r = exact_wsi::repair::repair_in_place(&file.to_string_lossy(), &|v| {
                let pct = (v * 100.0) as i32;
                if pct != last.get() && pct % 10 == 0 {
                    last.set(pct);
                    eprintln!("  {pct}%");
                }
            })
            .map_err(|e| anyhow::anyhow!("{e}"))?;
            println!(
                "repaired ({} levels); original kept as {}",
                r.levels,
                r.backup.display()
            );
        }
        Cmd::AuditPasskeys => {
            let pool = exact_db::connect(&cfg).await?;
            let rows: Vec<(i32, i64, String, bool, String)> = sqlx::query_as(
                "SELECT id, user_id::bigint, name, enabled, token FROM passkeys_userpasskey ORDER BY id",
            )
            .fetch_all(&pool)
            .await
            .context("reading passkeys_userpasskey")?;
            let (mut es256, mut rs256, mut bad) = (0, 0, 0);
            for (id, user, name, enabled, token) in &rows {
                match exact_auth::webauthn::parse_stored_token(token) {
                    Ok(c) => match c.public_key {
                        exact_auth::webauthn::PublicKey::Es256(_) => es256 += 1,
                        exact_auth::webauthn::PublicKey::Rs256(_) => rs256 += 1,
                    },
                    Err(e) => {
                        bad += 1;
                        println!("UNUSABLE  passkey {id} (user {user}, {name:?}, enabled: {enabled}): {e}");
                    }
                }
            }
            println!(
                "{} passkeys: {es256} ES256, {rs256} RS256, {bad} unusable here (they would have to be enrolled again)",
                rows.len()
            );
            if bad > 0 {
                std::process::exit(1);
            }
        }
        Cmd::Migrate { confirm_db } => {
            if confirm_db != cfg.db_name {
                bail!(
                    "--confirm-db {confirm_db} does not match the configured database {}",
                    cfg.db_name
                );
            }
            let pool = exact_db::connect(&cfg).await?;
            exact_db::sessions::migrate(&pool).await?;
            println!("migrations applied");
        }
        Cmd::SchemaCheck { baseline } => {
            let pool = exact_db::connect(&cfg).await?;
            let expected: schema::Tables = serde_json::from_str(
                &std::fs::read_to_string(&baseline).context("reading baseline")?,
            )?;
            let d = schema::diff(&expected, &schema::introspect(&pool).await?);
            if d.is_empty() {
                println!("schema matches baseline ({} tables)", expected.len());
            } else {
                d.iter().for_each(|l| println!("{l}"));
                bail!("{} schema differences", d.len());
            }
        }
    }
    Ok(())
}

/// All TIFF files below `dir` that are not backups or temporary files of a repair.
fn collect_tiffs(dir: &std::path::Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            collect_tiffs(&p, out);
            continue;
        }
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        let is_tiff = name.ends_with(".tif") || name.ends_with(".tiff");
        if is_tiff
            && !name.contains(".orig")
            && !name.contains(".repaired")
            && !name.contains("_thumbnail")
        {
            out.push(p);
        }
    }
}

/// Extensions of the files whose readers may need registration (everything else is read by OpenSlide or is a plain image).
const OFFSET_EXTENSIONS: [&str; 8] = ["czi", "vsi", "dcm", "tif", "tiff", "btf", "ome.tif", "ome.tiff"];

async fn precompute_offsets(
    cfg: &Config,
    jobs: usize,
    limit: Option<usize>,
    force: bool,
    dry_run: bool,
) -> anyhow::Result<()> {
    use std::sync::Arc;
    let pool = exact_db::connect(cfg).await?;
    // single-file images only: the stored offsets are per image (as in the server)
    let rows: Vec<(i64, String, String)> = sqlx::query_as(
        "SELECT i.id, s.path, i.filename FROM images_image i JOIN images_imageset s ON s.id = i.image_set_id \
         WHERE i.depth = 1 ORDER BY i.id",
    )
    .fetch_all(&pool)
    .await
    .context("reading the images")?;
    let candidates: Vec<_> = rows
        .into_iter()
        .filter(|(_, _, f)| {
            let l = f.to_ascii_lowercase();
            OFFSET_EXTENSIONS.iter().any(|e| l.ends_with(&format!(".{e}")))
        })
        .collect();
    println!("{} images with a format that may need offsets", candidates.len());
    let sem = Arc::new(tokio::sync::Semaphore::new(jobs));
    let mut tasks = tokio::task::JoinSet::new();
    let (mut done, mut skipped, mut failed, mut started) = (0usize, 0usize, 0usize, 0usize);
    let total = candidates.len();
    for (n, (id, set_path, filename)) in candidates.into_iter().enumerate() {
        if limit.is_some_and(|l| started >= l) {
            break;
        }
        let path = cfg.image_path.join(&set_path).join(&filename);
        let Ok(meta) = std::fs::metadata(&path) else {
            println!("[{}/{total}] image {id}: file missing ({})", n + 1, path.display());
            failed += 1;
            continue;
        };
        let size = meta.len() as i64;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0, |d| d.as_secs() as i64);
        if !force {
            if let Some(r) = exact_db::registration::get(&pool, id).await? {
                if r.algorithm == exact_wsi::registration::ALGORITHM
                    && r.file_size == size
                    && r.file_mtime == mtime
                {
                    skipped += 1;
                    continue;
                }
            }
        }
        started += 1;
        if dry_run {
            println!("would measure image {id}: {}", path.display());
            continue;
        }
        let permit = sem.clone().acquire_owned().await?;
        let pool = pool.clone();
        tasks.spawn(async move {
            let t = std::time::Instant::now();
            let p = path.to_string_lossy().into_owned();
            let r = tokio::task::spawn_blocking(move || {
                let slide = exact_wsi::formats::open(&p).map_err(|e| e.to_string())?;
                if !slide.needs_registration() {
                    return Ok(None);
                }
                Ok::<_, String>(Some(exact_wsi::registration::estimate_level_offsets(slide.as_ref())))
            })
            .await
            .map_err(|e| e.to_string())
            .and_then(|r| r);
            drop(permit);
            let out = match r {
                Ok(Some(o)) => exact_db::registration::put(
                    &pool,
                    id,
                    &o,
                    exact_wsi::registration::ALGORITHM,
                    size,
                    mtime,
                )
                .await
                .map(|_| "stored".to_string())
                .map_err(|e| e.to_string()),
                Ok(None) => Ok("needs none".to_string()),
                Err(e) => Err(e),
            };
            (id, n + 1, t.elapsed(), out)
        });
        while let Some(Ok((id, k, el, out))) = tasks.try_join_next() {
            report(id, k, total, el, out, &mut done, &mut failed);
        }
    }
    while let Some(Ok((id, k, el, out))) = tasks.join_next().await {
        report(id, k, total, el, out, &mut done, &mut failed);
    }
    println!("{done} measured, {skipped} already stored, {failed} failed");
    Ok(())
}

fn report(
    id: i64,
    k: usize,
    total: usize,
    el: std::time::Duration,
    out: Result<String, String>,
    done: &mut usize,
    failed: &mut usize,
) {
    match out {
        Ok(what) => {
            *done += 1;
            println!("[{k}/{total}] image {id}: {what} ({:.1} s)", el.as_secs_f64());
        }
        Err(e) => {
            *failed += 1;
            println!("[{k}/{total}] image {id}: FAILED {e}");
        }
    }
}
