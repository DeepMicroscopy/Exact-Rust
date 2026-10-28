//! Estimates how far the pyramid levels of a slide are displaced against each other.
//!
//! Some scanner formats store levels that are shifted by a fraction of a pixel relative to the level below (seen: a Zeiss
//! CZI read through slideio, 0.2-0.8 px between neighbouring levels at every position). Tiles of two zoom levels are
//! blended while the viewer loads or zooms, so such a shift shows as wobbling. The offsets are measured once per slide
//! on up to three textured spots (each level against the previous one, chained to level 0), combined (the two closest spots),
//! applied when tiles are sampled. A level is corrected only when at least two spots agree. Each level is compared with the
//! level below reduced by a box filter: an integer search, then a gradient-based refinement for the fractional part.

use crate::Slide;

const WIN: usize = 384; // window side in pixels of the level under test
const MARGIN: usize = 8;
const MAX_SHIFT: i32 = 3;
/// the two closest spots must agree within this (px), otherwise the level is not corrected
const MAX_SPREAD: f64 = 0.15;
/// smaller offsets are measurement noise
const MIN_OFFSET: f64 = 0.04;

/// Version of the estimation; stored with the result, rows of other versions are measured again.
pub const ALGORITHM: i16 = 3;

fn gray(img: &image::RgbaImage) -> Vec<f32> {
    img.pixels()
        .map(|p| {
            (p[0] as f32 * 0.299 + p[1] as f32 * 0.587 + p[2] as f32 * 0.114)
                * (p[3] as f32 / 255.0)
        })
        .collect()
}

fn std_dev(v: &[f32]) -> f32 {
    let n = v.len().max(1) as f32;
    let m = v.iter().sum::<f32>() / n;
    (v.iter().map(|x| (x - m) * (x - m)).sum::<f32>() / n).sqrt()
}

/// Reduces `src` (w x h) by the integer factor `r` with a box filter.
fn reduce(src: &[f32], w: usize, h: usize, r: usize) -> (Vec<f32>, usize, usize) {
    let (ow, oh) = (w / r, h / r);
    let mut out = vec![0f32; ow * oh];
    for y in 0..oh {
        for x in 0..ow {
            let mut s = 0.0;
            for dy in 0..r {
                for dx in 0..r {
                    s += src[(y * r + dy) * w + x * r + dx];
                }
            }
            out[y * ow + x] = s / (r * r) as f32;
        }
    }
    (out, ow, oh)
}

/// Integer-shift SSD search with parabolic sub-pixel refinement: the `(dx, dy)` for which `lvl(x + dx, y + dy) ~ reference(x, y)`.
fn best_shift(lvl: &[f32], reference: &[f32], w: usize, h: usize) -> Option<(f64, f64)> {
    let ssd = |dx: i32, dy: i32| -> f64 {
        let mut s = 0.0f64;
        for y in MARGIN..h - MARGIN {
            let ly = (y as i32 + dy) as usize;
            for x in MARGIN..w - MARGIN {
                let lx = (x as i32 + dx) as usize;
                let d = lvl[ly * w + lx] - reference[y * w + x];
                s += (d * d) as f64;
            }
        }
        s
    };
    let n = (2 * MAX_SHIFT + 1) as usize;
    let mut grid = vec![0f64; n * n];
    let mut best = (0i32, 0i32, f64::INFINITY);
    for dy in -MAX_SHIFT..=MAX_SHIFT {
        for dx in -MAX_SHIFT..=MAX_SHIFT {
            let s = ssd(dx, dy);
            grid[((dy + MAX_SHIFT) as usize) * n + (dx + MAX_SHIFT) as usize] = s;
            if s < best.2 {
                best = (dx, dy, s);
            }
        }
    }
    let (bx, by, _) = best;
    if bx.abs() >= MAX_SHIFT || by.abs() >= MAX_SHIFT {
        return None; // minimum on the border of the search: no reliable estimate
    }
    let at = |dx: i32, dy: i32| grid[((dy + MAX_SHIFT) as usize) * n + (dx + MAX_SHIFT) as usize];
    let refine = |l: f64, m: f64, r: f64| {
        let d = l - 2.0 * m + r;
        if d <= 0.0 {
            0.0
        } else {
            0.5 * (l - r) / d
        }
    };
    Some((
        bx as f64 + refine(at(bx - 1, by), at(bx, by), at(bx + 1, by)),
        by as f64 + refine(at(bx, by - 1), at(bx, by), at(bx, by + 1)),
    ))
}

