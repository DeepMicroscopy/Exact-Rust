//! One-time repair of generic pyramidal TIFFs whose pyramid pages are not downscaled copies of page 0.
//!
//! The pixels of level 0 are copied *as stored* (no recompression), the pyramid is rebuilt from level 0 tile by tile
//! (each tile of a level needs the four tiles below it, so memory stays flat however large the file is) and written to
//! a temporary file next to the original. When the result checks out, the original is kept as a backup
//! (`<stem>.orig.<ext>`) and the new file takes its name.

use crate::{
    err,
    generic_tiff::GenericTiff,
    tiff::{self, ChunkCache, Page, Tiff},
    tiff_write::{Entry, TiffWriter},
    Result, Slide, WsiError,
};
use image::RgbaImage;
use std::path::{Path, PathBuf};

const TILE: u64 = 256;

pub struct Repaired {
    pub backup: PathBuf,
    pub levels: usize,
}

/// 2x2 box reduction of a 512x512 RGBA region into a 256x256 tile with `samples` channels; transparent
/// (outside the image) source pixels do not contribute.
fn reduce(src: &RgbaImage, samples: usize) -> Vec<u8> {
    let mut out = vec![0u8; (TILE * TILE) as usize * samples];
    for oy in 0..TILE as u32 {
        for ox in 0..TILE as u32 {
            let (mut sum, mut a_sum, mut n) = ([0u32; 3], 0u32, 0u32);
            for (dx, dy) in [(0, 0), (1, 0), (0, 1), (1, 1)] {
                let p = src.get_pixel(ox * 2 + dx, oy * 2 + dy);
                a_sum += p[3] as u32;
                if p[3] > 0 {
                    n += 1;
                    for c in 0..3 {
                        sum[c] += p[c] as u32;
                    }
                }
            }
            let o = ((oy as u64 * TILE + ox as u64) as usize) * samples;
            if let Some(div) = std::num::NonZeroU32::new(n) {
                for c in 0..3 {
                    out[o + c] = ((sum[c] + n / 2) / div.get()) as u8;
                }
            }
            if samples == 4 {
                out[o + 3] = ((a_sum + 2) / 4) as u8;
            }
        }
    }
    out
}

fn encode(raw: Vec<u8>, compression: u64, samples: usize) -> Result<Vec<u8>> {
    match compression {
        1 => Ok(raw),
        5 => weezl::encode::Encoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
            .encode(&raw)
            .map_err(|e| WsiError(format!("LZW: {e}"))),
        8 | 32946 => {
            use std::io::Write;
            let mut z = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            z.write_all(&raw).map_err(|e| WsiError(e.to_string()))?;
            z.finish().map_err(|e| WsiError(e.to_string()))
        }
        7 if samples == 3 => {
            use image::ImageEncoder;
            let mut out = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
                .write_image(
                    &raw,
                    TILE as u32,
                    TILE as u32,
                    image::ExtendedColorType::Rgb8,
                )
                .map_err(|e| WsiError(format!("JPEG: {e}")))?;
            Ok(out)
        }
        c => err(format!("compression {c} cannot be written")),
    }
}

