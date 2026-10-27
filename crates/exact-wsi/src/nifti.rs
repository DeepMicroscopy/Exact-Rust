//! NIfTI-1/2 volumes (`.nii`, `.nii.gz`): port of `util/nifti.py`. Data is reoriented to the closest RAS+
//! orientation (`nibabel.as_closest_canonical`), displayed radiologically and windowed to the 1st..99th percentile.

use crate::{err, Result, Slide, WsiError};
use image::RgbaImage;
use std::{collections::HashMap, io::Read};

/// Pixel lookup `(column, row) -> value` of one rendered slice.
type Pixel<'a> = Box<dyn Fn(usize, usize) -> f32 + 'a>;

pub struct Nifti {
    /// (X, Y, Z) after reorientation, row-major with X fastest
    shape: (usize, usize, usize),
    data: Vec<f32>,
    spacing: (f64, f64, f64),
    ax: (u32, u32),
    cor: (u32, u32),
    sag: (u32, u32),
    wmin: f32,
    wmax: f32,
}

struct Reader<'a> {
    b: &'a [u8],
    le: bool,
}

impl Reader<'_> {
    fn arr<const N: usize>(&self, o: usize) -> [u8; N] {
        let mut a = [0u8; N];
        if let Some(s) = self.b.get(o..o + N) {
            a.copy_from_slice(s);
        }
        if !self.le {
            a.reverse();
        }
        a
    }
    fn i16(&self, o: usize) -> i64 {
        i16::from_le_bytes(self.arr(o)) as i64
    }
    fn i32(&self, o: usize) -> i64 {
        i32::from_le_bytes(self.arr(o)) as i64
    }
    fn i64(&self, o: usize) -> i64 {
        i64::from_le_bytes(self.arr(o))
    }
    fn f32(&self, o: usize) -> f64 {
        f32::from_le_bytes(self.arr(o)) as f64
    }
    fn f64(&self, o: usize) -> f64 {
        f64::from_le_bytes(self.arr(o))
    }
}

type M4 = [[f64; 4]; 4];

fn quat_affine(b: f64, c: f64, d: f64, off: [f64; 3], zooms: [f64; 3], qfac: f64) -> M4 {
    let mut a2 = 1.0 - (b * b + c * c + d * d);
    let (mut b, mut c, mut d) = (b, c, d);
    let a = if a2 < 1e-7 {
        let n = (b * b + c * c + d * d).sqrt();
        b /= n;
        c /= n;
        d /= n;
        a2 = 0.0;
        a2
    } else {
        a2.sqrt()
    };
    let r = [
        [
            a * a + b * b - c * c - d * d,
            2.0 * b * c - 2.0 * a * d,
            2.0 * b * d + 2.0 * a * c,
        ],
        [
            2.0 * b * c + 2.0 * a * d,
            a * a + c * c - b * b - d * d,
            2.0 * c * d - 2.0 * a * b,
        ],
        [
            2.0 * b * d - 2.0 * a * c,
            2.0 * c * d + 2.0 * a * b,
            a * a + d * d - c * c - b * b,
        ],
    ];
    let z = [
        zooms[0],
        zooms[1],
        zooms[2] * if qfac < 0.0 { -1.0 } else { 1.0 },
    ];
    let mut m = [[0.0; 4]; 4];
    for i in 0..3 {
        for j in 0..3 {
            m[i][j] = r[i][j] * z[j];
        }
        m[i][3] = off[i];
    }
    m[3][3] = 1.0;
    m
}

impl Nifti {
    pub fn open(path: &str) -> Result<Self> {
        let raw = std::fs::read(path).map_err(|e| WsiError(format!("{path}: {e}")))?;
        let bytes = if raw.starts_with(&[0x1f, 0x8b]) {
            let mut out = Vec::new();
            flate2::read::MultiGzDecoder::new(&raw[..])
                .read_to_end(&mut out)
                .map_err(|e| WsiError(e.to_string()))?;
            out
        } else {
            raw
        };
        Self::parse(&bytes)
    }