/// Binomial blur (1 4 6 4 1) / 16 in both directions: the same smoothing for both images before they are compared, so that
/// the aliasing of a level made by plain sub-sampling (Bio-Formats and friends) does not pull the estimate towards zero.
fn blur(src: &[f32], w: usize, h: usize) -> Vec<f32> {
    const K: [f32; 5] = [1.0, 4.0, 6.0, 4.0, 1.0];
    let mut tmp = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut s = 0.0;
            for (i, k) in K.iter().enumerate() {
                let xx = (x as i32 + i as i32 - 2).clamp(0, w as i32 - 1) as usize;
                s += k * src[y * w + xx];
            }
            tmp[y * w + x] = s / 16.0;
        }
    }
    let mut out = vec![0f32; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut s = 0.0;
            for (i, k) in K.iter().enumerate() {
                let yy = (y as i32 + i as i32 - 2).clamp(0, h as i32 - 1) as usize;
                s += k * tmp[yy * w + x];
            }
            out[y * w + x] = s / 16.0;
        }
    }
    out
}

fn bilinear(img: &[f32], w: usize, x: f64, y: f64) -> f32 {
    let (x0, y0) = (x.floor() as usize, y.floor() as usize);
    let (fx, fy) = ((x - x0 as f64) as f32, (y - y0 as f64) as f32);
    let at = |xx: usize, yy: usize| img[yy * w + xx];
    at(x0, y0) * (1.0 - fx) * (1.0 - fy)
        + at(x0 + 1, y0) * fx * (1.0 - fy)
        + at(x0, y0 + 1) * (1.0 - fx) * fy
        + at(x0 + 1, y0 + 1) * fx * fy
}

/// Gradient-based refinement (Lucas-Kanade) of a shift found on the integer grid: the parabola through three SSD values is
/// biased towards the grid when the true shift lies in between (it under-estimated the 0.4 px shift of a sub-sampled pyramid
/// as 0.27), the iteration on the image gradients is not. `init` is returned when it does not converge.
fn refine_shift(
    lvl: &[f32],
    reference: &[f32],
    w: usize,
    h: usize,
    init: (f64, f64),
) -> (f64, f64) {
    let (lvl, reference) = (blur(lvl, w, h), blur(reference, w, h));
    let grad = |x: f64, y: f64| {
        (
            (bilinear(&lvl, w, x + 0.5, y) - bilinear(&lvl, w, x - 0.5, y)) as f64,
            (bilinear(&lvl, w, x, y + 0.5) - bilinear(&lvl, w, x, y - 0.5)) as f64,
        )
    };
    let lo = MARGIN + MAX_SHIFT as usize + 2;
    let mut d = init;
    for _ in 0..8 {
        let (mut a, mut b, mut c, mut bx, mut by) = (0.0f64, 0.0f64, 0.0f64, 0.0f64, 0.0f64);
        for y in lo..h - lo {
            for x in lo..w - lo {
                let (px, py) = (x as f64 + d.0, y as f64 + d.1);
                let r = (reference[y * w + x] - bilinear(&lvl, w, px, py)) as f64;
                let (gx, gy) = grad(px, py);
                a += gx * gx;
                b += gx * gy;
                c += gy * gy;
                bx += gx * r;
                by += gy * r;
            }
        }
        let det = a * c - b * b;
        if det.abs() < 1e-9 {
            return init;
        }
        let step = ((c * bx - b * by) / det, (a * by - b * bx) / det);
        d = (d.0 + step.0, d.1 + step.1);
        if (d.0 - init.0).abs() > 1.5 || (d.1 - init.1).abs() > 1.5 {
            return init;
        }
        if step.0.abs() < 0.002 && step.1.abs() < 0.002 {
            break;
        }
    }
    d
}

/// Chained offsets of every level at one spot (level-0 coordinates of the window centre).
fn offsets_at(slide: &dyn Slide, centre: (f64, f64)) -> Vec<(f64, f64)> {
    let dims = slide.level_dimensions();
    let downs = slide.level_downsamples();
    let mut out = vec![(0.0, 0.0)];
    for k in 1..dims.len() {
        let ratio = downs[k] / downs[k - 1];
        let r = ratio.round();
        let (w, h) = (dims[k].0 as usize, dims[k].1 as usize);
        let side = WIN
            .min(w.saturating_sub(2 * MARGIN))
            .min(h.saturating_sub(2 * MARGIN));
        if (ratio - r).abs() > 0.02 || r < 1.0 || side < 64 {
            out.push((0.0, 0.0));
            continue;
        }
        let r = r as usize;
        let a = ((centre.0 / downs[k]) as i64 - side as i64 / 2)
            .clamp(MARGIN as i64, (w - side - MARGIN) as i64) as f64;
        let b = ((centre.1 / downs[k]) as i64 - side as i64 / 2)
            .clamp(MARGIN as i64, (h - side - MARGIN) as i64) as f64;
        let loc = ((a * downs[k]) as i64, (b * downs[k]) as i64);
        let lvl = slide.read_region(loc.0, loc.1, k, side as u32, side as u32, 0);
        let big = slide.read_region(loc.0, loc.1, k - 1, (side * r) as u32, (side * r) as u32, 0);
        let (Ok(lvl), Ok(big)) = (lvl, big) else {
            out.push((f64::NAN, f64::NAN));
            continue;
        };
        let (reference, _, _) = reduce(&gray(&big), side * r, side * r, r);
        let measured = if std_dev(&reference) < 6.0 {
            None
        } else {
            let g = gray(&lvl);
            best_shift(&g, &reference, side, side)
                .map(|init| refine_shift(&g, &reference, side, side, init))
        };
        let prev = out[k - 1];
        match measured {
            // the previous level is itself displaced by `prev` of its own pixels, i.e. prev / r pixels of this level
            Some((mx, my)) => out.push((mx + prev.0 / r as f64, my + prev.1 / r as f64)),
            None => out.push((f64::NAN, f64::NAN)),
        }
    }
    out
}