/// Rebuilds the pyramid of `src` into `dst` (a new file). `progress` receives values in 0..1.
pub fn rebuild_pyramid(src: &str, dst: &str, progress: &dyn Fn(f32)) -> Result<usize> {
    let t = Tiff::open(src)?;
    let ifd0 = t.read_ifd(t.first_ifd_offset()?)?;
    let page0 = Page::new(&t, &ifd0)?;
    if !page0.is_tiled() {
        return err("only tiled TIFF files can be repaired");
    }
    let (comp, samples) = (page0.compression(), page0.samples);
    if !matches!(comp, 1 | 5 | 7 | 8 | 32946) || (comp == 7 && samples != 3) {
        return err(format!(
            "compression {comp} with {samples} channels is not supported for repair"
        ));
    }
    // level sizes
    let mut dims = vec![(page0.width, page0.height)];
    while dims.last().is_some_and(|d| d.0 > 512 || d.1 > 512) {
        let d = dims.last().copied().unwrap_or((1, 1));
        dims.push((d.0.div_ceil(2), d.1.div_ceil(2)));
    }
    let tiles = |d: (u64, u64)| d.0.div_ceil(TILE) * d.1.div_ceil(TILE);
    let total: u64 =
        page0.chunk_count() as u64 + dims.iter().skip(1).map(|d| tiles(*d)).sum::<u64>();
    let mut done = 0u64;
    let mut tick = |n: u64| {
        done += n;
        progress((done as f32 / total as f32).min(1.0));
    };

    let mut w = TiffWriter::create(dst)?;
    // level 0: stored chunks copied unchanged, all tags kept except the chunk tables and SubIFDs
    let (mut offs, mut cnts) = (
        Vec::with_capacity(page0.chunk_count()),
        Vec::with_capacity(page0.chunk_count()),
    );
    for i in 0..page0.chunk_count() {
        let (o, l) = w.write_chunk(&page0.raw_chunk(i)?)?;
        offs.push(o);
        cnts.push(l);
        tick(1);
    }
    let mut entries: Vec<Entry> = ifd0
        .entries_le()
        .into_iter()
        .filter(|(tag, ..)| {
            !matches!(
                *tag,
                tiff::TAG_TILE_OFFSETS | tiff::TAG_TILE_COUNTS | tiff::TAG_SUBIFDS | 254
            )
        })
        .map(|(tag, typ, data)| Entry::raw(tag, typ, data))
        .collect();
    entries.push(Entry::long8(tiff::TAG_TILE_OFFSETS, &offs));
    entries.push(Entry::long8(tiff::TAG_TILE_COUNTS, &cnts));
    w.add_page(entries);
    w.flush()?;

    // lower levels, each read back from the level below as it was written
    let reader = Tiff::open(dst)?;
    let cache = ChunkCache::new(256);
    let mut prev = page0;
    let photometric = if comp == 7 {
        6
    } else {
        ifd0.uint(tiff::TAG_PHOTOMETRIC).unwrap_or(2) as u16
    };
    for (lv, &(lw, lh)) in dims.iter().enumerate().skip(1) {
        let (cols, rows) = (lw.div_ceil(TILE), lh.div_ceil(TILE));
        let (mut offs, mut cnts) = (Vec::new(), Vec::new());
        for r in 0..rows {
            for c in 0..cols {
                let region = prev.read_rgba(
                    (c * TILE * 2) as i64,
                    (r * TILE * 2) as i64,
                    (TILE * 2) as u32,
                    (TILE * 2) as u32,
                    &cache,
                    lv - 1,
                )?;
                let (o, l) = w.write_chunk(&encode(reduce(&region, samples), comp, samples)?)?;
                offs.push(o);
                cnts.push(l);
            }
            tick(cols);
        }
        w.flush()?;
        let mut e = vec![
            Entry::long(254, &[1]),
            Entry::long(tiff::TAG_WIDTH, &[lw as u32]),
            Entry::long(tiff::TAG_LENGTH, &[lh as u32]),
            Entry::short(tiff::TAG_BITS, &vec![8; samples]),
            Entry::short(tiff::TAG_COMPRESSION, &[comp as u16]),
            Entry::short(tiff::TAG_PHOTOMETRIC, &[photometric]),
            Entry::short(tiff::TAG_SAMPLES, &[samples as u16]),
            Entry::short(tiff::TAG_PLANAR, &[1]),
            Entry::long(tiff::TAG_TILE_WIDTH, &[TILE as u32]),
            Entry::long(tiff::TAG_TILE_LENGTH, &[TILE as u32]),
            Entry::long8(tiff::TAG_TILE_OFFSETS, &offs),
            Entry::long8(tiff::TAG_TILE_COUNTS, &cnts),
        ];
        if samples == 4 {
            e.push(Entry::short(
                tiff::TAG_EXTRA_SAMPLES,
                &[if ifd0.uint(tiff::TAG_EXTRA_SAMPLES) == Some(1) {
                    1
                } else {
                    2
                }],
            ));
        }
        if comp == 7 {
            e.push(Entry::short(530, &[2, 1])); // the image crate writes 4:2:2
        }
        w.add_page(e);
        prev = Page::from_parts(&reader, lw, lh, TILE, comp, samples, offs, cnts);
    }
    w.finish()?;
    progress(1.0);
    Ok(dims.len())
}

/// `<stem>.<tag>.<ext>` next to `path`, numbered when it already exists.
fn side_name(path: &Path, tag: &str) -> PathBuf {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 1.. {
        let name = if n == 1 {
            tag.to_string()
        } else {
            format!("{tag}-{n}")
        };
        let p = path.with_file_name(format!("{stem}.{name}{ext}"));
        if !p.exists() {
            return p;
        }
    }
    unreachable!()
}

fn backup_name(path: &Path) -> PathBuf {
    side_name(path, "orig")
}

/// Repairs `path` in place: the original is kept as a backup and the repaired file takes its name.
pub fn repair_in_place(path: &str, progress: &dyn Fn(f32)) -> Result<Repaired> {
    let tmp = format!("{path}.repair-tmp");
    let levels = match rebuild_pyramid(path, &tmp, progress) {
        Ok(l) => l,
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            return Err(e);
        }
    };
    // the result must open cleanly with all of its levels and no remaining defect
    let ok = GenericTiff::open(&tmp)
        .map(|g| g.issues().is_empty() && g.level_dimensions().len() == levels)
        .unwrap_or(false);
    if !ok {
        let _ = std::fs::remove_file(&tmp);
        return err("the repaired file failed its consistency check; the original was not touched");
    }
    let backup = backup_name(Path::new(path));
    std::fs::rename(path, &backup)
        .map_err(|e| WsiError(format!("cannot keep the original: {e}")))?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::rename(&backup, path); // put the original back
        return Err(WsiError(format!("cannot install the repaired file: {e}")));
    }
    Ok(Repaired { backup, levels })
}

