//! Slide reading and tiling: format readers behind one `Slide` trait, the DeepZoom tile generator
//! (port of `openslide.deepzoom.DeepZoomGenerator` incl. `limit_bounds`) and a slide handle cache.

pub mod deepzoom;
pub mod dicom;
pub mod formats;
pub mod generator;
pub mod generic_tiff;
pub mod mkt;
pub mod nifti;
pub mod ome;
pub mod openslide;
pub mod registration;
pub mod repair;
pub mod slideio;
pub mod tiff;
pub mod tiff_write;
#[cfg(feature = "video")]
pub mod video;

use image::RgbaImage;
use std::collections::HashMap;

#[derive(Debug)]
pub struct WsiError(pub String);

impl std::fmt::Display for WsiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for WsiError {}

pub type Result<T> = std::result::Result<T, WsiError>;

pub fn err<T>(msg: impl Into<String>) -> Result<T> {
    Err(WsiError(msg.into()))
}

/// What the frames of a slide are; decides how a viewer lets the user move through them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
    /// a single image
    None,
    /// focus planes of a microscopy z-stack: neighbouring planes are similar, a viewer can blend between them
    ZStack,
    /// slices of a radiology volume (CT, MR, NIfTI): discrete slices, no blending
    Volume,
    /// frames of a movie or a time series (MP4, AVI, Cellvizio): played along time
    TimeSeries,
}

impl FrameKind {
    pub fn as_str(self) -> &'static str {
        match self {
            FrameKind::None => "none",
            FrameKind::ZStack => "zstack",
            FrameKind::Volume => "volume",
            FrameKind::TimeSeries => "timeseries",
        }
    }
}

/// An opened slide. Mirrors the parts of `openslide.OpenSlide` that EXACT uses; levels are ordered from the
/// highest resolution (0) down. `read_region` returns straight (non-premultiplied) RGBA; pixels outside the
/// image are transparent.
pub trait Slide: Send + Sync {
    fn level_dimensions(&self) -> Vec<(u64, u64)>;
    fn level_downsamples(&self) -> Vec<f64>;
    fn best_level_for_downsample(&self, downsample: f64) -> usize;
    fn properties(&self) -> HashMap<String, String>;
    fn read_region(
        &self,
        x: i64,
        y: i64,
        level: usize,
        w: u32,
        h: u32,
        frame: u32,
    ) -> Result<RgbaImage>;
    fn frame_count(&self) -> u32 {
        1
    }
    fn frame_kind(&self) -> FrameKind {
        FrameKind::None
    }
    /// One label per frame (`z=1.20 mm`, `3.50 s (42)`, ...); empty if the format has none.
    fn frame_labels(&self) -> Vec<String> {
        Vec::new()
    }
    /// Real positions of the frames of a z-stack and their unit, when the file knows them.
    fn z_positions(&self) -> Option<(Vec<f64>, String)> {
        None
    }
    /// True for formats whose pyramid levels can be displaced against each other (seen in Zeiss CZI read through
    /// slideio); the caller then measures `registration::estimate_level_offsets` once, stores the result and hands it to
    /// `DeepZoom::build`.
    fn needs_registration(&self) -> bool {
        false
    }
    /// Problems found in the file that viewers should know about (`damaged_pyramid`: lower levels are not copies of level 0).
    fn issues(&self) -> Vec<String> {
        Vec::new()
    }
    /// Volumetric readers (NIfTI) can show the axial (0), coronal (1) and sagittal (2) reformat; `None` = no planes.
    fn plane_dimensions(&self, _plane: u32) -> Option<(u64, u64)> {
        None
    }
    /// Number of slices along the normal axis of the plane.
    fn plane_frames(&self, _plane: u32) -> u32 {
        1
    }
    fn plane_frame_descriptors(&self, _plane: u32) -> Vec<String> {
        Vec::new()
    }
    #[allow(clippy::too_many_arguments)]
    fn read_region_plane(
        &self,
        x: i64,
        y: i64,
        level: usize,
        w: u32,
        h: u32,
        frame: u32,
        _plane: u32,
    ) -> Result<RgbaImage> {
        self.read_region(x, y, level, w, h, frame)
    }
}

pub trait SlideExt: Slide {
    fn level_count(&self) -> usize {
        self.level_dimensions().len()
    }
    fn dimensions(&self) -> (u64, u64) {
        self.level_dimensions()[0]
    }
    /// `OpenSlide.get_thumbnail`: smallest suitable level, composited on the background, Lanczos-reduced to fit.
    fn thumbnail(&self, size: (u32, u32)) -> Result<image::RgbImage> {
        let (w, h) = self.dimensions();
        let ds = (w as f64 / size.0 as f64).max(h as f64 / size.1 as f64);
        let level = self.best_level_for_downsample(ds);
        let (lw, lh) = self.level_dimensions()[level];
        let tile = self.read_region(0, 0, level, lw as u32, lh as u32, 0)?;
        let bg = background(&self.properties());
        let rgb = composite(&tile, bg);
        let (tw, th) = fit(rgb.width(), rgb.height(), size.0, size.1);
        if (tw, th) == (rgb.width(), rgb.height()) {
            return Ok(rgb);
        }
        Ok(image::imageops::resize(
            &rgb,
            tw,
            th,
            image::imageops::FilterType::Lanczos3,
        ))
    }
}
impl<T: Slide + ?Sized> SlideExt for T {}

/// PIL `Image.thumbnail` size rule: keep the aspect ratio, never enlarge.
pub fn fit(w: u32, h: u32, mw: u32, mh: u32) -> (u32, u32) {
    if w <= mw && h <= mh {
        return (w, h);
    }
    let (fw, fh) = (mw as f64 / w as f64, mh as f64 / h as f64);
    if fw < fh {
        (mw, ((h as f64 * fw).round() as u32).max(1))
    } else {
        (((w as f64 * fh).round() as u32).max(1), mh)
    }
}

pub fn background(props: &HashMap<String, String>) -> [u8; 3] {
    props
        .get("openslide.background-color")
        .and_then(|s| u32::from_str_radix(s.trim_start_matches('#'), 16).ok())
        .map_or([255, 255, 255], |v| {
            [(v >> 16) as u8, (v >> 8) as u8, v as u8]
        })
}

/// Alpha-composites onto a solid background (`Image.composite(tile, bg, tile)`).
pub fn composite(tile: &RgbaImage, bg: [u8; 3]) -> image::RgbImage {
    let mut out = image::RgbImage::new(tile.width(), tile.height());
    for (o, p) in out.pixels_mut().zip(tile.pixels()) {
        let a = p[3] as u32;
        for c in 0..3 {
            o[c] = ((p[c] as u32 * a + bg[c] as u32 * (255 - a) + 127) / 255) as u8;
        }
    }
    out
}
