//! OME-TIFF: single-series pyramids and multi-series z-stacks (one series per z plane, SubIFD levels), port of
//! `util/tiffzstack.py`. Label and thumbnail series are not part of the stack.

use crate::{
    err,
    tiff::{self, Ifd, Page, Tiff},
    Result, Slide, WsiError,
};
use image::RgbaImage;
use quick_xml::{events::Event, Reader};
use std::collections::HashMap;

struct Series {
    levels: Vec<Page>,
}

pub struct OmeTiff {
    series: Vec<Series>,
    dims: Vec<(u64, u64)>,
    /// integer downsamples as Django computes them: `width0 // width_level`
    downs: Vec<f64>,
    pub frame_descriptors: Vec<String>,
    z_positions: Option<(Vec<f64>, String)>,
    pub default_frame: u32,
    props: HashMap<String, String>,
    cache: tiff::ChunkCache,
    multi: bool,
}

#[derive(Default, Debug)]
struct ImgMeta {
    name: String,
    size_x: u64,
    size_y: u64,
    size_z: u64,
    size_c: u64,
    size_t: u64,
    phys_x: Option<f64>,
    phys_y: Option<f64>,
    pos_z: Option<String>,
    pos_z_unit: Option<String>,
    ifd: Option<u64>,
}

fn attrs(e: &quick_xml::events::BytesStart) -> HashMap<String, String> {
    e.attributes()
        .filter_map(|a| a.ok())
        .map(|a| {
            (
                a.key.as_ref().to_string(),
                a.normalized_value(quick_xml::XmlVersion::Implicit1_0)
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
            )
        })
        .collect()
}

