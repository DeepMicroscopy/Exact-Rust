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
    /// Repair one damaged TIFF in place: pyramid rebuilt from level 0, original kept as `<name>.orig.<ext>`.
    RepairImage { file: PathBuf },
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
