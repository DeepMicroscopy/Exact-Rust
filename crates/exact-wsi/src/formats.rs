//! Format detection (port of `getSlideHandler`) and the readers that are not OpenSlide.

use crate::{err, openslide, Result, Slide, WsiError};
use image::{GenericImageView, RgbaImage};
use moka::sync::Cache;
use std::{collections::HashMap, io::Read, path::Path, sync::Arc};

/// A single-level raster image (JPEG, PNG, TIFF without vendor metadata).
pub struct PlainImage {
    img: RgbaImage,
}

impl PlainImage {
    pub fn open(path: &str) -> Result<Self> {
        let img = image::open(path)
            .map_err(|e| WsiError(e.to_string()))?
            .to_rgba8();
        Ok(Self { img })
    }
}

impl Slide for PlainImage {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        vec![(self.img.width() as u64, self.img.height() as u64)]
    }
    fn level_downsamples(&self) -> Vec<f64> {
        vec![1.0]
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
        _frame: u32,
    ) -> Result<RgbaImage> {
        if level != 0 {
            return err("Invalid level");
        }
        Ok(crop_transparent(&self.img, x, y, w, h))
    }
}

/// Region of `src` at (x, y); everything outside the source stays transparent.
pub fn crop_transparent(src: &RgbaImage, x: i64, y: i64, w: u32, h: u32) -> RgbaImage {
    let mut out = RgbaImage::new(w, h);
    let (sw, sh) = (src.width() as i64, src.height() as i64);
    let (x0, y0) = (x.max(0), y.max(0));
    let (x1, y1) = ((x + w as i64).min(sw), (y + h as i64).min(sh));
    if x1 <= x0 || y1 <= y0 {
        return out;
    }
    let view = src.view(x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32);
    image::imageops::replace(&mut out, &view.to_image(), x0 - x, y0 - y);
    out
}

fn magic_at(f: &mut std::fs::File, off: u64) -> [u8; 4] {
    use std::io::{Seek, SeekFrom};
    let mut b = [0u8; 4];
    if f.seek(SeekFrom::Start(off)).is_ok() {
        let _ = f.read_exact(&mut b);
    }
    b
}

/// Classic TIFF and BigTIFF, little ('II') and big endian ('MM'). Big-endian files exist in the wild (a Bio-Formats
/// OME-TIFF in the test data) and were once served from a single level, decoding the whole image for every thumbnail.
pub fn is_tiff_magic(head: [u8; 4]) -> bool {
    matches!(
        head,
        [0x49, 0x49, 0x2a, 0]
            | [0x49, 0x49, 0x2b, 0]
            | [0x4d, 0x4d, 0, 0x2a]
            | [0x4d, 0x4d, 0, 0x2b]
    )
}

/// Opens a slide file of any supported format.
pub fn open(path: &str) -> Result<Arc<dyn Slide>> {
    open_with(path, false)
}

