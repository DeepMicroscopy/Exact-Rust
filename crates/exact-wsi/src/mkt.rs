//! Cellvizio MKT time series: port of `util/cellvizio.py`. One int16 frame per chunk, windowed inside the
//! circular field of view to 0.5..99.5 percentile (upper bound capped at 5000).

use crate::{err, formats::crop_transparent, Result, Slide, WsiError};
use image::RgbaImage;
use moka::sync::Cache;
use std::{collections::HashMap, io::Read, io::Seek, io::SeekFrom, sync::Arc};

const CHUNK_HEADER: usize = 16;
const CSTA: &[u8] = b"\n<CSTA";

pub struct Mkt {
    path: String,
    data_size: usize,
    offsets: Vec<u64>,
    width: usize,
    height: usize,
    pub fps: f64,
    pub kv: HashMap<String, String>,
    mpp: (f64, f64),
    mask: Vec<bool>,
    cache: Cache<u32, Arc<Vec<u8>>>,
}

fn find(hay: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    hay.get(from..)?
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| p + from)
}

/// numpy `percentile` (linear interpolation) of an ascending-sorted slice
fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let pos = p / 100.0 * (sorted.len() - 1) as f64;
    let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
    sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo as f64)
}

impl Mkt {
    pub fn open(path: &str) -> Result<Self> {
        let io = |e: std::io::Error| WsiError(format!("{path}: {e}"));
        let mut f = std::fs::File::open(path).map_err(io)?;
        let mut head = [0u8; 14];
        f.read_exact(&mut head).map_err(io)?;
        if &head[..6] != CSTA {
            return err("not an MKT file");
        }
        let data_size = u32::from_be_bytes([head[10], head[11], head[12], head[13]]) as usize;
        let len = f.seek(SeekFrom::End(0)).map_err(io)?;
        let scan = len.min(65536);
        f.seek(SeekFrom::Start(len - scan)).map_err(io)?;
        let mut tail = vec![0u8; scan as usize];
        f.read_exact(&mut tail).map_err(io)?;
        let (mut entries, mut kv) = (Vec::new(), HashMap::new());
        let mut pos = 0;
        while let Some(idx) = find(&tail, CSTA, pos) {
            if idx + CHUNK_HEADER > tail.len() {
                break;
            }
            let h = &tail[idx..idx + CHUNK_HEADER];
            let ctype = u16::from_be_bytes([h[8], h[9]]);
            let csize = u32::from_be_bytes([h[10], h[11], h[12], h[13]]) as usize;
            if ctype == 5 {
                let body = &tail[(idx + CHUNK_HEADER).min(tail.len())
                    ..(idx + CHUNK_HEADER + csize).min(tail.len())];
                if body.len() >= 4 {
                    let n = u32::from_le_bytes([body[0], body[1], body[2], body[3]]) as usize;
                    for i in 0..n {
                        let e = body
                            .get(4 + i * 12..4 + (i + 1) * 12)
                            .ok_or_else(|| WsiError("bad MKT index".into()))?;
                        let u = |o: usize| u32::from_le_bytes([e[o], e[o + 1], e[o + 2], e[o + 3]]);
                        entries.push((u(0), u(4) as u64, u(8)));
                    }
                    for line in body.get(4 + n * 12..).unwrap_or(&[]).split(|b| *b == b'\n') {
                        let line = String::from_utf8_lossy(line);
                        let line = line.trim_matches('\0').trim();
                        if let Some((k, v)) = line.split_once('=') {
                            kv.insert(k.to_string(), v.to_string());
                        }
                    }
                }
                break;
            }
            pos = idx + 1;
        }
        let offsets: Vec<u64> = entries
            .iter()
            .filter(|e| e.0 == 2)
            .map(|e| e.1 + CHUNK_HEADER as u64)
            .collect();
        let num = |k: &str, d: f64| kv.get(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(d);
        let (width, height) = (num("width", 0.0) as usize, num("height", 0.0) as usize);
        if width == 0 || height == 0 || offsets.is_empty() {
            return err("MKT file without frames");
        }
        let mpp = (
            num("fovx", 250.0) / width as f64,
            num("fovy", 250.0) / height as f64,
        );
        // circularMask(w, h, w - 2): rows -int(h/2).., columns -int(w/2)..
        let r = ((width as i64 - 2) / 2).pow(2);
        let (hy, hx) = ((height / 2) as i64, (width / 2) as i64);
        let mut mask = vec![false; width * height];
        for y in 0..height {
            for x in 0..width {
                let (dy, dx) = (y as i64 - hy, x as i64 - hx);
                mask[y * width + x] = dy * dy + dx * dx <= r;
            }
        }
        Ok(Self {
            path: path.to_string(),
            data_size,
            offsets,
            width,
            height,
            fps: num("framerate", 0.0),
            kv,
            mpp,
            mask,
            cache: Cache::new(64),
        })
    }

    pub fn frame_descriptors(&self) -> Vec<String> {
        (0..self.offsets.len())
            .map(|i| format!("{:.2} s ({i})", i as f64 / self.fps))
            .collect()
    }

    /// `readImageUINT8`
    fn frame_u8(&self, frame: u32) -> Result<Arc<Vec<u8>>> {
        if let Some(f) = self.cache.get(&frame) {
            return Ok(f);
        }
        let io = |e: std::io::Error| WsiError(format!("{}: {e}", self.path));
        let off = *self
            .offsets
            .get(frame as usize)
            .ok_or_else(|| WsiError("frame out of range".into()))?;
        let mut f = std::fs::File::open(&self.path).map_err(io)?;
        f.seek(SeekFrom::Start(off)).map_err(io)?;
        let mut raw = Vec::new();
        f.take(self.data_size as u64 / 2 * 2)
            .read_to_end(&mut raw)
            .map_err(io)?;
        let n = self.width * self.height;
        let vals: Vec<f64> = if raw.len() / 2 == n {
            raw.as_chunks::<2>()
                .0
                .iter()
                .map(|c| (i16::from_le_bytes([c[0], c[1]]).max(0)) as f64)
                .collect()
        } else {
            vec![0.0; n]
        };
        let mut inside: Vec<f64> = vals
            .iter()
            .zip(&self.mask)
            .filter(|(_, m)| **m)
            .map(|(v, _)| *v)
            .collect();
        inside.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let cmin = percentile(&inside, 0.5);
        let cmax = percentile(&inside, 99.5).min(5000.0);
        let dyn_range = cmax - cmin;
        let out: Vec<u8> = vals
            .iter()
            .map(|v| {
                if dyn_range == 0.0 {
                    return 0; // numpy yields NaN -> 0 here
                }
                let s = (v - cmin) * (255.0 / dyn_range);
                // numpy rounds half to even
                let r = s.round_ties_even();
                r.clamp(0.0, 255.0) as u8
            })
            .collect();
        let out = Arc::new(out);
        self.cache.insert(frame, out.clone());
        Ok(out)
    }
}

impl Slide for Mkt {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        vec![(self.width as u64, self.height as u64)]
    }
    fn level_downsamples(&self) -> Vec<f64> {
        vec![1.0]
    }
    fn best_level_for_downsample(&self, _d: f64) -> usize {
        0
    }
    fn properties(&self) -> HashMap<String, String> {
        HashMap::from([
            ("openslide.background-color".into(), "000000".into()),
            ("openslide.mpp-x".into(), self.mpp.0.to_string()),
            ("openslide.mpp-y".into(), self.mpp.1.to_string()),
            ("openslide.objective-power".into(), "20".into()),
            ("openslide.vendor".into(), "MKT".into()),
        ])
    }
    fn frame_count(&self) -> u32 {
        self.offsets.len() as u32
    }
    fn frame_rate(&self) -> Option<f64> {
        (self.fps > 0.0).then_some(self.fps)
    }
    fn frame_kind(&self) -> crate::FrameKind {
        crate::FrameKind::TimeSeries
    }
    fn frame_labels(&self) -> Vec<String> {
        self.frame_descriptors()
    }
    fn read_region(
        &self,
        x: i64,
        y: i64,
        level: usize,
        w: u32,
        h: u32,
        frame: u32,
    ) -> Result<RgbaImage> {
        if level != 0 {
            return err("Invalid level");
        }
        let g = self.frame_u8(frame)?;
        let mut img = RgbaImage::new(self.width as u32, self.height as u32);
        for (i, p) in img.pixels_mut().enumerate() {
            *p = image::Rgba([g[i], g[i], g[i], 255]);
        }
        Ok(crop_transparent(&img, x, y, w, h))
    }
}
