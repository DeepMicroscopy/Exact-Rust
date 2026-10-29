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