/// `light`: for one look (a thumbnail): a single OpenSlide handle instead of a pool of several.
fn open_with(path: &str, light: bool) -> Result<Arc<dyn Slide>> {
    let pool = |p: &str| -> Result<Arc<dyn Slide>> {
        Ok(Arc::new(if light {
            openslide::OpenSlidePool::open_single(p)?
        } else {
            openslide::OpenSlidePool::open(p)?
        }))
    };
    let mut f = std::fs::File::open(path).map_err(|e| WsiError(format!("{path}: {e}")))?;
    let head = magic_at(&mut f, 0);
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let tiff = is_tiff_magic(head);
    let mut nifti_error: Option<WsiError> = None;
    if (head[..2] == [0x1f, 0x8b] && (ext == "gz" || ext == "nii")) || ext == "nii" {
        match crate::nifti::Nifti::open(path) {
            Ok(n) => return Ok(Arc::new(n)),
            // kept: if nothing else reads the file, this is the reason to report, not "no reader"
            Err(e) => nifti_error = Some(e),
        }
    }
    #[cfg(feature = "video")]
    if matches!(ext.as_str(), "mp4" | "avi") || magic_at(&mut f, 4) == *b"ftyp" || head == *b"RIFF"
    {
        if let Ok(v) = crate::video::Video::open(path) {
            return Ok(Arc::new(v));
        }
    }
    if head == *b"\n<CS" || ext == "mkt" {
        if let Ok(m) = crate::mkt::Mkt::open(path) {
            return Ok(Arc::new(m));
        }
    }
    let dicom_file = magic_at(&mut f, 128) == *b"DICM";
    if dicom_file || ext == "dcm" {
        // uncompressed volumes natively; compressed and whole-slide DICOM fall through to slideio
        if let Ok(d) = crate::dicom::DicomVolume::open(path) {
            return Ok(Arc::new(d));
        }
    }
    // formats only slideio reads: Zeiss CZI, Olympus VSI, DICOM (decided by magic number or extension like Django)
    let dicom = dicom_file;
    if (head == *b"ZISR" || ext == "czi" || ext == "vsi" || ext == "dcm" || dicom)
        && crate::slideio::available()
    {
        return Ok(Arc::new(crate::slideio::SlideIo::open(path)?));
    }
    if tiff && crate::ome::is_ome(path) {
        if let Ok(o) = crate::ome::OmeTiff::open(path) {
            return Ok(Arc::new(o));
        }
    }
    // plain pyramidal TIFF (libvips, ImageMagick, ...): own reader, see generic_tiff.rs
    if tiff && openslide::detect_vendor(path).as_deref() == Some("generic-tiff") {
        if let Ok(g) = crate::generic_tiff::GenericTiff::open(path) {
            return Ok(Arc::new(g));
        }
    }
    // vendor formats (SVS, NDPI, MRXS, Ventana, Leica, DICOM, generic pyramidal TIFF, ...)
    if openslide::available() && openslide::detect_vendor(path).is_some() {
        return pool(path);
    }
    if matches!(head, [0xff, 0xd8, 0xff, _] | [0x89, b'P', b'N', b'G']) || (tiff && ext != "ndpi") {
        return Ok(Arc::new(PlainImage::open(path)?));
    }
    if openslide::available() {
        if let Ok(s) = pool(path) {
            return Ok(s);
        }
    }
    if let Some(e) = nifti_error {
        return err(format!("{path}: NIfTI: {e}"));
    }
    err(format!("no reader for {path}"))
}

/// Slide handle cache (replaces `SlideCache`): bounded, shared between requests.
#[derive(Clone)]
pub struct SlideCache(Cache<String, Arc<dyn Slide>>);

impl SlideCache {
    pub fn new(capacity: u64) -> Self {
        Self(Cache::new(capacity))
    }

    /// Forgets a slide, e.g. after its file was replaced.
    pub fn invalidate(&self, path: &str) {
        self.0.invalidate(path);
    }

    /// For a single look (a thumbnail): the cached slide if it is open anyway, else a lightly opened one that is not kept, so that
    /// browsing many slides does not push the ones being viewed out of the cache. Blocking.
    pub fn get_light(&self, path: &str) -> Result<Arc<dyn Slide>> {
        if let Some(s) = self.0.get(path) {
            return Ok(s);
        }
        open_with(path, true)
    }

    /// Blocking: call from `spawn_blocking`.
    pub fn get(&self, path: &str) -> Result<Arc<dyn Slide>> {
        if let Some(s) = self.0.get(path) {
            return Ok(s);
        }
        let s = open(path)?;
        self.0.insert(path.to_string(), s.clone());
        Ok(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tiff_magic_covers_both_byte_orders_and_bigtiff() {
        assert!(is_tiff_magic(*b"II*\0"));
        assert!(is_tiff_magic(*b"II+\0"));
        assert!(is_tiff_magic([0x4d, 0x4d, 0, 0x2a]));
        assert!(is_tiff_magic([0x4d, 0x4d, 0, 0x2b]));
        assert!(!is_tiff_magic(*b"\x89PNG"));
    }
}
