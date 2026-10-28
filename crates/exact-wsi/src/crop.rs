//! Crop of a region of a slide into a new pyramidal TIFF (JPEG, 256 px tiles, BigTIFF), as EXACT's "crop to new image".
//!
//! The region is read in bands of one tile row, so memory stays flat however large the crop is; the lower levels are
//! built from level 0 tile by tile like the pyramid repair does.

use crate::{
    err,
    repair::{encode, reduce, JPEG_SUBSAMPLING, TILE},
    tiff::{self, ChunkCache, Page, Tiff},
    tiff_write::{Entry, TiffWriter},
    Result, Slide,
};
use image::RgbaImage;

const JPEG: u64 = 7;

/// Writes the region `(x, y, w, h)` of level 0 (frame `frame`) of `slide` to `dst`. `mpp` (µm per pixel, 0 = unknown) is
/// stored as the resolution of the file. Returns the number of pyramid levels. `progress` receives values in 0..1.
pub fn crop_to_pyramid(
    slide: &dyn Slide,
    (x, y, w, h): (i64, i64, u32, u32),
    frame: u32,
    mpp: f64,
    dst: &str,
    progress: &dyn Fn(f32),
) -> Result<usize> {
    let (sw, sh) = *slide
        .level_dimensions()
        .first()
        .ok_or_else(|| crate::WsiError("slide without levels".into()))?;
    if w == 0 || h == 0 || x < 0 || y < 0 || x + w as i64 > sw as i64 || y + h as i64 > sh as i64 {
        return err(format!(
            "the region {w}x{h} at ({x}, {y}) is not inside the image ({sw}x{sh})"
        ));
    }
    let mut dims = vec![(w as u64, h as u64)];
    while dims.last().is_some_and(|d| d.0 > 512 || d.1 > 512) {
        let d = dims.last().copied().unwrap_or((1, 1));
        dims.push((d.0.div_ceil(2), d.1.div_ceil(2)));
    }
    let tiles = |d: (u64, u64)| d.0.div_ceil(TILE) * d.1.div_ceil(TILE);
    let total: u64 = dims.iter().map(|d| tiles(*d)).sum();
    let mut done = 0u64;
    let mut tick = |n: u64| {
        done += n;
        progress((done as f32 / total as f32).min(1.0));
    };

    let mut out = TiffWriter::create(dst)?;
    // level 0, one band of tile row height at a time
    let (cols, rows) = ((w as u64).div_ceil(TILE), (h as u64).div_ceil(TILE));
    let (mut offs, mut cnts) = (Vec::new(), Vec::new());
    for r in 0..rows {
        let band_h = (h as u64 - r * TILE).min(TILE) as u32;
        let band = slide.read_region(x, y + (r * TILE) as i64, 0, w, band_h, frame)?;
        for c in 0..cols {
            let tile = rgb_tile(&band, (c * TILE) as u32, band_h);
            let (o, l) = out.write_chunk(&encode(tile, JPEG, 3)?)?;
            offs.push(o);
            cnts.push(l);
        }
        tick(cols);
    }
    out.flush()?;
    let mut page = vec![
        Entry::long(254, &[0]),
        Entry::long(tiff::TAG_WIDTH, &[w]),
        Entry::long(tiff::TAG_LENGTH, &[h]),
        Entry::short(tiff::TAG_BITS, &[8, 8, 8]),
        Entry::short(tiff::TAG_COMPRESSION, &[JPEG as u16]),
        Entry::short(tiff::TAG_PHOTOMETRIC, &[6]),
        Entry::short(tiff::TAG_SAMPLES, &[3]),
        Entry::short(tiff::TAG_PLANAR, &[1]),
        Entry::long(tiff::TAG_TILE_WIDTH, &[TILE as u32]),
        Entry::long(tiff::TAG_TILE_LENGTH, &[TILE as u32]),
        Entry::long8(tiff::TAG_TILE_OFFSETS, &offs),
        Entry::long8(tiff::TAG_TILE_COUNTS, &cnts),
        Entry::short(530, &JPEG_SUBSAMPLING),
    ];
    if mpp > 0.0 {
        // pixels per centimetre as a rational
        let per_cm = (10_000.0 / mpp * 1000.0).round() as u32;
        let mut rat = per_cm.to_le_bytes().to_vec();
        rat.extend(1000u32.to_le_bytes());
        page.push(Entry::raw(tiff::TAG_X_RESOLUTION, 5, rat.clone()));
        page.push(Entry::raw(283, 5, rat));
        page.push(Entry::short(tiff::TAG_RESOLUTION_UNIT, &[3]));
    }
    out.add_page(page);

    // lower levels, each read back from the level below as it was written
    let reader = Tiff::open(dst)?;
    let cache = ChunkCache::new(256);
    let mut prev = Page::from_parts(&reader, w as u64, h as u64, TILE, JPEG, 3, offs, cnts);
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
                let (o, l) = out.write_chunk(&encode(reduce(&region, 3), JPEG, 3)?)?;
                offs.push(o);
                cnts.push(l);
            }
            tick(cols);
        }
        out.flush()?;
        out.add_page(vec![
            Entry::long(254, &[1]),
            Entry::long(tiff::TAG_WIDTH, &[lw as u32]),
            Entry::long(tiff::TAG_LENGTH, &[lh as u32]),
            Entry::short(tiff::TAG_BITS, &[8, 8, 8]),
            Entry::short(tiff::TAG_COMPRESSION, &[JPEG as u16]),
            Entry::short(tiff::TAG_PHOTOMETRIC, &[6]),
            Entry::short(tiff::TAG_SAMPLES, &[3]),
            Entry::short(tiff::TAG_PLANAR, &[1]),
            Entry::long(tiff::TAG_TILE_WIDTH, &[TILE as u32]),
            Entry::long(tiff::TAG_TILE_LENGTH, &[TILE as u32]),
            Entry::long8(tiff::TAG_TILE_OFFSETS, &offs),
            Entry::long8(tiff::TAG_TILE_COUNTS, &cnts),
            Entry::short(530, &JPEG_SUBSAMPLING),
        ]);
        prev = Page::from_parts(&reader, lw, lh, TILE, JPEG, 3, offs, cnts);
    }
    out.finish()?;
    progress(1.0);
    Ok(dims.len())
}