/// Offsets per level (pixels of that level); empty when the slide has one level or no usable texture.
pub fn estimate_level_offsets(slide: &dyn Slide) -> Vec<(f64, f64)> {
    let mut offsets = estimate(slide).unwrap_or_default();
    // level 0 is the reference and is never shifted
    if let Some(first) = offsets.first_mut() {
        *first = (0.0, 0.0);
    }
    let shown: Vec<String> = offsets
        .iter()
        .map(|o| format!("({:.2}, {:.2})", o.0, o.1))
        .collect();
    tracing::info!("pyramid level offsets: {}", shown.join(" "));
    offsets
}

fn estimate(slide: &dyn Slide) -> Option<Vec<(f64, f64)>> {
    let dims = slide.level_dimensions();
    let downs = slide.level_downsamples();
    let n = dims.len();
    if n < 2 {
        return None;
    }
    // textured spots, found on the smallest level (4x4 cells ranked by contrast)
    let last = n - 1;
    let (lw, lh) = (dims[last].0 as usize, dims[last].1 as usize);
    let thumb = slide
        .read_region(0, 0, last, lw as u32, lh as u32, 0)
        .ok()?;
    let g = gray(&thumb);
    let (cw, ch) = ((lw / 4).max(1), (lh / 4).max(1));
    let mut cells = Vec::new();
    for cy in 0..4 {
        for cx in 0..4 {
            let mut cell = Vec::new();
            for y in cy * ch..((cy + 1) * ch).min(lh) {
                cell.extend_from_slice(&g[y * lw + cx * cw..((cx + 1) * cw).min(lw) + y * lw]);
            }
            cells.push((std_dev(&cell), cx, cy));
        }
    }
    cells.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let spots: Vec<Vec<(f64, f64)>> = cells
        .iter()
        .filter(|c| c.0 >= 8.0)
        .take(3)
        .map(|&(_, cx, cy)| {
            offsets_at(
                slide,
                (
                    (cx as f64 + 0.5) * cw as f64 * downs[last],
                    (cy as f64 + 0.5) * ch as f64 * downs[last],
                ),
            )
        })
        .collect();
    if spots.is_empty() {
        return None; // blank slide
    }
    let mut out = Vec::with_capacity(n);
    for k in 0..n {
        let vals: Vec<(f64, f64)> = spots
            .iter()
            .map(|s| s[k])
            .filter(|v| v.0.is_finite() && v.1.is_finite())
            .collect();
        let clean = |v: f64| if v.abs() < MIN_OFFSET { 0.0 } else { v };
        out.push(match vals.len() {
            0 => (0.0, 0.0),
            1 => (clean(vals[0].0), clean(vals[0].1)), // a single spot cannot be cross-checked
            _ => {
                // the closest pair of spots; it must agree within MAX_SPREAD, otherwise nothing is applied
                let mut best = (f64::INFINITY, (0.0, 0.0));
                for i in 0..vals.len() {
                    for j in i + 1..vals.len() {
                        let d = (vals[i].0 - vals[j].0)
                            .abs()
                            .max((vals[i].1 - vals[j].1).abs());
                        if d < best.0 {
                            best = (
                                d,
                                ((vals[i].0 + vals[j].0) / 2.0, (vals[i].1 + vals[j].1) / 2.0),
                            );
                        }
                    }
                }
                if best.0 <= MAX_SPREAD {
                    (clean(best.1 .0), clean(best.1 .1))
                } else {
                    (0.0, 0.0)
                }
            }
        });
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use fast_image_resize::{
        images::Image, FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer,
    };
    use image::RgbaImage;
    use std::collections::HashMap;

    struct Pyramid(Vec<RgbaImage>);

    impl Slide for Pyramid {
        fn level_dimensions(&self) -> Vec<(u64, u64)> {
            self.0
                .iter()
                .map(|l| (l.width() as u64, l.height() as u64))
                .collect()
        }
        fn level_downsamples(&self) -> Vec<f64> {
            (0..self.0.len()).map(|i| 2f64.powi(i as i32)).collect()
        }
        fn best_level_for_downsample(&self, _d: f64) -> usize {
            0
        }
        fn properties(&self) -> HashMap<String, String> {
            HashMap::new()
        }
        fn read_region(
            &self,
            x: i64,
            y: i64,
            level: usize,
            w: u32,
            h: u32,
            _f: u32,
        ) -> crate::Result<RgbaImage> {
            let ds = 2i64.pow(level as u32);
            Ok(crate::formats::crop_transparent(
                &self.0[level],
                x / ds,
                y / ds,
                w,
                h,
            ))
        }
    }

    fn texture(w: u32, h: u32) -> RgbaImage {
        let mut seed = 12345u32;
        let mut noise = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 24) as f32
        };
        let blobs: Vec<(f32, f32, f32, f32)> = (0..80)
            .map(|_| {
                (
                    noise() / 255.0 * w as f32,
                    noise() / 255.0 * h as f32,
                    3.0 + noise() / 8.0,
                    noise() - 128.0,
                )
            })
            .collect();
        RgbaImage::from_fn(w, h, |x, y| {
            let mut v = 128.0f32;
            for (cx, cy, s, a) in &blobs {
                let d = ((x as f32 - cx).powi(2) + (y as f32 - cy).powi(2)) / (2.0 * s * s);
                v += a * (-d).exp();
            }
            let v = v.clamp(0.0, 255.0) as u8;
            image::Rgba([v, v, v, 255])
        })
    }

    /// Halves the `size` x `size` window of `src` at `(sx, sy)` (fractional source pixels): exactly 2:1, only displaced.
    fn half(src: &RgbaImage, sx: f64, sy: f64, size: u32) -> RgbaImage {
        let s = Image::from_vec_u8(
            src.width(),
            src.height(),
            src.as_raw().clone(),
            PixelType::U8x4,
        )
        .unwrap();
        let mut d = Image::new(size / 2, size / 2, PixelType::U8x4);
        let opts = ResizeOptions::new()
            .resize_alg(ResizeAlg::Convolution(FilterType::Box))
            .crop(sx, sy, size as f64, size as f64);
        Resizer::new().resize(&s, &mut d, &opts).unwrap();
        RgbaImage::from_raw(size / 2, size / 2, d.into_vec()).unwrap()
    }

    const N: u32 = 1024;

    #[test]
    fn finds_a_displaced_level() {
        let big = texture(N + 16, N + 16);
        let l0 = crate::formats::crop_transparent(&big, 8, 8, N, N);
        // level 1 shows the content displaced by (+1.2, -0.8) source px = (+0.6, -0.4) of its own pixels
        let l1 = half(&big, 8.0 + 1.2, 8.0 - 0.8, N);
        let offs = estimate_level_offsets(&Pyramid(vec![l0, l1]));
        assert_eq!(offs.len(), 2);
        assert_eq!(offs[0], (0.0, 0.0));
        // sampling level 1 at (x + dx) must give the reference: dx = -0.6, dy = +0.4
        let (dx, dy) = offs[1];
        assert!(
            (dx + 0.6).abs() < 0.15 && (dy - 0.4).abs() < 0.15,
            "level 1 offset {dx} {dy}"
        );
    }

    #[test]
    fn a_registered_pyramid_gets_zero_offsets() {
        let big = texture(N + 16, N + 16);
        let l0 = crate::formats::crop_transparent(&big, 8, 8, N, N);
        let l1 = half(&big, 8.0, 8.0, N);
        let offs = estimate_level_offsets(&Pyramid(vec![l0, l1]));
        assert_eq!(
            offs[1],
            (0.0, 0.0),
            "noise below the threshold is not applied"
        );
    }

    #[test]
    fn offsets_chain_through_levels() {
        // level 1 displaced by (+0.6, 0) own px, level 2 registered with level 1 (so also displaced by 0.3 px of its own)
        let big = texture(2 * N + 32, 2 * N + 32);
        let l0 = crate::formats::crop_transparent(&big, 16, 16, 2 * N, 2 * N);
        let l1 = half(&big, 16.0 + 1.2, 16.0, 2 * N);
        let l2 = half(
            &crate::formats::crop_transparent(&l1, 0, 0, N, N),
            0.0,
            0.0,
            N,
        );
        let offs = estimate_level_offsets(&Pyramid(vec![l0, l1, l2]));
        assert!((offs[1].0 + 0.6).abs() < 0.15, "{offs:?}");
        assert!((offs[2].0 + 0.3).abs() < 0.2, "{offs:?}");
    }
}