    pub fn parse(b: &[u8]) -> Result<Self> {
        if b.len() < 348 {
            return err("not a NIfTI file");
        }
        let le = i32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        let (v2, le) = match (le, i32::from_be_bytes([b[0], b[1], b[2], b[3]])) {
            (348, _) => (false, true),
            (_, 348) => (false, false),
            (540, _) => (true, true),
            (_, 540) => (true, false),
            _ => return err("not a NIfTI file"),
        };
        let r = Reader { b, le };
        let (ndim, dim, dtype, pix, vox_offset, slope, inter, qcode, scode, quat, qoff, srow);
        if !v2 {
            ndim = r.i16(40) as usize;
            dim = (0..7).map(|i| r.i16(42 + 2 * i)).collect::<Vec<_>>();
            dtype = r.i16(70);
            pix = (0..8).map(|i| r.f32(76 + 4 * i)).collect::<Vec<_>>();
            vox_offset = r.f32(108) as usize;
            slope = r.f32(112);
            inter = r.f32(116);
            qcode = r.i16(252);
            scode = r.i16(254);
            quat = [r.f32(256), r.f32(260), r.f32(264)];
            qoff = [r.f32(268), r.f32(272), r.f32(276)];
            srow = [
                [r.f32(280), r.f32(284), r.f32(288), r.f32(292)],
                [r.f32(296), r.f32(300), r.f32(304), r.f32(308)],
                [r.f32(312), r.f32(316), r.f32(320), r.f32(324)],
            ];
        } else {
            if b.len() < 540 {
                return err("truncated NIfTI-2 header");
            }
            dtype = r.i16(12);
            ndim = r.i64(16) as usize;
            dim = (0..7).map(|i| r.i64(24 + 8 * i)).collect::<Vec<_>>();
            pix = (0..8).map(|i| r.f64(104 + 8 * i)).collect::<Vec<_>>();
            vox_offset = r.i64(168) as usize;
            slope = r.f64(176);
            inter = r.f64(184);
            qcode = r.i32(344);
            scode = r.i32(348);
            quat = [r.f64(352), r.f64(360), r.f64(368)];
            qoff = [r.f64(376), r.f64(384), r.f64(392)];
            srow = [
                [r.f64(400), r.f64(408), r.f64(416), r.f64(424)],
                [r.f64(432), r.f64(440), r.f64(448), r.f64(456)],
                [r.f64(464), r.f64(472), r.f64(480), r.f64(488)],
            ];
        }
        if !(2..=7).contains(&ndim) {
            return err("unsupported NIfTI dimensionality");
        }
        let dims: Vec<usize> = dim[..ndim].iter().map(|&d| d.max(1) as usize).collect();
        // nibabel affine: sform, else qform, else scaled identity
        let zooms = [
            pix[1].abs(),
            pix.get(2).copied().unwrap_or(1.0).abs(),
            pix.get(3).copied().unwrap_or(1.0).abs(),
        ];
        let affine: M4 = if scode > 0 {
            [srow[0], srow[1], srow[2], [0.0, 0.0, 0.0, 1.0]]
        } else if qcode > 0 {
            quat_affine(quat[0], quat[1], quat[2], qoff, zooms, pix[0])
        } else {
            let z = |i: usize| if zooms[i] > 0.0 { zooms[i] } else { 1.0 };
            [
                [z(0), 0.0, 0.0, 0.0],
                [0.0, z(1), 0.0, 0.0],
                [0.0, 0.0, z(2), 0.0],
                [0.0, 0.0, 0.0, 1.0],
            ]
        };
        let (dx, dy, dz) = (dims[0], dims[1], dims.get(2).copied().unwrap_or(1));
        let extra: usize = dims.iter().skip(3).product::<usize>().max(1);
        let total = dx * dy * dz * extra;
        let (bytes_per, kind) = match dtype {
            2 => (1, 'u'),
            256 => (1, 'i'),
            4 => (2, 'i'),
            512 => (2, 'u'),
            8 => (4, 'i'),
            768 => (4, 'u'),
            16 => (4, 'f'),
            1024 => (8, 'i'),
            1280 => (8, 'u'),
            64 => (8, 'f'),
            _ => return err(format!("unsupported NIfTI datatype {dtype}")),
        };
        let body = b
            .get(vox_offset..vox_offset + total * bytes_per)
            .ok_or_else(|| WsiError("truncated NIfTI data".into()))?;
        let (slope, inter) = if slope.is_finite() && slope != 0.0 {
            (slope, if inter.is_finite() { inter } else { 0.0 })
        } else {
            (1.0, 0.0)
        };
        let rd = Reader { b: body, le };
        let mut vals = Vec::with_capacity(total);
        for i in 0..total {
            let o = i * bytes_per;
            let v: f64 = match (kind, bytes_per) {
                ('u', 1) => body[o] as f64,
                ('i', 1) => body[o] as i8 as f64,
                ('i', 2) => rd.i16(o) as f64,
                ('u', 2) => u16::from_le_bytes(rd.arr(o)) as f64,
                ('i', 4) => rd.i32(o) as f64,
                ('u', 4) => u32::from_le_bytes(rd.arr(o)) as f64,
                ('f', 4) => rd.f32(o),
                ('i', 8) => rd.i64(o) as f64,
                ('u', 8) => u64::from_le_bytes(rd.arr(o)) as f64,
                _ => rd.f64(o),
            };
            vals.push((v * slope + inter) as f32);
        }
        // io_orientation: for each input axis the output axis it mostly points to and its sign
        let zoom_in: Vec<f64> = (0..3)
            .map(|j| {
                (0..3)
                    .map(|i| affine[i][j] * affine[i][j])
                    .sum::<f64>()
                    .sqrt()
            })
            .collect();
        let mut rs = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                rs[i][j] = affine[i][j] / if zoom_in[j] > 0.0 { zoom_in[j] } else { 1.0 };
            }
        }
        let mut ornt = [(0usize, 1i8); 3];
        let mut used = [false; 3];
        for j in 0..3 {
            let mut best = (usize::MAX, 0.0f64);
            for (i, row) in rs.iter().enumerate() {
                if !used[i] && (best.0 == usize::MAX || row[j].abs() > best.1.abs()) {
                    best = (i, row[j]);
                }
            }
            used[best.0] = true;
            ornt[j] = (best.0, if best.1 < 0.0 { -1 } else { 1 });
        }
        if used.iter().filter(|u| **u).count() != 3 {
            ornt = [(0, 1), (1, 1), (2, 1)];
        }
        // new axis o takes input axis j with ornt[j].0 == o
        let mut src_of = [0usize; 3];
        let mut flip = [false; 3];
        let mut spacing = [1.0f64; 3];
        for j in 0..3 {
            src_of[ornt[j].0] = j;
            flip[ornt[j].0] = ornt[j].1 < 0;
            spacing[ornt[j].0] = if zoom_in[j] > 0.0 { zoom_in[j] } else { 1.0 };
        }
        let in_dims = [dx, dy, dz];
        let out_dims = [in_dims[src_of[0]], in_dims[src_of[1]], in_dims[src_of[2]]];
        let in_stride = [1usize, dx, dx * dy];
        // time/extra dimensions are flattened into z after the spatial axes: z_out = z * extra + t
        let (nx, ny, nz) = (out_dims[0], out_dims[1], out_dims[2] * extra);
        let mut data = vec![0f32; nx * ny * nz];
        for t in 0..extra {
            for o2 in 0..out_dims[2] {
                for o1 in 0..out_dims[1] {
                    for o0 in 0..out_dims[0] {
                        let o = [o0, o1, o2];
                        let mut off = 0;
                        for ax in 0..3 {
                            let idx = if flip[ax] {
                                out_dims[ax] - 1 - o[ax]
                            } else {
                                o[ax]
                            };
                            off += idx * in_stride[src_of[ax]];
                        }
                        data[o0 + nx * (o1 + ny * (o2 * extra + t))] = vals[off + t * dx * dy * dz];
                    }
                }
            }
        }
        // squeeze: a singleton axis does not change the layout used below (single z frame for 2D)
        let plane = |s1: f64, s2: f64, n1: usize, n2: usize| {
            let reference = s1.min(s2);
            (
                ((n1 as f64 * s1 / reference).round()).max(1.0) as u32,
                ((n2 as f64 * s2 / reference).round()).max(1.0) as u32,
            )
        };
        let ax = plane(spacing[0], spacing[1], nx, ny);
        let cor = plane(spacing[0], spacing[2], nx, nz);
        let sag = plane(spacing[1], spacing[2], ny, nz);
        // window from a sparse sample
        let step = (data.len() / 100_000).max(1);
        let mut sample: Vec<f32> = data.iter().step_by(step).copied().collect();
        let min = sample.iter().cloned().fold(f32::INFINITY, f32::min);
        sample.retain(|v| *v > min);
        sample.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let pct = |p: f64| -> f32 {
            if sample.is_empty() {
                return 0.0;
            }
            let pos = p / 100.0 * (sample.len() - 1) as f64;
            let (lo, hi) = (pos.floor() as usize, pos.ceil() as usize);
            sample[lo] + (sample[hi] - sample[lo]) * (pos - lo as f64) as f32
        };
        let (wmin, mut wmax) = (pct(1.0), pct(99.0));
        if wmax <= wmin {
            wmax = wmin + 1.0;
        }
        Ok(Self {
            shape: (nx, ny, nz),
            data,
            spacing: (spacing[0], spacing[1], spacing[2]),
            ax,
            cor,
            sag,
            wmin,
            wmax,
        })
    }

    fn dims(&self, plane: u32) -> (u32, u32) {
        match plane {
            1 => self.cor,
            2 => self.sag,
            _ => self.ax,
        }
    }

    /// One slice at physical pixel size in radiological orientation, as RGBA:
    /// axial: Anterior at top, Right on the left; coronal: Superior at top, Right on the left;
    /// sagittal: Superior at top, Posterior on the left.
    fn render(&self, plane: u32, frame: u32) -> RgbaImage {
        let (nx, ny, nz) = self.shape;
        let at = |x: usize, y: usize, z: usize| self.data[x + nx * (y + ny * z)];
        let (w, h, f): (usize, usize, Pixel) = match plane {
            1 => {
                let y = (frame as usize).min(ny - 1);
                (nx, nz, Box::new(move |c, r| at(nx - 1 - c, y, nz - 1 - r)))
            }
            2 => {
                let x = (frame as usize).min(nx - 1);
                (ny, nz, Box::new(move |c, r| at(x, c, nz - 1 - r)))
            }
            _ => {
                let z = (frame as usize).min(nz - 1);
                (nx, ny, Box::new(move |c, r| at(nx - 1 - c, ny - 1 - r, z)))
            }
        };
        let mut img = image::GrayImage::new(w as u32, h as u32);
        for r in 0..h {
            for c in 0..w {
                let g = ((f(c, r) - self.wmin) / (self.wmax - self.wmin) * 255.0).clamp(0.0, 255.0)
                    as u8;
                img.put_pixel(c as u32, r as u32, image::Luma([g]));
            }
        }
        let want = self.dims(plane);
        let img = if (img.width(), img.height()) != want {
            image::imageops::resize(&img, want.0, want.1, image::imageops::FilterType::Lanczos3)
        } else {
            img
        };
        image::DynamicImage::ImageLuma8(img).to_rgba8()
    }

    pub fn default_frame(&self) -> u32 {
        (self.shape.2 / 2) as u32
    }
}