fn parse_ome(xml: &str) -> (Vec<ImgMeta>, Option<f64>) {
    let mut r = Reader::from_str(xml);
    let (mut images, mut mag): (Vec<ImgMeta>, Option<f64>) = (Vec::new(), None);
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let name = e.local_name().as_ref().to_string();
                let a = attrs(&e);
                match name.as_str() {
                    "Image" => images.push(ImgMeta {
                        name: a.get("Name").cloned().unwrap_or_default(),
                        ..Default::default()
                    }),
                    "Pixels" => {
                        if let Some(m) = images.last_mut() {
                            let n =
                                |k: &str| a.get(k).and_then(|v| v.parse::<u64>().ok()).unwrap_or(1);
                            m.size_x = n("SizeX");
                            m.size_y = n("SizeY");
                            m.size_z = n("SizeZ");
                            m.size_c = n("SizeC");
                            m.size_t = n("SizeT");
                            m.phys_x = a.get("PhysicalSizeX").and_then(|v| v.parse().ok());
                            m.phys_y = a.get("PhysicalSizeY").and_then(|v| v.parse().ok());
                        }
                    }
                    "Plane" => {
                        if let Some(m) = images.last_mut() {
                            if m.pos_z.is_none() {
                                m.pos_z = a.get("PositionZ").cloned();
                                m.pos_z_unit = a.get("PositionZUnit").cloned();
                            }
                        }
                    }
                    "TiffData" => {
                        if let Some(m) = images.last_mut() {
                            if m.ifd.is_none() {
                                m.ifd = a.get("IFD").and_then(|v| v.parse().ok());
                            }
                        }
                    }
                    "Objective" => {
                        if let Some(v) = a
                            .get("NominalMagnification")
                            .and_then(|v| v.parse::<f64>().ok())
                        {
                            mag = Some(mag.map_or(v, |m: f64| m.max(v)));
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (images, mag)
}

/// True when the file's first ImageDescription is OME-XML.
pub fn is_ome(path: &str) -> bool {
    Tiff::open(path)
        .and_then(|t| t.first_ifd_offset().and_then(|o| t.read_ifd(o)))
        .ok()
        .and_then(|i| i.ascii(tiff::TAG_DESCRIPTION))
        .is_some_and(|d| d.contains("<OME"))
}

impl OmeTiff {
    pub fn open(path: &str) -> Result<Self> {
        let t = Tiff::open(path)?;
        let mut ifds: Vec<Ifd> = Vec::new();
        let mut off = t.first_ifd_offset()?;
        while off != 0 {
            let ifd = t.read_ifd(off)?;
            off = ifd.next;
            ifds.push(ifd);
        }
        let xml = ifds
            .first()
            .and_then(|i| i.ascii(tiff::TAG_DESCRIPTION))
            .unwrap_or_default();
        let (images, mag) = parse_ome(&xml);
        if images.is_empty() {
            return err("no OME images");
        }
        let mut series = Vec::new();
        let mut used = Vec::new();
        for (k, m) in images.iter().enumerate() {
            let lower = m.name.to_lowercase();
            if m.name.contains("Label") || m.name.contains("Thumbnail") || lower == "macro" {
                continue;
            }
            if m.size_z > 1 || m.size_c > 3 || m.size_t > 1 {
                return err("multi-plane OME images are not supported");
            }
            let ifd_no = m.ifd.unwrap_or(k as u64) as usize;
            let ifd = ifds
                .get(ifd_no)
                .ok_or_else(|| WsiError("OME image without IFD".into()))?;
            let mut levels = vec![Page::new(&t, ifd)?];
            for sub in ifd.uints(tiff::TAG_SUBIFDS).unwrap_or_default() {
                levels.push(Page::new(&t, &t.read_ifd(sub)?)?);
            }
            series.push(Series { levels });
            used.push(k);
        }
        let first = series
            .first()
            .ok_or_else(|| WsiError("no image series".into()))?;
        let dims: Vec<(u64, u64)> = first.levels.iter().map(|p| (p.width, p.height)).collect();
        let downs = dims
            .iter()
            .map(|d| (dims[0].0 / d.0.max(1)) as f64)
            .collect();
        let multi = series.len() > 1;
        let metas: Vec<&ImgMeta> = used.iter().map(|k| &images[*k]).collect();
        let frame_descriptors = if multi {
            metas
                .iter()
                .filter_map(|m| {
                    m.pos_z
                        .as_ref()
                        .map(|z| format!("z={z} {}", m.pos_z_unit.clone().unwrap_or_default()))
                })
                .collect()
        } else {
            vec![String::new()]
        };
        let z_positions = if multi {
            let z: Option<Vec<f64>> = metas
                .iter()
                .map(|m| m.pos_z.as_ref().and_then(|v| v.parse().ok()))
                .collect();
            z.map(|z| (z, metas[0].pos_z_unit.clone().unwrap_or_default()))
        } else {
            None
        };
        let default_frame = if multi {
            let z: Option<Vec<f64>> = metas
                .iter()
                .map(|m| m.pos_z.as_ref().and_then(|v| v.parse().ok()))
                .collect();
            z.and_then(|z| z.iter().position(|v| *v == 0.0))
                .unwrap_or(0) as u32
        } else {
            0
        };
        let m0 = metas[0];
        let r4 = |v: Option<f64>| (v.unwrap_or(0.0) * 1e4).round() / 1e4;
        let props = HashMap::from([
            ("openslide.background-color".into(), "000000".into()),
            ("openslide.mpp-x".into(), r4(m0.phys_x).to_string()),
            ("openslide.mpp-y".into(), r4(m0.phys_y).to_string()),
            (
                "openslide.objective-power".into(),
                mag.unwrap_or(20.0).to_string(),
            ),
            ("openslide.vendor".into(), String::new()),
        ]);
        Ok(Self {
            series,
            dims,
            downs,
            frame_descriptors,
            z_positions,
            default_frame,
            props,
            cache: tiff::ChunkCache::new(512),
            multi,
        })
    }
}

impl Slide for OmeTiff {
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
    /// `argmin(|downsamples - d|)`
    fn best_level_for_downsample(&self, d: f64) -> usize {
        let mut best = (0, f64::INFINITY);
        for (i, v) in self.downs.iter().enumerate() {
            if (v - d).abs() < best.1 {
                best = (i, (v - d).abs());
            }
        }
        best.0
    }
    fn properties(&self) -> HashMap<String, String> {
        self.props.clone()
    }
    fn frame_count(&self) -> u32 {
        self.series.len() as u32
    }
    fn frame_kind(&self) -> crate::FrameKind {
        if self.multi {
            crate::FrameKind::ZStack
        } else {
            crate::FrameKind::None
        }
    }
    fn frame_labels(&self) -> Vec<String> {
        if self.multi {
            self.frame_descriptors.clone()
        } else {
            Vec::new()
        }
    }
    fn z_positions(&self) -> Option<(Vec<f64>, String)> {
        self.z_positions.clone()
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
        let f = if self.multi { frame as usize } else { 0 };
        let s = self
            .series
            .get(f)
            .ok_or_else(|| WsiError(format!("Invalid zlevel: {frame}.")))?;
        let page = s
            .levels
            .get(level)
            .ok_or_else(|| WsiError("Invalid level.".into()))?;
        // location is in level-0 pixels; Django rounds it by the (integer) downsample
        let ds = self.downs[level];
        let (lx, ly) = (
            (x as f64 / ds).round() as i64,
            (y as f64 / ds).round() as i64,
        );
        page.read_rgba(lx, ly, w, h, &self.cache, f * 64 + level)
    }
}
