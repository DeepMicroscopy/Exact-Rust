//! Port of `openslide.deepzoom.DeepZoomGenerator` as configured by EXACT (tile 254, overlap 1, limit_bounds).

use crate::{background, composite, err, Result, Slide};
use image::RgbImage;
use std::sync::Arc;

pub const TILE_SIZE: u64 = 254;
pub const OVERLAP: u64 = 1;

/// Presents one reformat plane of a volume to the generator (`PlaneSlideAdapter`): one level, the plane's size.
struct PlaneSlide {
    inner: Arc<dyn Slide>,
    plane: u32,
    dims: (u64, u64),
}

impl Slide for PlaneSlide {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        vec![self.dims]
    }
    fn level_downsamples(&self) -> Vec<f64> {
        vec![1.0]
    }
    fn best_level_for_downsample(&self, _d: f64) -> usize {
        0
    }
    fn properties(&self) -> std::collections::HashMap<String, String> {
        self.inner.properties()
    }
    fn read_region(
        &self,
        x: i64,
        y: i64,
        level: usize,
        w: u32,
        h: u32,
        frame: u32,
    ) -> Result<image::RgbaImage> {
        self.inner
            .read_region_plane(x, y, level, w, h, frame, self.plane)
    }
    fn frame_count(&self) -> u32 {
        self.inner.plane_frames(self.plane)
    }
}

pub struct DeepZoom {
    slide: Arc<dyn Slide>,
    l0_offset: (i64, i64),
    l_dims: Vec<(u64, u64)>,
    z_dims: Vec<(u64, u64)>,
    t_dims: Vec<(u64, u64)>,
    slide_from_dz: Vec<usize>,
    l0_l_down: Vec<f64>,
    offsets: Vec<(f64, f64)>,
    bg: [u8; 3],
}

fn ceil_div2(v: u64) -> u64 {
    v.div_ceil(2).max(1)
}

impl DeepZoom {
    /// Generator for one plane of a volume; planes the reader does not have fall back to the axial view.
    pub fn for_plane(slide: Arc<dyn Slide>, plane: u32) -> Self {
        Self::build(slide, plane, Vec::new())
    }

    /// Generator for one plane with measured level registration offsets (pixels of each slide level, see
    /// `registration`). The offsets of level 0 are ignored: the full-resolution level is the reference and is never shifted.
    pub fn build(slide: Arc<dyn Slide>, plane: u32, offsets: Vec<(f64, f64)>) -> Self {
        let mut dz = match slide.plane_dimensions(plane) {
            Some(dims) if plane > 0 => Self::new(Arc::new(PlaneSlide {
                inner: slide,
                plane,
                dims,
            })),
            _ => Self::new(slide),
        };
        dz.offsets = offsets;
        if let Some(first) = dz.offsets.first_mut() {
            *first = (0.0, 0.0);
        }
        dz
    }

    pub fn new(slide: Arc<dyn Slide>) -> Self {
        let props = slide.properties();
        let level_dims = slide.level_dimensions();
        // EXACT builds the generator with openslide-python's default `limit_bounds=False`
        let l0_offset = (0, 0);
        let l_dims: Vec<(u64, u64)> = level_dims.clone();
        let mut z = l_dims[0];
        let mut z_dims = vec![z];
        while z.0 > 1 || z.1 > 1 {
            z = (ceil_div2(z.0), ceil_div2(z.1));
            z_dims.push(z);
        }
        z_dims.reverse();
        let t_dims = z_dims
            .iter()
            .map(|&(w, h)| (w.div_ceil(TILE_SIZE), h.div_ceil(TILE_SIZE)))
            .collect();
        let n = z_dims.len();
        let l0_z: Vec<f64> = (0..n).map(|i| 2f64.powi((n - i - 1) as i32)).collect();
        let slide_from_dz: Vec<usize> = l0_z
            .iter()
            .map(|&d| slide.best_level_for_downsample(d))
            .collect();
        let l0_l_down = slide.level_downsamples();
        let bg = background(&props);
        Self {
            slide,
            l0_offset,
            l_dims,
            z_dims,
            t_dims,
            slide_from_dz,
            l0_l_down,
            offsets: Vec::new(),
            bg,
        }
    }