/// 256x256 RGB tile starting at column `x0` of a band of `band_h` rows; what lies outside the band stays black.
fn rgb_tile(band: &RgbaImage, x0: u32, band_h: u32) -> Vec<u8> {
    let t = TILE as usize;
    let mut out = vec![0u8; t * t * 3];
    for ty in 0..band_h.min(TILE as u32) {
        for tx in 0..TILE as u32 {
            let sx = x0 + tx;
            if sx >= band.width() {
                break;
            }
            let p = band.get_pixel(sx, ty);
            let o = (ty as usize * t + tx as usize) * 3;
            out[o..o + 3].copy_from_slice(&p.0[..3]);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::WsiError;
    use std::collections::HashMap;

    /// A slide whose pixel (x, y) has a colour that tells where it is.
    struct Gradient(u64, u64);
    impl Slide for Gradient {
        fn level_dimensions(&self) -> Vec<(u64, u64)> {
            vec![(self.0, self.1)]
        }
        fn level_downsamples(&self) -> Vec<f64> {
            vec![1.0]
        }
        fn best_level_for_downsample(&self, _: f64) -> usize {
            0
        }
        fn properties(&self) -> HashMap<String, String> {
            HashMap::new()
        }
        fn read_region(
            &self,
            x: i64,
            y: i64,
            _level: usize,
            w: u32,
            h: u32,
            _frame: u32,
        ) -> Result<RgbaImage> {
            if x < 0 || y < 0 {
                return Err(WsiError("negative".into()));
            }
            Ok(RgbaImage::from_fn(w, h, |i, j| {
                let (gx, gy) = (x as u64 + i as u64, y as u64 + j as u64);
                image::Rgba([
                    (gx % 251) as u8,
                    (gy % 241) as u8,
                    ((gx + gy) / 8 % 256) as u8,
                    255,
                ])
            }))
        }
    }

    #[test]
    fn a_crop_is_a_pyramid_that_shows_the_region() {
        let dir = std::env::temp_dir().join(format!("exact-crop-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dst = dir.join("crop.tiff");
        let src = Gradient(3000, 2000);
        let levels = crop_to_pyramid(
            &src,
            (1000, 700, 1300, 900),
            0,
            0.5,
            dst.to_str().unwrap(),
            &|_| {},
        )
        .unwrap();
        assert!(levels >= 2);
        // read the file back with the crate's own TIFF reader: it must not depend on OpenSlide being installed
        let t = Tiff::open(dst.to_str().unwrap()).unwrap();
        let mut pages = Vec::new();
        let mut off = t.first_ifd_offset().unwrap();
        while off != 0 {
            let ifd = t.read_ifd(off).unwrap();
            pages.push(Page::new(&t, &ifd).unwrap());
            off = ifd.next;
        }
        assert_eq!((pages[0].width, pages[0].height), (1300, 900));
        assert_eq!(pages.len(), levels);
        // level 0 equals the region of the source (JPEG, so within a tolerance)
        let cache = ChunkCache::new(64);
        let got = pages[0].read_rgba(300, 200, 64, 64, &cache, 0).unwrap();
        let want = src.read_region(1300, 900, 0, 64, 64, 0).unwrap();
        let diff: u64 = got
            .pixels()
            .zip(want.pixels())
            .map(|(a, b)| {
                (0..3)
                    .map(|c| (a[c] as i64 - b[c] as i64).unsigned_abs())
                    .sum::<u64>()
            })
            .sum();
        assert!(
            diff / (64 * 64 * 3) < 6,
            "mean difference {}",
            diff / (64 * 64 * 3)
        );
        // a region outside the image is refused
        assert!(crop_to_pyramid(
            &src,
            (2900, 1900, 300, 300),
            0,
            0.0,
            dst.to_str().unwrap(),
            &|_| {}
        )
        .is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