impl Slide for Nifti {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        vec![(self.ax.0 as u64, self.ax.1 as u64)]
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
            (
                "openslide.mpp-x".into(),
                (self.spacing.0 * 1000.0).to_string(),
            ),
            (
                "openslide.mpp-y".into(),
                (self.spacing.1 * 1000.0).to_string(),
            ),
            (
                "openslide.mpp-z".into(),
                (self.spacing.2 * 1000.0).to_string(),
            ),
            ("openslide.objective-power".into(), "1".into()),
            ("openslide.vendor".into(), "NIfTI".into()),
        ])
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
        Ok(crate::formats::crop_transparent(
            &self.render(0, frame),
            x,
            y,
            w,
            h,
        ))
    }
    fn frame_count(&self) -> u32 {
        self.shape.2 as u32
    }
    fn frame_kind(&self) -> crate::FrameKind {
        crate::FrameKind::Volume
    }
    fn frame_labels(&self) -> Vec<String> {
        self.plane_frame_descriptors(0)
    }
    fn plane_dimensions(&self, plane: u32) -> Option<(u64, u64)> {
        let d = self.dims(plane.min(2));
        Some((d.0 as u64, d.1 as u64))
    }
    fn plane_frames(&self, plane: u32) -> u32 {
        let (nx, ny, nz) = self.shape;
        [nz, ny, nx][plane.min(2) as usize] as u32
    }
    fn plane_frame_descriptors(&self, plane: u32) -> Vec<String> {
        let (nx, ny, nz) = self.shape;
        let (label, n, sp) = match plane {
            1 => ("y", ny, self.spacing.1),
            2 => ("x", nx, self.spacing.0),
            _ => ("z", nz, self.spacing.2),
        };
        (0..n)
            .map(|i| format!("{label}={:.2} mm", i as f64 * sp))
            .collect()
    }
    fn read_region_plane(
        &self,
        x: i64,
        y: i64,
        level: usize,
        w: u32,
        h: u32,
        frame: u32,
        plane: u32,
    ) -> Result<RgbaImage> {
        if level != 0 {
            return err("Invalid level");
        }
        Ok(crate::formats::crop_transparent(
            &self.render(plane.min(2), frame),
            x,
            y,
            w,
            h,
        ))
    }
}