    pub fn slide(&self) -> &Arc<dyn Slide> {
        &self.slide
    }

    pub fn level_tiles(&self) -> &[(u64, u64)] {
        &self.t_dims
    }

    pub fn level_dimensions(&self) -> &[(u64, u64)] {
        &self.z_dims
    }

    pub fn dzi(&self, format: &str) -> String {
        let (w, h) = self.z_dims[self.z_dims.len() - 1];
        format!(
            "<Image TileSize=\"{TILE_SIZE}\" Overlap=\"{OVERLAP}\" Format=\"{format}\" xmlns=\"http://schemas.microsoft.com/deepzoom/2008\"><Size Width=\"{w}\" Height=\"{h}\" /></Image>"
        )
    }

    /// One tile as RGB, exactly `z_size` pixels.
    ///
    /// The tile covers a rectangle of the DeepZoom level; its source in the slide level is computed in floating point
    /// from the true scale between the two (`level width / slide level width`, not a power of two: DeepZoom level
    /// sizes are rounded up) and resampled with a fractional crop box. Sampling every tile with the same scale keeps
    /// neighbouring zoom levels registered; resizing an integer-cropped region to the tile size instead shifted the
    /// content by up to a pixel between levels (visible as wobbling while tiles of two levels are blended).
    pub fn tile(&self, dz: usize, (tc, tr): (u64, u64), frame: u32) -> Result<RgbImage> {
        if dz >= self.z_dims.len() || tc >= self.t_dims[dz].0 || tr >= self.t_dims[dz].1 {
            return err("Invalid address");
        }
        let level = self.slide_from_dz[dz];
        let (tx, ty) = self.t_dims[dz];
        let (zw, zh) = self.z_dims[dz];
        let (lw, lh) = self.l_dims[level];
        // Level pixel size is `down` level-0 pixels, so the level covers `level-0 width / down` pixels of extent (not
        // necessarily its stored width: levels made by rounding-down decimation cover slightly less than the full slide).
        let down = self.l0_l_down[level];
        // OpenSeadragon places a DeepZoom level `e` steps below the full size as a grid of exactly 2^e level-0 pixels per
        // pixel (it does not know the rounded-up sizes of the levels), so that is what the pixels of the tile have to
        // show; sampling by `level size / slide size` instead drifts by up to a pixel towards the far edge of a level and
        // makes neighbouring zoom levels slide against each other while they are blended.
        let e = (self.z_dims.len() - 1 - dz) as i32;
        let (sx, sy) = (down / 2f64.powi(e), down / 2f64.powi(e));
        let ov = |t: u64| if t != 0 { OVERLAP } else { 0 };
        let ov_end = |t: u64, n: u64| if t != n - 1 { OVERLAP } else { 0 };
        let z_size = (
            TILE_SIZE.min(zw - TILE_SIZE * tc) + ov(tc) + ov_end(tc, tx),
            TILE_SIZE.min(zh - TILE_SIZE * tr) + ov(tr) + ov_end(tr, ty),
        );
        // tile rectangle in DeepZoom pixels -> slide level pixels
        let (ox, oy) = if level == 0 {
            (0.0, 0.0)
        } else {
            self.offsets.get(level).copied().unwrap_or((0.0, 0.0))
        };
        let (fx, fy) = (
            (((TILE_SIZE * tc - ov(tc)) as f64) / sx + ox).max(0.0),
            (((TILE_SIZE * tr - ov(tr)) as f64) / sy + oy).max(0.0),
        );
        let (fw, fh) = (z_size.0 as f64 / sx, z_size.1 as f64 / sy);
        let (ix, iy) = (fx.floor().max(0.0) as i64, fy.floor().max(0.0) as i64);
        let (ex, ey) = (
            ((fx + fw).ceil() as i64).min(lw as i64),
            ((fy + fh).ceil() as i64).min(lh as i64),
        );
        let (rw, rh) = ((ex - ix).max(1) as u32, (ey - iy).max(1) as u32);
        let l0 = (
            (down * ix as f64) as i64 + self.l0_offset.0,
            (down * iy as f64) as i64 + self.l0_offset.1,
        );
        let raw = self.slide.read_region(l0.0, l0.1, level, rw, rh, frame)?;
        let mut rgb = composite(&raw, self.bg);
        // A tile at the far edge of a level reaches past the last row / column of the slide (levels are rounded up). The part
        // outside is background; shrinking the source box instead would stretch the tile and shift its content.
        let full = (
            ((fx + fw).ceil() as i64 - ix).max(1) as u32,
            ((fy + fh).ceil() as i64 - iy).max(1) as u32,
        );
        if rgb.width() < full.0 || rgb.height() < full.1 {
            let mut canvas = RgbImage::from_pixel(
                full.0.max(rgb.width()),
                full.1.max(rgb.height()),
                image::Rgb(self.bg),
            );
            image::imageops::replace(&mut canvas, &rgb, 0, 0);
            rgb = canvas;
        }
        let (rw, rh) = (rgb.width(), rgb.height());
        let exact = (rw as u64, rh as u64) == z_size
            && (fx - ix as f64).abs() < 1e-6
            && (fy - iy as f64).abs() < 1e-6;
        if exact {
            return Ok(rgb);
        }
        resample(
            rgb,
            (fx - ix as f64, fy - iy as f64, fw, fh),
            (z_size.0 as u32, z_size.1 as u32),
        )
    }
}

