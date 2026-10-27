//! Uncompressed multi-frame DICOM (secondary capture, CT, MR, ...) read natively, as time series or z-stack.
//! Compressed transfer syntaxes and whole-slide DICOM are left to the slideio helper.

use crate::{err, formats::crop_transparent, Result, Slide, WsiError};
use image::RgbaImage;
use std::collections::HashMap;

pub struct DicomVolume {
    rows: usize,
    cols: usize,
    frames: usize,
    samples: usize,
    bits: usize,
    signed: bool,
    planar: bool,
    slope: f64,
    intercept: f64,
    window: Option<(f64, f64)>,
    pub modality: String,
    pub frame_time_ms: Option<f64>,
    mpp: (f64, f64),
    pixels: Vec<u8>,
    /// display window for >8-bit data, derived from the whole volume when the file has none
    auto_window: (f64, f64),
}

struct Cur<'a> {
    b: &'a [u8],
    p: usize,
}

impl Cur<'_> {
    fn u16(&mut self) -> Option<u16> {
        let v = self.b.get(self.p..self.p + 2)?;
        self.p += 2;
        Some(u16::from_le_bytes([v[0], v[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        let v = self.b.get(self.p..self.p + 4)?;
        self.p += 4;
        Some(u32::from_le_bytes([v[0], v[1], v[2], v[3]]))
    }
}

const LONG_VRS: [&[u8; 2]; 8] = [b"OB", b"OD", b"OF", b"OL", b"OW", b"SQ", b"UN", b"UT"];

/// Skips an item list of undefined length until the sequence delimiter; returns false when malformed.
fn skip_undefined(c: &mut Cur, explicit: bool) -> bool {
    loop {
        let (Some(g), Some(e), Some(len)) = (c.u16(), c.u16(), c.u32()) else {
            return false;
        };
        match (g, e) {
            (0xFFFE, 0xE0DD) => return true,
            (0xFFFE, 0xE000) => {
                if len == 0xFFFF_FFFF {
                    // item of undefined length: elements until the item delimiter
                    loop {
                        let save = c.p;
                        let (Some(g2), Some(e2)) = (c.u16(), c.u16()) else {
                            return false;
                        };
                        if (g2, e2) == (0xFFFE, 0xE00D) {
                            c.p += 4;
                            break;
                        }
                        c.p = save;
                        if !skip_element(c, explicit) {
                            return false;
                        }
                    }
                } else {
                    c.p += len as usize;
                }
            }
            _ => return false,
        }
    }
}

fn skip_element(c: &mut Cur, explicit: bool) -> bool {
    let (Some(_g), Some(_e)) = (c.u16(), c.u16()) else {
        return false;
    };
    match header_len(c, explicit) {
        Some((HeaderLen::Defined(n), _)) => {
            c.p += n;
            c.p <= c.b.len()
        }
        Some((HeaderLen::Undefined, _)) => skip_undefined(c, explicit),
        None => false,
    }
}

enum HeaderLen {
    Defined(usize),
    Undefined,
}

/// Reads VR (explicit) and length after the tag; returns the length and the VR.
fn header_len(c: &mut Cur, explicit: bool) -> Option<(HeaderLen, [u8; 2])> {
    if explicit {
        let vr = [*c.b.get(c.p)?, *c.b.get(c.p + 1)?];
        c.p += 2;
        let len = if LONG_VRS.contains(&&vr) {
            c.p += 2;
            c.u32()?
        } else {
            c.u16()? as u32
        };
        Some((
            if len == 0xFFFF_FFFF {
                HeaderLen::Undefined
            } else {
                HeaderLen::Defined(len as usize)
            },
            vr,
        ))
    } else {
        let len = c.u32()?;
        Some((
            if len == 0xFFFF_FFFF {
                HeaderLen::Undefined
            } else {
                HeaderLen::Defined(len as usize)
            },
            *b"UN",
        ))
    }
}

fn text(b: &[u8]) -> String {
    String::from_utf8_lossy(b)
        .trim_matches(|c: char| c == '\0' || c == ' ')
        .to_string()
}

fn nums(b: &[u8]) -> Vec<f64> {
    text(b)
        .split('\\')
        .filter_map(|v| v.trim().parse().ok())
        .collect()
}

impl DicomVolume {
    pub fn open(path: &str) -> Result<Self> {
        let b = std::fs::read(path).map_err(|e| WsiError(format!("{path}: {e}")))?;
        let mut c = Cur {
            b: &b,
            p: if b.get(128..132) == Some(b"DICM") {
                132
            } else {
                0
            },
        };
        // file meta group is always explicit little endian
        let mut ts = String::from("1.2.840.10008.1.2.1");
        while c.b.len() > c.p + 8 && c.b[c.p] == 2 && c.b[c.p + 1] == 0 {
            let e = u16::from_le_bytes([c.b[c.p + 2], c.b[c.p + 3]]);
            c.p += 4;
            let Some((HeaderLen::Defined(n), _)) = header_len(&mut c, true) else {
                return err("bad DICOM meta");
            };
            if e == 0x0010 {
                ts = text(&c.b[c.p..c.p + n]);
            }
            c.p += n;
        }
        let explicit = ts != "1.2.840.10008.1.2";
        if !matches!(ts.as_str(), "1.2.840.10008.1.2" | "1.2.840.10008.1.2.1") {
            return err(format!("transfer syntax {ts} is not handled natively"));
        }
        let mut d = Self {
            rows: 0,
            cols: 0,
            frames: 1,
            samples: 1,
            bits: 8,
            signed: false,
            planar: false,
            slope: 1.0,
            intercept: 0.0,
            window: None,
            modality: String::new(),
            frame_time_ms: None,
            mpp: (0.0, 0.0),
            pixels: Vec::new(),
            auto_window: (0.0, 255.0),
        };
        let mut sop = String::new();
        let mut photometric = String::new();
        loop {
            let (Some(g), Some(e)) = (c.u16(), c.u16()) else {
                return err("no pixel data");
            };
            let Some((len, _vr)) = header_len(&mut c, explicit) else {
                return err("bad DICOM element");
            };
            let n = match len {
                HeaderLen::Undefined => {
                    if (g, e) == (0x7FE0, 0x0010) {
                        return err("encapsulated pixel data is not handled natively");
                    }
                    if !skip_undefined(&mut c, explicit) {
                        return err("bad DICOM sequence");
                    }
                    continue;
                }
                HeaderLen::Defined(n) => n,
            };
            let Some(v) = c.b.get(c.p..c.p + n) else {
                return err("truncated DICOM");
            };
            match (g, e) {
                (0x0008, 0x0016) => sop = text(v),
                (0x0008, 0x0060) => d.modality = text(v),
                (0x0018, 0x1063) => d.frame_time_ms = nums(v).first().copied(),
                (0x0028, 0x0002) => d.samples = u16::from_le_bytes([v[0], v[1]]) as usize,
                (0x0028, 0x0004) => photometric = text(v),
                (0x0028, 0x0006) => d.planar = u16::from_le_bytes([v[0], v[1]]) == 1,
                (0x0028, 0x0008) => d.frames = text(v).parse().unwrap_or(1),
                (0x0028, 0x0010) => d.rows = u16::from_le_bytes([v[0], v[1]]) as usize,
                (0x0028, 0x0011) => d.cols = u16::from_le_bytes([v[0], v[1]]) as usize,
                (0x0028, 0x0030) | (0x0018, 0x1164) | (0x0018, 0x2010) => {
                    let p = nums(v);
                    if p.len() >= 2 && d.mpp.0 == 0.0 {
                        d.mpp = (p[1] * 1000.0, p[0] * 1000.0);
                    }
                }
                (0x0028, 0x0100) => d.bits = u16::from_le_bytes([v[0], v[1]]) as usize,
                (0x0028, 0x0103) => d.signed = u16::from_le_bytes([v[0], v[1]]) == 1,
                (0x0028, 0x1050) => {
                    let w = nums(v);
                    d.window = w.first().copied().map(|c| (c, 0.0));
                }
                (0x0028, 0x1051) => {
                    if let (Some(w), Some(first)) = (nums(v).first().copied(), d.window.as_mut()) {
                        first.1 = w;
                    }
                }
                (0x0028, 0x1052) => d.intercept = nums(v).first().copied().unwrap_or(0.0),
                (0x0028, 0x1053) => d.slope = nums(v).first().copied().unwrap_or(1.0),
                (0x7FE0, 0x0010) => {
                    d.pixels = v.to_vec();
                    break;
                }
                _ => {}
            }
            c.p += n;
        }
        // whole-slide DICOM (tiled, pyramidal) belongs to the slide readers
        if sop == "1.2.840.10008.5.1.4.1.1.77.1.6" || photometric.starts_with("YBR") {
            return err("whole-slide or YBR DICOM is not handled natively");
        }
        if d.rows == 0
            || d.cols == 0
            || !(d.bits == 8 || d.bits == 16)
            || !(d.samples == 1 || d.samples == 3)
        {
            return err("unsupported DICOM pixel layout");
        }
        let need = d.frames * d.rows * d.cols * d.samples * d.bits / 8;
        if d.pixels.len() < need {
            return err("truncated DICOM pixel data");
        }
        if d.bits == 16 {
            // 1..99 percentile of a sparse sample of the volume (modality values)
            let step = (d.frames * d.rows * d.cols / 100_000).max(1);
            let mut s: Vec<f64> = (0..d.frames * d.rows * d.cols)
                .step_by(step)
                .map(|i| d.modality_value(i))
                .collect();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let (lo, hi) = (s[s.len() / 100], s[s.len() * 99 / 100]);
            d.auto_window = (lo, if hi > lo { hi } else { lo + 1.0 });
        }
        Ok(d)
    }

    fn raw(&self, i: usize) -> f64 {
        if self.bits == 8 {
            let v = self.pixels[i];
            if self.signed {
                v as i8 as f64
            } else {
                v as f64
            }
        } else {
            let v = u16::from_le_bytes([self.pixels[2 * i], self.pixels[2 * i + 1]]);
            if self.signed {
                v as i16 as f64
            } else {
                v as f64
            }
        }
    }

    fn modality_value(&self, i: usize) -> f64 {
        self.raw(i) * self.slope + self.intercept
    }

    pub fn frame_descriptors(&self) -> Vec<String> {
        match self.frame_time_ms {
            Some(t) => (0..self.frames)
                .map(|i| format!("{:.2} s ({i})", t / 1000.0 * i as f64))
                .collect(),
            None => (0..self.frames).map(|i| format!("Frame {i}")).collect(),
        }
    }

    pub fn is_volume(&self) -> bool {
        matches!(self.modality.as_str(), "CT" | "MR" | "PT" | "NM")
    }

    fn render(&self, frame: usize) -> RgbaImage {
        let f = frame.min(self.frames - 1);
        let px = self.rows * self.cols;
        let mut img = RgbaImage::new(self.cols as u32, self.rows as u32);
        let base = f * px * self.samples;
        let to_u8 = |v: f64| -> u8 {
            if self.bits == 8 && self.window.is_none() && self.slope == 1.0 && self.intercept == 0.0
            {
                return v.clamp(0.0, 255.0) as u8;
            }
            let (lo, hi) = match self.window {
                Some((c, w)) if w > 0.0 => (c - 0.5 - (w - 1.0) / 2.0, c - 0.5 + (w - 1.0) / 2.0),
                _ => self.auto_window,
            };
            (((v - lo) / (hi - lo)) * 255.0).clamp(0.0, 255.0) as u8
        };
        for (i, p) in img.pixels_mut().enumerate() {
            if self.samples == 1 {
                let g = to_u8(self.raw(base + i) * self.slope + self.intercept);
                *p = image::Rgba([g, g, g, 255]);
            } else {
                let at = |ch: usize| {
                    let idx = if self.planar {
                        base + ch * px + i
                    } else {
                        base + i * 3 + ch
                    };
                    self.raw(idx).clamp(0.0, 255.0) as u8
                };
                *p = image::Rgba([at(0), at(1), at(2), 255]);
            }
        }
        img
    }
}

impl Slide for DicomVolume {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        vec![(self.cols as u64, self.rows as u64)]
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
            ("openslide.objective-power".into(), "0".into()),
            ("openslide.vendor".into(), "DICOM".into()),
        ])
    }
    fn frame_count(&self) -> u32 {
        self.frames as u32
    }
    fn frame_kind(&self) -> crate::FrameKind {
        match (self.frames, self.is_volume()) {
            (0 | 1, _) => crate::FrameKind::None,
            (_, true) => crate::FrameKind::Volume,
            _ => crate::FrameKind::TimeSeries,
        }
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
        Ok(crop_transparent(&self.render(frame as usize), x, y, w, h))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn el(out: &mut Vec<u8>, g: u16, e: u16, vr: &[u8; 2], v: &[u8]) {
        out.extend(g.to_le_bytes());
        out.extend(e.to_le_bytes());
        out.extend(vr);
        if LONG_VRS.contains(&vr) {
            out.extend([0, 0]);
            out.extend((v.len() as u32).to_le_bytes());
        } else {
            out.extend((v.len() as u16).to_le_bytes());
        }
        out.extend(v);
    }

    /// 3 frames of 4x2 16-bit CT values with rescale slope 1 / intercept -1024
    fn synthetic(window: bool) -> Vec<u8> {
        let mut b = vec![0u8; 128];
        b.extend(b"DICM");
        el(&mut b, 2, 0x10, b"UI", b"1.2.840.10008.1.2.1\0");
        el(&mut b, 8, 0x60, b"CS", b"CT");
        el(&mut b, 0x28, 2, b"US", &1u16.to_le_bytes());
        el(&mut b, 0x28, 4, b"CS", b"MONOCHROME2 ");
        el(&mut b, 0x28, 8, b"IS", b"3 ");
        el(&mut b, 0x28, 0x10, b"US", &2u16.to_le_bytes());
        el(&mut b, 0x28, 0x11, b"US", &4u16.to_le_bytes());
        el(&mut b, 0x28, 0x30, b"DS", b"0.5\\0.25");
        el(&mut b, 0x28, 0x100, b"US", &16u16.to_le_bytes());
        el(&mut b, 0x28, 0x103, b"US", &0u16.to_le_bytes());
        if window {
            el(&mut b, 0x28, 0x1050, b"DS", b"40 ");
            el(&mut b, 0x28, 0x1051, b"DS", b"400");
        }
        el(&mut b, 0x28, 0x1052, b"DS", b"-1024");
        el(&mut b, 0x28, 0x1053, b"DS", b"1 ");
        let px: Vec<u8> = (0..24u16)
            .flat_map(|i| (1024 + i * 10).to_le_bytes())
            .collect();
        el(&mut b, 0x7FE0, 0x10, b"OW", &px);
        b
    }

    #[test]
    fn reads_geometry_frames_and_spacing() {
        let dir = std::env::temp_dir().join("exact_dicom_test.dcm");
        std::fs::write(&dir, synthetic(true)).unwrap();
        let d = DicomVolume::open(dir.to_str().unwrap()).unwrap();
        assert_eq!(d.level_dimensions(), vec![(4, 2)]);
        assert_eq!(d.frame_count(), 3);
        assert!(d.is_volume());
        assert_eq!(d.properties()["openslide.mpp-x"], "250"); // PixelSpacing is (row, column) in mm
        let r = d.read_region(0, 0, 0, 4, 2, 1).unwrap();
        // frame 1 starts at value 1024 + 80 -> 80 HU, window 40/400 -> (80 - (-160)) / 399 * 255 ~ 153
        let g = r.get_pixel(0, 0)[0];
        assert!((150..=156).contains(&g), "{g}");
    }

    #[test]
    fn without_window_uses_volume_percentiles() {
        let dir = std::env::temp_dir().join("exact_dicom_test2.dcm");
        std::fs::write(&dir, synthetic(false)).unwrap();
        let d = DicomVolume::open(dir.to_str().unwrap()).unwrap();
        let lo = d.read_region(0, 0, 0, 1, 1, 0).unwrap().get_pixel(0, 0)[0];
        let hi = d.read_region(3, 1, 0, 1, 1, 2).unwrap().get_pixel(0, 0)[0];
        assert!(lo < 20 && hi > 235, "{lo} {hi}");
    }

    #[test]
    fn compressed_syntax_is_left_to_slideio() {
        let mut b = synthetic(true);
        let pos = b
            .windows(19)
            .position(|w| w == b"1.2.840.10008.1.2.1")
            .unwrap();
        b[pos + 18] = b'0'; // 1.2.840.10008.1.2.0 is not a transfer syntax we know
        b.splice(pos..pos + 19, b"1.2.840.10008.1.2.4.50".iter().copied());
        // length field no longer matches; the parser must fail rather than panic
        let dir = std::env::temp_dir().join("exact_dicom_test3.dcm");
        std::fs::write(&dir, b).unwrap();
        assert!(DicomVolume::open(dir.to_str().unwrap()).is_err());
    }
}
