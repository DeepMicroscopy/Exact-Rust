//! Generic pyramidal TIFF (levels as consecutive tiled pages, as written by libvips, tiffcp, ImageMagick, ...),
//! read natively. libopenslide's generic-tiff driver returned nondeterministic pixels for the lower levels of such
//! files in the reference environment (libopenslide 4.0), so these files no longer go through it.

use crate::{
    err,
    tiff::{self, Page, Tiff},
    Result, Slide, WsiError,
};
use image::RgbaImage;
use std::collections::HashMap;

pub struct GenericTiff {
    levels: Vec<Page>,
    dims: Vec<(u64, u64)>,
    downs: Vec<f64>,
    props: HashMap<String, String>,
    cache: tiff::ChunkCache,
    damaged: bool,
}

impl GenericTiff {
    pub fn open(path: &str) -> Result<Self> {
        let t = Tiff::open(path)?;
        let mut off = t.first_ifd_offset()?;
        let mut levels: Vec<Page> = Vec::new();
        let mut first_ifd = None;
        while off != 0 {
            let ifd = t.read_ifd(off)?;
            off = ifd.next;
            if first_ifd.is_none() {
                first_ifd = Some(ifd.clone());
            }
            // a level is a tiled page that is smaller than the previous one; everything else (labels, ...) is skipped
            if !ifd.has(tiff::TAG_TILE_OFFSETS) {
                if levels.is_empty() {
                    return err("first page is not tiled");
                }
                continue;
            }
            let page = Page::new(&t, &ifd)?;
            if let Some(prev) = levels.last() {
                if page.width >= prev.width || page.height >= prev.height {
                    continue;
                }
            }
            levels.push(page);
        }
        let first = first_ifd.ok_or_else(|| WsiError("empty TIFF".into()))?;
        let cache = tiff::ChunkCache::new(512);
        let level_count = levels.len();
        drop_inconsistent_levels(&mut levels, &cache);
        let damaged = levels.len() < level_count;
        let dims: Vec<(u64, u64)> = levels.iter().map(|p| (p.width, p.height)).collect();
        let (w0, h0) = (dims[0].0 as f64, dims[0].1 as f64);
        // OpenSlide: average of the two axis ratios
        let downs = dims
            .iter()
            .map(|d| (w0 / d.0 as f64 + h0 / d.1 as f64) / 2.0)
            .collect();
        // resolution -> microns per pixel
        let mpp = first
            .rational(tiff::TAG_X_RESOLUTION)
            .filter(|r| *r > 0.0)
            .and_then(|r| match first.uint(tiff::TAG_RESOLUTION_UNIT) {
                Some(3) => Some(10_000.0 / r),
                Some(2) => Some(25_400.0 / r),
                _ => None,
            });
        let mut props =
            HashMap::from([("openslide.vendor".to_string(), "generic-tiff".to_string())]);
        if let Some(m) = mpp {
            props.insert("openslide.mpp-x".into(), m.to_string());
            props.insert("openslide.mpp-y".into(), m.to_string());
        }
        Ok(Self {
            levels,
            dims,
            downs,
            props,
            cache,
            damaged,
        })
    }
}

/// Mean RGB of the centered window covering `frac` of the page in each direction.
fn center_mean(page: &Page, cache: &tiff::ChunkCache, id: usize, frac: f64) -> Option<[f64; 3]> {
    let (w, h) = (
        ((page.width as f64 * frac) as u64).max(1),
        ((page.height as f64 * frac) as u64).max(1),
    );
    let (x, y) = ((page.width - w) / 2, (page.height - h) / 2);
    let img = page
        .read_rgba(x as i64, y as i64, w as u32, h as u32, cache, id)
        .ok()?;
    let mut s = [0f64; 3];
    for p in img.pixels() {
        for (c, v) in s.iter_mut().enumerate() {
            *v += p[c] as f64;
        }
    }
    let n = (img.width() * img.height()) as f64;
    Some(s.map(|v| v / n))
}

/// Some files carry pyramid pages that are not downscaled copies of the first page (seen: a TCGA tile whose lower pages
/// are grey noise). Such levels make zoomed-out views and thumbnails wrong, so a level whose central window differs in
/// colour from level 0's is dropped together with all smaller ones; DeepZoom then derives those zoom levels from the
/// pages that remain. The window is the same fraction of every page (at most ~1000 px at level 0), so it is cheap.
fn drop_inconsistent_levels(levels: &mut Vec<Page>, cache: &tiff::ChunkCache) {
    const MAX_MEAN_DIFF: f64 = 20.0; // 0..255 per channel
    let Some(base) = levels.first() else { return };
    let frac = (1.0f64 / 3.0)
        .min(1000.0 / base.width as f64)
        .min(1000.0 / base.height as f64);
    let Some(reference) = center_mean(base, cache, 0, frac) else {
        return;
    };
    let keep = (1..levels.len())
        .find(|&i| match center_mean(&levels[i], cache, i, frac) {
            Some(m) => m
                .iter()
                .zip(reference)
                .any(|(a, b)| (a - b).abs() > MAX_MEAN_DIFF),
            None => true,
        })
        .unwrap_or(levels.len());
    if keep < levels.len() {
        tracing::warn!("TIFF pyramid level {keep} does not match level 0; using {keep} level(s)");
        levels.truncate(keep);
    }
}

impl Slide for GenericTiff {
    /// The pyramids of these files come from many generators (Bio-Formats, vips, ImageMagick, ...); several shift the lower
    /// levels by a fraction of a pixel, which shows as wobble when zooming. The shift is measured once and corrected.
    fn needs_registration(&self) -> bool {
        true
    }
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        self.dims.clone()
    }
    fn level_downsamples(&self) -> Vec<f64> {
        self.downs.clone()
    }
    /// OpenSlide: the level with the largest downsample that does not exceed the requested one
    fn best_level_for_downsample(&self, d: f64) -> usize {
        if d < self.downs[0] {
            return 0;
        }
        for (i, v) in self.downs.iter().enumerate().skip(1) {
            if d < *v {
                return i - 1;
            }
        }
        self.downs.len() - 1
    }
    fn properties(&self) -> HashMap<String, String> {
        self.props.clone()
    }
    fn issues(&self) -> Vec<String> {
        if self.damaged {
            vec!["damaged_pyramid".into()]
        } else {
            Vec::new()
        }
    }
    fn read_region(
        &self,
        x: i64,
        y: i64,
        level: usize,
        w: u32,
        h: u32,
        _frame: u32,
    ) -> Result<RgbaImage> {
        let page = self
            .levels
            .get(level)
            .ok_or_else(|| WsiError("Invalid level".into()))?;
        let ds = self.downs[level];
        // location is in level-0 pixels
        let (lx, ly) = (
            (x as f64 / ds).floor() as i64,
            (y as f64 / ds).floor() as i64,
        );
        page.read_rgba(lx, ly, w, h, &self.cache, level)
    }
}