/// Lanczos resampling of the fractional rectangle `(left, top, width, height)` of `img` to `size`.
fn resample(
    img: RgbImage,
    (left, top, w, h): (f64, f64, f64, f64),
    size: (u32, u32),
) -> Result<RgbImage> {
    use fast_image_resize::{
        images::Image, FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer,
    };
    let fail = |e: &dyn std::fmt::Display| crate::WsiError(format!("resize: {e}"));
    let (iw, ih) = (img.width(), img.height());
    let src = Image::from_vec_u8(iw, ih, img.into_raw(), PixelType::U8x3).map_err(|e| fail(&e))?;
    let mut dst = Image::new(size.0, size.1, PixelType::U8x3);
    // keep the crop inside the source (floating point error at the far edge)
    let (w, h) = (
        w.min(iw as f64 - left).max(1e-3),
        h.min(ih as f64 - top).max(1e-3),
    );
    let opts = ResizeOptions::new()
        .resize_alg(ResizeAlg::Convolution(FilterType::Lanczos3))
        .crop(left.max(0.0), top.max(0.0), w, h);
    Resizer::new()
        .resize(&src, &mut dst, &opts)
        .map_err(|e| fail(&e))?;
    RgbImage::from_raw(size.0, size.1, dst.into_vec()).ok_or_else(|| fail(&"bad buffer"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texture(w: u32, h: u32) -> RgbImage {
        let mut seed = 99u32;
        let mut n = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 24) as f32
        };
        let blobs: Vec<(f32, f32, f32, f32)> = (0..60)
            .map(|_| {
                (
                    n() / 255.0 * w as f32,
                    n() / 255.0 * h as f32,
                    2.0 + n() / 16.0,
                    n() - 128.0,
                )
            })
            .collect();
        RgbImage::from_fn(w, h, |x, y| {
            let mut v = 128.0f32;
            for (cx, cy, s, a) in &blobs {
                v += a
                    * (-(((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)) / (2.0 * s * s)))
                        .exp();
            }
            let v = v.clamp(0.0, 255.0) as u8;
            image::Rgb([v, v, v])
        })
    }

    /// Sub-pixel `(dx, dy)` with `b(x + dx, y + dy) ~ a(x, y)` by integer SSD search and parabolic refinement.
    fn shift(a: &RgbImage, b: &RgbImage) -> (f64, f64) {
        let (w, h) = (a.width() as i32, a.height() as i32);
        let ssd = |dx: i32, dy: i32| -> f64 {
            let mut s = 0.0;
            for y in 8..h - 8 {
                for x in 8..w - 8 {
                    let d = a.get_pixel(x as u32, y as u32)[0] as f64
                        - b.get_pixel((x + dx) as u32, (y + dy) as u32)[0] as f64;
                    s += d * d;
                }
            }
            s
        };
        let mut best = (0, 0, f64::INFINITY);
        for dy in -3..=3 {
            for dx in -3..=3 {
                let s = ssd(dx, dy);
                if s < best.2 {
                    best = (dx, dy, s);
                }
            }
        }
        let refine = |l: f64, m: f64, r: f64| 0.5 * (l - r) / (l - 2.0 * m + r);
        (
            best.0 as f64 + refine(ssd(best.0 - 1, best.1), best.2, ssd(best.0 + 1, best.1)),
            best.1 as f64 + refine(ssd(best.0, best.1 - 1), best.2, ssd(best.0, best.1 + 1)),
        )
    }

    /// Two-level pyramid for the registration tests: level 1 is level 0 halved.
    struct TwoLevels(image::RgbaImage, image::RgbaImage);

    impl Slide for TwoLevels {
        fn level_dimensions(&self) -> Vec<(u64, u64)> {
            vec![
                (self.0.width() as u64, self.0.height() as u64),
                (self.1.width() as u64, self.1.height() as u64),
            ]
        }
        fn level_downsamples(&self) -> Vec<f64> {
            vec![1.0, 2.0]
        }
        fn best_level_for_downsample(&self, d: f64) -> usize {
            usize::from(d >= 2.0)
        }
        fn properties(&self) -> std::collections::HashMap<String, String> {
            Default::default()
        }
        fn read_region(
            &self,
            x: i64,
            y: i64,
            level: usize,
            w: u32,
            h: u32,
            _f: u32,
        ) -> Result<image::RgbaImage> {
            let (src, ds) = if level == 0 {
                (&self.0, 1)
            } else {
                (&self.1, 2)
            };
            Ok(crate::formats::crop_transparent(src, x / ds, y / ds, w, h))
        }
    }

    fn two_levels() -> Arc<dyn Slide> {
        let l0 = image::DynamicImage::ImageRgb8(texture(1200, 900)).to_rgba8();
        let l1 = image::imageops::resize(&l0, 600, 450, image::imageops::FilterType::Triangle);
        Arc::new(TwoLevels(l0, l1))
    }

    #[test]
    fn level_zero_is_never_shifted_by_registration_offsets() {
        let slide = two_levels();
        let plain = DeepZoom::for_plane(slide.clone(), 0);
        // an absurd offset for level 0 and a real one for level 1
        let shifted = DeepZoom::build(slide.clone(), 0, vec![(7.0, -5.0), (0.6, 0.3)]);
        let top = plain.level_dimensions().len() - 1; // DeepZoom level of the full resolution
        for (c, r) in [(0, 0), (1, 1), (4, 3)] {
            assert_eq!(
                plain.tile(top, (c, r), 0).unwrap().into_raw(),
                shifted.tile(top, (c, r), 0).unwrap().into_raw(),
                "tile {c},{r} of level 0 changed"
            );
        }
        // level 1 does use its offset
        assert_ne!(
            plain.tile(top - 1, (0, 0), 0).unwrap().into_raw(),
            shifted.tile(top - 1, (0, 0), 0).unwrap().into_raw()
        );
    }

    #[test]
    fn a_fractional_crop_near_scale_one_shifts_by_exactly_the_offset() {
        let src = texture(300, 300);
        // output pixel i = source pixel i + 0.75 (crop box starting at 0.75, same scale)
        let out = resample(src.clone(), (0.75, 0.5, 280.0, 280.0), (280, 280)).unwrap();
        let (dx, dy) = shift(&out, &src);
        // out(x) = src(x + 0.75)  =>  src(x + dx) ~ out(x) needs dx = +0.75
        assert!(
            (dx - 0.75).abs() < 0.1 && (dy - 0.5).abs() < 0.1,
            "got ({dx}, {dy}), expected (0.75, 0.5)"
        );
    }
    /// A single-level slide with one bright dot.
    struct Dot {
        w: u32,
        h: u32,
        at: (f64, f64),
    }
    impl Slide for Dot {
        fn level_dimensions(&self) -> Vec<(u64, u64)> {
            vec![(self.w as u64, self.h as u64)]
        }
        fn level_downsamples(&self) -> Vec<f64> {
            vec![1.0]
        }
        fn best_level_for_downsample(&self, _d: f64) -> usize {
            0
        }
        fn properties(&self) -> std::collections::HashMap<String, String> {
            // black background: the part of an edge tile outside the slide must not weigh in the centroid
            std::collections::HashMap::from([(
                "openslide.background-color".to_string(),
                "000000".to_string(),
            )])
        }
        fn read_region(
            &self,
            x: i64,
            y: i64,
            _l: usize,
            w: u32,
            h: u32,
            _f: u32,
        ) -> Result<image::RgbaImage> {
            Ok(image::RgbaImage::from_fn(w, h, |i, j| {
                let d2 = (x as f64 + i as f64 + 0.5 - self.at.0).powi(2)
                    + (y as f64 + j as f64 + 0.5 - self.at.1).powi(2);
                let v = (255.0 * (-d2 / (2.0 * 2.5f64.powi(2))).exp()) as u8;
                image::Rgba([v, v, v, 255])
            }))
        }
    }

    /// OpenSeadragon draws a DeepZoom level `e` steps below the full size as 2^e level-0 pixels per pixel. A dot in the far
    /// corner of an image whose size is not a multiple of 2^e must therefore sit at `position / 2^e` on every level; sampling by
    /// `level size / image size` (sizes are rounded up) moved it by up to a pixel and made neighbouring levels slide against each other.
    #[test]
    fn zoom_levels_keep_their_content_where_the_viewer_places_them() {
        let (w, h) = (4003u32, 3001u32);
        let at = (3500.5, 2500.5);
        let dz = DeepZoom::build(std::sync::Arc::new(Dot { w, h, at }), 0, vec![]);
        let n = dz.z_dims.len();
        for e in 0..=5usize {
            let level = n - 1 - e;
            let (zw, zh) = dz.z_dims[level];
            let want = (at.0 / 2f64.powi(e as i32), at.1 / 2f64.powi(e as i32));
            let (tc, tr) = ((want.0 as u64) / 254, (want.1 as u64) / 254);
            let tile = dz.tile(level, (tc, tr), 0).unwrap();
            // centroid of the dot in level pixels (tile origin: column tc * 254, minus the overlap of one pixel on the inner side)
            let (ox, oy) = (
                (tc * 254) as f64 - if tc > 0 { 1.0 } else { 0.0 },
                (tr * 254) as f64 - if tr > 0 { 1.0 } else { 0.0 },
            );
            let (mut sx, mut sy, mut sw) = (0.0, 0.0, 0.0);
            for (x, y, p) in tile.enumerate_pixels() {
                let v = p[0] as f64;
                sx += v * (ox + x as f64 + 0.5);
                sy += v * (oy + y as f64 + 0.5);
                sw += v;
            }
            let got = (sx / sw, sy / sw);
            assert!(
                (got.0 - want.0).abs() < 0.25 && (got.1 - want.1).abs() < 0.25,
                "level {level} ({zw}x{zh}): dot at ({:.2}, {:.2}), expected ({:.2}, {:.2})",
                got.0,
                got.1,
                want.0,
                want.1
            );
        }
    }
}