/// Puts a backup made by `repair_in_place` back; the repaired file is kept as `<stem>.repaired.<ext>`.
pub fn restore_backup(path: &str, backup: &str) -> Result<()> {
    let p = Path::new(path);
    let kept = side_name(p, "repaired");
    if !Path::new(backup).exists() {
        return err("the backup file is missing");
    }
    std::fs::rename(p, &kept).map_err(|e| WsiError(e.to_string()))?;
    std::fs::rename(backup, p).map_err(|e| {
        let _ = std::fs::rename(&kept, p);
        WsiError(e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Writes a tiled LZW RGB page of `img` into `w`.
    fn page(w: &mut TiffWriter, img: &image::RgbImage, subfile: u32) {
        let (iw, ih) = (img.width() as u64, img.height() as u64);
        let (mut offs, mut cnts) = (Vec::new(), Vec::new());
        for r in 0..ih.div_ceil(TILE) {
            for c in 0..iw.div_ceil(TILE) {
                let mut raw = vec![0u8; (TILE * TILE * 3) as usize];
                for y in 0..TILE {
                    for x in 0..TILE {
                        let (sx, sy) = (c * TILE + x, r * TILE + y);
                        if sx < iw && sy < ih {
                            let p = img.get_pixel(sx as u32, sy as u32);
                            let o = ((y * TILE + x) * 3) as usize;
                            raw[o..o + 3].copy_from_slice(&p.0);
                        }
                    }
                }
                let (o, l) = w.write_chunk(&encode(raw, 5, 3).unwrap()).unwrap();
                offs.push(o);
                cnts.push(l);
            }
        }
        w.add_page(vec![
            Entry::long(254, &[subfile]),
            Entry::long(tiff::TAG_WIDTH, &[iw as u32]),
            Entry::long(tiff::TAG_LENGTH, &[ih as u32]),
            Entry::short(tiff::TAG_BITS, &[8, 8, 8]),
            Entry::short(tiff::TAG_COMPRESSION, &[5]),
            Entry::short(tiff::TAG_PHOTOMETRIC, &[2]),
            Entry::short(tiff::TAG_SAMPLES, &[3]),
            Entry::short(tiff::TAG_PLANAR, &[1]),
            Entry::long(tiff::TAG_TILE_WIDTH, &[TILE as u32]),
            Entry::long(tiff::TAG_TILE_LENGTH, &[TILE as u32]),
            Entry::long8(tiff::TAG_TILE_OFFSETS, &offs),
            Entry::long8(tiff::TAG_TILE_COUNTS, &cnts),
        ]);
    }

    fn tissue(w: u32, h: u32) -> image::RgbImage {
        image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([200 + (x % 40) as u8 / 2, 150 + (y % 60) as u8 / 3, 190])
        })
    }

    #[test]
    fn rebuilds_a_pyramid_whose_lower_pages_are_grey_noise() {
        let dir = std::env::temp_dir().join(format!("exact_repair_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("damaged.tiff");
        let p = path.to_str().unwrap();
        let base = tissue(1300, 900);
        let grey = image::RgbImage::from_fn(650, 450, |x, y| {
            image::Rgb([120 + ((x * 7 + y * 3) % 9) as u8; 3])
        });
        let mut w = TiffWriter::create(p).unwrap();
        page(&mut w, &base, 0);
        page(&mut w, &grey, 1);
        w.finish().unwrap();

        let before = GenericTiff::open(p).unwrap();
        assert_eq!(before.issues(), vec!["damaged_pyramid".to_string()]);
        assert_eq!(before.level_dimensions().len(), 1);

        let progress = std::sync::Mutex::new(Vec::<f32>::new());
        let r = repair_in_place(p, &|v| progress.lock().unwrap().push(v)).unwrap();
        assert!(r.levels >= 3, "levels {}", r.levels);
        assert!(r.backup.exists(), "the original is kept");
        assert!(progress.lock().unwrap().last().copied().unwrap_or(0.0) >= 1.0);

        let after = GenericTiff::open(p).unwrap();
        assert!(after.issues().is_empty());
        assert_eq!(
            after.level_dimensions(),
            vec![(1300, 900), (650, 450), (325, 225)]
        );
        // level 0 is bit-identical, a lower level is a real reduction
        let l0 = after.read_region(0, 0, 0, 1300, 900, 0).unwrap();
        for (x, y) in [(0u32, 0u32), (777, 333), (1299, 899)] {
            assert_eq!(l0.get_pixel(x, y).0[..3], base.get_pixel(x, y).0);
        }
        let l1 = after.read_region(0, 0, 1, 650, 450, 0).unwrap();
        let px = l1.get_pixel(300, 200);
        assert!(px[0] > 190 && px[2] > 180, "{px:?}");

        // restore puts the original back
        restore_backup(p, r.backup.to_str().unwrap()).unwrap();
        assert_eq!(
            GenericTiff::open(p).unwrap().issues(),
            vec!["damaged_pyramid".to_string()]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
