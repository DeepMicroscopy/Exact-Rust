//! Zeiss CZI (ZEN), read natively.
//!
//! Written from the file layout that slideio's BSD-3 driver (`src/slideio/drivers/czi`) and libCZI document, and checked against
//! slideio on real files. A CZI is a sequence of segments (a 32-byte header with a name and sizes, then the content): the file
//! header, a directory of all sub-blocks, the metadata XML, the sub-blocks (tiles of the mosaic, with the pixels), and attachments
//! (the label, a preview of the slide, a thumbnail). A slide scanner writes the scene as a mosaic of 1600 x 1200 tiles at full
//! resolution, which overlap and sit anywhere (the directory gives their position), plus pyramid tiles of every second, fourth, ...
//! resolution; the tiles are JPEG XR compressed (pure Rust decoder, bit-identical to Microsoft's jxrlib).
//!
//! What this reader does not know is an error from `open`, and the caller falls back to slideio: z-stacks, time series, several
//! channels, 16-bit main images, other compressions (JPEG, LZW, Zstd), tiles that do not fit the pyramid.

use crate::{err, Result, Slide, WsiError};
use image::RgbaImage;
use std::{
    collections::HashMap,
    fs::File,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
};

// ---------------------------------------------------------------------------------------------------------------------
// the file
// ---------------------------------------------------------------------------------------------------------------------

/// A CZI stream inside a file: the file itself, or one embedded as an attachment (positions are relative to its start).
struct Source {
    file: Arc<File>,
    base: u64,
}

#[cfg(unix)]
fn read_exact_at(f: &File, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(f, buf, offset)
}
#[cfg(windows)]
fn read_exact_at(f: &File, mut buf: &mut [u8], mut offset: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        let n = std::os::windows::fs::FileExt::seek_read(f, buf, offset)?;
        if n == 0 {
            return Err(std::io::ErrorKind::UnexpectedEof.into());
        }
        buf = &mut buf[n..];
        offset += n as u64;
    }
    Ok(())
}

impl Source {
    fn read(&self, pos: u64, len: usize) -> Result<Vec<u8>> {
        let mut buf = vec![0u8; len];
        read_exact_at(&self.file, &mut buf, self.base + pos)
            .map_err(|e| WsiError(format!("CZI: cannot read {len} bytes at {pos}: {e}")))?;
        Ok(buf)
    }
}

fn le_i32(b: &[u8], o: usize) -> i32 {
    i32::from_le_bytes(b[o..o + 4].try_into().expect("4 bytes"))
}
fn le_i64(b: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(b[o..o + 8].try_into().expect("8 bytes"))
}
fn le_f32(b: &[u8], o: usize) -> f32 {
    f32::from_le_bytes(b[o..o + 4].try_into().expect("4 bytes"))
}

/// The name and the used size of the segment at `pos`.
fn segment(src: &Source, pos: u64) -> Result<(String, u64)> {
    let h = src.read(pos, 32)?;
    let name = String::from_utf8_lossy(&h[..16])
        .trim_end_matches('\0')
        .to_string();
    Ok((name, le_i64(&h, 24) as u64))
}

// ---------------------------------------------------------------------------------------------------------------------
// the directory of sub-blocks
// ---------------------------------------------------------------------------------------------------------------------

const PIXEL_GRAY8: i32 = 0;
const PIXEL_GRAY16: i32 = 1;
const PIXEL_BGR24: i32 = 3;
const PIXEL_BGR48: i32 = 4;
const COMPRESSION_NONE: i32 = 0;
const COMPRESSION_JXR: i32 = 4;

/// A tile of the mosaic, at one resolution.
#[derive(Clone)]
struct Block {
    /// position of the tile in the pixels of the file's coordinate system (resolution 1)
    x: i32,
    y: i32,
    /// pixels stored
    w: u32,
    h: u32,
    /// how many pixels of the full resolution one stored pixel covers (1, 2, 4, ...)
    ratio: u32,
    /// the sub-block segment, relative to the stream
    position: u64,
    compression: i32,
    pixel_type: i32,
}

struct Directory {
    blocks: Vec<Block>,
    pixel_type: i32,
}

/// The scene to read is the first (lowest `S`); dimensions this reader does not serve are refused.
fn parse_directory(data: &[u8], count: usize) -> Result<Directory> {
    struct Raw {
        block: Block,
        scene: i32,
    }
    let mut raws: Vec<Raw> = Vec::with_capacity(count);
    let mut pos = 0usize;
    for _ in 0..count {
        if pos + 32 > data.len() || &data[pos..pos + 2] != b"DV" {
            return err("CZI: the directory is damaged");
        }
        let (pixel_type, position, compression) = (
            le_i32(data, pos + 2),
            le_i64(data, pos + 6),
            le_i32(data, pos + 18),
        );
        let dims = le_i32(data, pos + 28);
        if !(2..=32).contains(&dims) || pos + 32 + 20 * dims as usize > data.len() {
            return err("CZI: the directory is damaged");
        }
        let (mut x, mut y, mut w, mut h, mut size_x, mut size_y) = (0, 0, 0u32, 0u32, 0, 0);
        let mut scene = 0;
        for k in 0..dims as usize {
            let o = pos + 32 + 20 * k;
            let name = &data[o..o + 4];
            let (start, size, stored) = (
                le_i32(data, o + 4),
                le_i32(data, o + 8),
                le_i32(data, o + 16),
            );
            let _ = le_f32(data, o + 12);
            match name[0] {
                b'X' => (x, size_x, w) = (start, size, stored.max(0) as u32),
                b'Y' => (y, size_y, h) = (start, size, stored.max(0) as u32),
                b'S' => scene = start,
                // the mosaic index orders the tiles; a single channel, plane and time point is all that is read
                b'M' => {}
                b'C' | b'Z' | b'T' => {
                    if start != 0 || size != 1 {
                        return err(
                            "CZI: several channels, planes or time points are not read natively",
                        );
                    }
                }
                _ => {
                    if start != 0 || size != 1 {
                        return err("CZI: unknown dimensions are not read natively");
                    }
                }
            }
        }
        pos += 32 + 20 * dims as usize;
        if w == 0 || h == 0 || size_x <= 0 || size_y <= 0 {
            return err("CZI: a tile has no size");
        }
        let ratio = (size_x as f64 / w as f64).round() as u32;
        if ratio == 0
            || ratio > 1 << 16
            || (size_x as f64 / ratio as f64 - w as f64).abs() >= 1.0
            || (size_y as f64 / ratio as f64 - h as f64).abs() >= 1.0
        {
            return err("CZI: a tile does not fit the pyramid");
        }
        raws.push(Raw {
            block: Block {
                x,
                y,
                w,
                h,
                ratio,
                position: position as u64,
                compression,
                pixel_type,
            },
            scene,
        });
    }
    let first = raws
        .iter()
        .map(|r| r.scene)
        .min()
        .ok_or_else(|| WsiError("CZI: no tiles".into()))?;
    let blocks: Vec<Block> = raws
        .into_iter()
        .filter(|r| r.scene == first)
        .map(|r| r.block)
        .collect();
    let pixel_type = blocks[0].pixel_type;
    if blocks.iter().any(|b| b.pixel_type != pixel_type) {
        return err("CZI: tiles of different pixel types");
    }
    Ok(Directory { blocks, pixel_type })
}

// ---------------------------------------------------------------------------------------------------------------------
// an image: the tiles of one scene, by resolution
// ---------------------------------------------------------------------------------------------------------------------

const GRID_CELL: i64 = 2048;

struct Level {
    ratio: u32,
    size: (u64, u64),
    /// block indices in the order of the directory (later ones are drawn over earlier ones)
    blocks: Vec<u32>,
    /// level pixel cell -> block indices
    grid: HashMap<(i64, i64), Vec<u32>>,
    /// level pixel rectangle of each block of `blocks`: x, y
    rects: HashMap<u32, (i64, i64)>,
}

struct Image {
    id: u64,
    src: Arc<Source>,
    blocks: Vec<Block>,
    levels: Vec<Level>,
    pixel_type: i32,
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

type BlockKey = (u64, u32);
fn block_cache() -> &'static moka::sync::Cache<BlockKey, Arc<Vec<u8>>> {
    static CACHE: OnceLock<moka::sync::Cache<BlockKey, Arc<Vec<u8>>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mb = std::env::var("EXACT_CZI_CACHE_MB")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(384);
        moka::sync::Cache::builder()
            .max_capacity(mb << 20)
            .weigher(|_, v: &Arc<Vec<u8>>| v.len().min(u32::MAX as usize) as u32)
            .build()
    })
}

impl Image {
    /// `any_depth`: also 16-bit pixels (the label and the preview of a slide).
    fn open(src: Arc<Source>, any_depth: bool) -> Result<Self> {
        let head = src.read(0, 32 + 80)?;
        if &head[..10] != b"ZISRAWFILE" {
            return err("CZI: not a CZI file");
        }
        let directory_pos = le_i64(&head, 32 + 52) as u64;
        let (name, used) = segment(&src, directory_pos)?;
        if name != "ZISRAWDIRECTORY" || !(128..1 << 31).contains(&used) {
            return err("CZI: no directory");
        }
        let body = src.read(directory_pos + 32, used as usize)?;
        let count = le_i32(&body, 0).max(0) as usize;
        let dir = parse_directory(&body[128..], count)?;
        let ok_type = if any_depth {
            matches!(
                dir.pixel_type,
                PIXEL_GRAY8 | PIXEL_BGR24 | PIXEL_GRAY16 | PIXEL_BGR48
            )
        } else {
            matches!(dir.pixel_type, PIXEL_GRAY8 | PIXEL_BGR24)
        };
        if !ok_type {
            return err(format!(
                "CZI: pixel type {} is not read natively",
                dir.pixel_type
            ));
        }
        if dir
            .blocks
            .iter()
            .any(|b| !matches!(b.compression, COMPRESSION_NONE | COMPRESSION_JXR))
        {
            return err("CZI: only uncompressed and JPEG XR tiles are read natively");
        }
        // the scene: the box of the tiles at full resolution
        let full: Vec<&Block> = dir.blocks.iter().filter(|b| b.ratio == 1).collect();
        if full.is_empty() {
            return err("CZI: no tiles at full resolution");
        }
        let x0 = full.iter().map(|b| b.x).min().expect("not empty");
        let y0 = full.iter().map(|b| b.y).min().expect("not empty");
        let x1 = full
            .iter()
            .map(|b| b.x as i64 + b.w as i64)
            .max()
            .expect("not empty");
        let y1 = full
            .iter()
            .map(|b| b.y as i64 + b.h as i64)
            .max()
            .expect("not empty");
        let (width, height) = ((x1 - x0 as i64) as u64, (y1 - y0 as i64) as u64);
        let mut ratios: Vec<u32> = dir.blocks.iter().map(|b| b.ratio).collect();
        ratios.sort_unstable();
        ratios.dedup();
        if ratios.len() > 40 {
            return err("CZI: unusual pyramid");
        }
        let mut levels = Vec::with_capacity(ratios.len());
        for &ratio in &ratios {
            let zoom = 1.0 / ratio as f64;
            let mut level = Level {
                ratio,
                size: (
                    ((width as f64) * zoom).round() as u64,
                    ((height as f64) * zoom).round() as u64,
                ),
                blocks: vec![],
                grid: HashMap::new(),
                rects: HashMap::new(),
            };
            for (i, b) in dir
                .blocks
                .iter()
                .enumerate()
                .filter(|(_, b)| b.ratio == ratio)
            {
                let (lx, ly) = (
                    (zoom * (b.x as i64 - x0 as i64) as f64).round() as i64,
                    (zoom * (b.y as i64 - y0 as i64) as f64).round() as i64,
                );
                level.blocks.push(i as u32);
                level.rects.insert(i as u32, (lx, ly));
                for cy in lx_cell(ly)..=lx_cell(ly + b.h as i64 - 1) {
                    for cx in lx_cell(lx)..=lx_cell(lx + b.w as i64 - 1) {
                        level.grid.entry((cx, cy)).or_default().push(i as u32);
                    }
                }
            }
            levels.push(level);
        }
        Ok(Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            src,
            blocks: dir.blocks,
            levels,
            pixel_type: dir.pixel_type,
        })
    }

    /// The pixels of a tile as `w * h * 3` RGB bytes (16-bit data as `w * h * 3` little-endian words, see `raw16`).
    fn block_rgb(&self, index: u32) -> Result<Arc<Vec<u8>>> {
        let key = (self.id, index);
        block_cache()
            .try_get_with(key, || self.decode_block(index).map(Arc::new))
            .map_err(|e| WsiError(e.to_string()))
    }

    fn block_raw(&self, b: &Block) -> Result<Vec<u8>> {
        // the sub-block segment: header, sizes, the directory entry again (at least 256 bytes with the sizes), metadata, data
        let head = self.src.read(b.position, 32 + 48)?;
        if &head[..13] != b"ZISRAWSUBBLOC" {
            return err("CZI: a tile is not where the directory says");
        }
        let (meta, data_size) = (
            le_i32(&head, 32).max(0) as u64,
            le_i64(&head, 40).max(0) as u64,
        );
        let entry = self.src.read(b.position + 32 + 16, 32)?;
        let dims = le_i32(&entry, 28).max(0) as u64;
        let fixed = 256.max(16 + 32 + 20 * dims);
        if data_size == 0 || data_size > 1 << 30 {
            return err("CZI: bad tile size");
        }
        self.src
            .read(b.position + 32 + fixed + meta, data_size as usize)
    }

    fn decode_block(&self, index: u32) -> Result<Vec<u8>> {
        let b = &self.blocks[index as usize];
        let raw = self.block_raw(b)?;
        let (w, h) = (b.w as usize, b.h as usize);
        let pixels = w * h;
        // rgb: 3 bytes a pixel
        match (b.compression, b.pixel_type) {
            (COMPRESSION_NONE, PIXEL_BGR24) => {
                if raw.len() < pixels * 3 {
                    return err("CZI: short tile");
                }
                let mut out = vec![0u8; pixels * 3];
                for (o, i) in out
                    .as_chunks_mut::<3>()
                    .0
                    .iter_mut()
                    .zip(raw.as_chunks::<3>().0)
                {
                    *o = [i[2], i[1], i[0]];
                }
                Ok(out)
            }
            (COMPRESSION_NONE, PIXEL_GRAY8) => {
                if raw.len() < pixels {
                    return err("CZI: short tile");
                }
                Ok(raw[..pixels].iter().flat_map(|v| [*v, *v, *v]).collect())
            }
            (COMPRESSION_NONE, PIXEL_BGR48) | (COMPRESSION_NONE, PIXEL_GRAY16) => {
                // 16-bit words as they are (little endian); `Image::normalised` makes 8-bit of them
                let words = pixels * if b.pixel_type == PIXEL_BGR48 { 3 } else { 1 };
                if raw.len() < words * 2 {
                    return err("CZI: short tile");
                }
                Ok(raw[..words * 2].to_vec())
            }
            (COMPRESSION_JXR, PIXEL_BGR24 | PIXEL_GRAY8) => {
                let img = openreadout_jpegxr::decode(&raw, 1 << 30)
                    .map_err(|e| WsiError(format!("CZI: JPEG XR tile: {e:?}")))?;
                if img.width as usize != w
                    || img.height as usize != h
                    || img.sample != openreadout_jpegxr::SampleType::U8
                {
                    return err("CZI: a decoded tile is not of the stored size");
                }
                match img.channels {
                    3 => {
                        // the decoder hands out the samples in the order of the file (blue first for Bgr24)
                        let mut out = img.data;
                        if img.bgr {
                            for p in out.as_chunks_mut::<3>().0 {
                                p.swap(0, 2);
                            }
                        }
                        Ok(out)
                    }
                    1 => Ok(img.data.iter().flat_map(|v| [*v, *v, *v]).collect()),
                    _ => err("CZI: unusual JPEG XR channels"),
                }
            }
            _ => err("CZI: pixel type and compression are not read natively"),
        }
    }

    /// Region of a level in level pixels as straight RGBA; transparent where no tile covers it.
    fn read(&self, level: usize, x: i64, y: i64, w: u32, h: u32) -> Result<RgbaImage> {
        let mut out = RgbaImage::new(w, h);
        let lv = &self.levels[level];
        let (x0, y0) = (x.max(0), y.max(0));
        let (x1, y1) = (
            (x + w as i64).min(lv.size.0 as i64),
            (y + h as i64).min(lv.size.1 as i64),
        );
        if x1 <= x0 || y1 <= y0 {
            return Ok(out);
        }
        let mut wanted: Vec<u32> = vec![];
        for cy in lx_cell(y0)..=lx_cell(y1 - 1) {
            for cx in lx_cell(x0)..=lx_cell(x1 - 1) {
                if let Some(v) = lv.grid.get(&(cx, cy)) {
                    wanted.extend(v);
                }
            }
        }
        // the order of the directory: later tiles are drawn over earlier ones, as slideio does
        wanted.sort_unstable();
        wanted.dedup();
        for index in wanted {
            let b = &self.blocks[index as usize];
            let (bx, by) = lv.rects[&index];
            let (ix0, iy0) = (x0.max(bx), y0.max(by));
            let (ix1, iy1) = (x1.min(bx + b.w as i64), y1.min(by + b.h as i64));
            if ix1 <= ix0 || iy1 <= iy0 {
                continue;
            }
            let px = self.block_rgb(index)?;
            if px.len() != b.w as usize * b.h as usize * 3 {
                return err("CZI: this tile is not 8-bit");
            }
            for yy in iy0..iy1 {
                let row = ((yy - by) * b.w as i64) as usize;
                for xx in ix0..ix1 {
                    let o = (row + (xx - bx) as usize) * 3;
                    out.put_pixel(
                        (xx - x) as u32,
                        (yy - y) as u32,
                        image::Rgba([px[o], px[o + 1], px[o + 2], 255]),
                    );
                }
            }
        }
        Ok(out)
    }

    /// The whole image at a level as RGB8; 16-bit data is scaled so that its largest value is 255 (as the helper did).
    fn whole(&self, level: usize) -> Result<image::RgbImage> {
        let lv = &self.levels[level];
        let (w, h) = (lv.size.0 as u32, lv.size.1 as u32);
        if matches!(self.pixel_type, PIXEL_BGR48 | PIXEL_GRAY16) {
            let mut rgb = vec![0u32; w as usize * h as usize * 3];
            let mut max = 1u32;
            for &index in &lv.blocks {
                let b = &self.blocks[index as usize];
                let (bx, by) = lv.rects[&index];
                let raw = self.block_rgb(index)?;
                let comps = if self.pixel_type == PIXEL_BGR48 { 3 } else { 1 };
                for yy in 0..b.h as i64 {
                    for xx in 0..b.w as i64 {
                        let (px, py) = (bx + xx, by + yy);
                        if px < 0 || py < 0 || px >= w as i64 || py >= h as i64 {
                            continue;
                        }
                        let o = ((yy * b.w as i64 + xx) as usize) * comps * 2;
                        let word = |k: usize| {
                            u16::from_le_bytes([raw[o + 2 * k], raw[o + 2 * k + 1]]) as u32
                        };
                        let v = if comps == 3 {
                            [word(2), word(1), word(0)]
                        } else {
                            [word(0); 3]
                        };
                        max = max.max(v[0]).max(v[1]).max(v[2]);
                        let d = ((py as usize) * w as usize + px as usize) * 3;
                        rgb[d..d + 3].copy_from_slice(&v);
                    }
                }
            }
            let bytes: Vec<u8> = rgb
                .iter()
                .map(|v| (*v as f64 * 255.0 / max as f64) as u8)
                .collect();
            return image::RgbImage::from_raw(w, h, bytes)
                .ok_or_else(|| WsiError("CZI: bad image size".into()));
        }
        let rgba = self.read(level, 0, 0, w, h)?;
        Ok(crate::composite(&rgba, [255, 255, 255]))
    }
}

fn lx_cell(v: i64) -> i64 {
    v.div_euclid(GRID_CELL)
}

// ---------------------------------------------------------------------------------------------------------------------
// the slide
// ---------------------------------------------------------------------------------------------------------------------

/// A picture stored in the file next to the scan.
struct Attachment {
    name: String,
    /// `CZI` or `JPG`
    kind: String,
    position: u64,
}

fn attachments(src: &Source) -> Vec<Attachment> {
    let read = || -> Result<Vec<Attachment>> {
        let head = src.read(32, 80)?;
        let pos = le_i64(&head, 72);
        if pos <= 0 {
            return Ok(vec![]);
        }
        let (name, _) = segment(src, pos as u64)?;
        if name != "ZISRAWATTDIR" {
            return Ok(vec![]);
        }
        let body = src.read(pos as u64 + 32, 256 + 128 * 64)?;
        let n = le_i32(&body, 0).clamp(0, 64) as usize;
        let mut out = vec![];
        for i in 0..n {
            let e = &body[256 + 128 * i..256 + 128 * (i + 1)];
            let text = |a: usize, b: usize| {
                String::from_utf8_lossy(&e[a..b])
                    .trim_end_matches('\0')
                    .to_string()
            };
            out.push(Attachment {
                name: text(48, 128),
                kind: text(40, 48),
                position: le_i64(e, 12) as u64,
            });
        }
        Ok(out)
    };
    read()
        .unwrap_or_default()
        .into_iter()
        .filter(|a| a.kind == "CZI" || a.kind == "JPG")
        .collect()
}

fn between<'a>(xml: &'a str, after: &str, tag: &str) -> Option<&'a str> {
    let from = xml.find(after)? + after.len();
    let rest = &xml[from..];
    let open = rest.find(&format!("<{tag}>"))? + tag.len() + 2;
    let close = rest[open..].find(&format!("</{tag}>"))?;
    Some(rest[open..open + close].trim())
}

pub struct Czi {
    main: Image,
    props: HashMap<String, String>,
    aux: Vec<Attachment>,
    file: Arc<File>,
    /// embedded CZIs opened for `associated_image`, by attachment position
    embedded: std::sync::Mutex<HashMap<u64, Arc<Image>>>,
}

impl Czi {
    pub fn open(path: &str) -> Result<Self> {
        let file = Arc::new(File::open(path).map_err(|e| WsiError(format!("{path}: {e}")))?);
        let src = Arc::new(Source {
            file: file.clone(),
            base: 0,
        });
        let main = Image::open(src.clone(), false)?;
        if main.levels[0].ratio != 1 {
            return err("CZI: no full resolution");
        }
        let (mpp, magnification) = metadata(&src).unwrap_or((0.0, 0.0));
        let mut props = HashMap::new();
        // brightfield (RGB) has a light background, fluorescence (gray) a dark one
        props.insert(
            "openslide.background-color".to_string(),
            if main.pixel_type == PIXEL_BGR24 {
                "FFFFFF"
            } else {
                "000000"
            }
            .to_string(),
        );
        props.insert("openslide.mpp-x".into(), mpp.to_string());
        props.insert("openslide.mpp-y".into(), mpp.to_string());
        props.insert(
            "openslide.objective-power".into(),
            magnification.to_string(),
        );
        props.insert("openslide.vendor".into(), "zeiss-czi".into());
        Ok(Self {
            main,
            props,
            aux: attachments(&src),
            file,
            embedded: Default::default(),
        })
    }
}

/// Pixel size in micrometres (X; Y when X is missing) and the nominal magnification of the objective.
fn metadata(src: &Source) -> Result<(f64, f64)> {
    let head = src.read(32, 80)?;
    let pos = le_i64(&head, 60) as u64;
    let (name, _) = segment(src, pos)?;
    if name != "ZISRAWMETADATA" {
        return err("CZI: no metadata");
    }
    let sizes = src.read(pos + 32, 8)?;
    let xml_size = le_i32(&sizes, 0).clamp(0, 64 << 20) as usize;
    let xml = String::from_utf8_lossy(&src.read(pos + 32 + 256, xml_size)?).to_string();
    let scale = |axis: &str| {
        between(&xml, &format!("<Distance Id=\"{axis}\">"), "Value")
            .and_then(|v| v.parse::<f64>().ok())
    };
    let mpp = scale("X").or_else(|| scale("Y")).unwrap_or(0.0) * 1e6;
    let mag = between(&xml, "<Objectives>", "NominalMagnification")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    Ok((mpp, mag))
}

impl Slide for Czi {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        self.main.levels.iter().map(|l| l.size).collect()
    }
    fn level_downsamples(&self) -> Vec<f64> {
        self.main.levels.iter().map(|l| l.ratio as f64).collect()
    }
    fn best_level_for_downsample(&self, d: f64) -> usize {
        self.main
            .levels
            .iter()
            .enumerate()
            .min_by(|a, b| {
                let da = (a.1.ratio as f64 - d).abs();
                let db = (b.1.ratio as f64 - d).abs();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .map_or(0, |(i, _)| i)
    }
    fn properties(&self) -> HashMap<String, String> {
        self.props.clone()
    }
    /// The pyramid tiles are placed by rounding the position of each to a pixel of its level, so the levels are shifted against each
    /// other by up to a pixel (measured: the same offsets as through slideio); the DeepZoom code measures them once and stores them.
    fn needs_registration(&self) -> bool {
        true
    }
    fn associated_images(&self) -> Vec<String> {
        self.aux.iter().map(|a| a.name.clone()).collect()
    }
    fn associated_image(&self, name: &str) -> Result<image::RgbImage> {
        let att = self
            .aux
            .iter()
            .find(|a| a.name == name)
            .ok_or_else(|| WsiError("no such associated image".into()))?;
        let src = Arc::new(Source {
            file: self.file.clone(),
            base: 0,
        });
        // the attachment segment: header (32), 256 bytes of sizes and its entry, then the data
        let head = src.read(att.position + 32, 4)?;
        let size = le_i32(&head, 0).max(0) as u64;
        let data = att.position + 32 + 256;
        if att.kind == "JPG" {
            let bytes = src.read(data, size as usize)?;
            let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg)
                .map_err(|e| WsiError(format!("CZI: thumbnail: {e}")))?;
            return Ok(img.to_rgb8());
        }
        let embedded = {
            let mut cache = self.embedded.lock().unwrap_or_else(|e| e.into_inner());
            match cache.get(&att.position) {
                Some(i) => i.clone(),
                None => {
                    let inner = Arc::new(Source {
                        file: self.file.clone(),
                        base: data,
                    });
                    let i = Arc::new(Image::open(inner, true)?);
                    cache.insert(att.position, i.clone());
                    i
                }
            }
        };
        // the finest level that is not more than 16 megapixels
        let level = (0..embedded.levels.len())
            .find(|l| embedded.levels[*l].size.0 * embedded.levels[*l].size.1 <= 16_000_000)
            .unwrap_or(embedded.levels.len() - 1);
        embedded.whole(level)
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
        let lv = self
            .main
            .levels
            .get(level)
            .ok_or_else(|| WsiError("Invalid level".into()))?;
        // positions are level-0 pixels
        let ds = lv.ratio as f64;
        self.main.read(
            level,
            (x as f64 / ds).round() as i64,
            (y as f64 / ds).round() as i64,
            w,
            h,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One directory entry: `(x, y, size, stored size, pyramid type)` of a Bgr24 tile without compression.
    struct T {
        x: i32,
        y: i32,
        size: i32,
        stored: i32,
        bgr: [u8; 3],
    }

    fn entry(t: &T, position: u64) -> Vec<u8> {
        let mut e = vec![];
        e.extend_from_slice(b"DV");
        e.extend_from_slice(&PIXEL_BGR24.to_le_bytes());
        e.extend_from_slice(&(position as i64).to_le_bytes());
        e.extend_from_slice(&0i32.to_le_bytes());
        e.extend_from_slice(&COMPRESSION_NONE.to_le_bytes());
        e.push(if t.size == t.stored { 0 } else { 2 });
        e.extend_from_slice(&[0u8; 5]);
        e.extend_from_slice(&4i32.to_le_bytes());
        for (name, start, size, stored) in [
            (b"X", t.x, t.size, t.stored),
            (b"Y", t.y, t.size, t.stored),
            (b"C", 0, 1, 1),
            (b"S", 0, 1, 1),
        ] {
            e.extend_from_slice(name);
            e.extend_from_slice(&[0u8; 3]);
            e.extend_from_slice(&start.to_le_bytes());
            e.extend_from_slice(&size.to_le_bytes());
            e.extend_from_slice(&0f32.to_le_bytes());
            e.extend_from_slice(&stored.to_le_bytes());
        }
        e
    }

    fn segment_bytes(name: &str, body: &[u8]) -> Vec<u8> {
        let mut s = vec![0u8; 16];
        s[..name.len()].copy_from_slice(name.as_bytes());
        s.extend_from_slice(&(body.len() as u64).to_le_bytes());
        s.extend_from_slice(&(body.len() as u64).to_le_bytes());
        s.extend_from_slice(body);
        s
    }

    /// A CZI of four tiles: three at full resolution that overlap (the later one covers the earlier), and one pyramid tile.
    fn synthetic() -> Vec<u8> {
        let tiles = [
            T {
                x: -100,
                y: 50,
                size: 4,
                stored: 4,
                bgr: [0, 0, 200],
            }, // red
            T {
                x: -98,
                y: 50,
                size: 4,
                stored: 4,
                bgr: [0, 200, 0],
            }, // green, over the red one
            T {
                x: -100,
                y: 54,
                size: 4,
                stored: 4,
                bgr: [200, 0, 0],
            }, // blue
            T {
                x: -100,
                y: 50,
                size: 8,
                stored: 4,
                bgr: [50, 100, 150],
            }, // half resolution: RGB (150, 100, 50)
        ];
        let mut file = segment_bytes("ZISRAWFILE", &[0u8; 512]);
        let mut positions = vec![];
        for t in &tiles {
            positions.push(file.len() as u64);
            let pixels: Vec<u8> = (0..(t.stored * t.stored) as usize)
                .flat_map(|_| t.bgr)
                .collect();
            let e = entry(t, 0);
            let mut body = vec![];
            body.extend_from_slice(&0i32.to_le_bytes());
            body.extend_from_slice(&0i32.to_le_bytes());
            body.extend_from_slice(&(pixels.len() as i64).to_le_bytes());
            body.extend_from_slice(&e);
            body.resize(256, 0);
            body.extend_from_slice(&pixels);
            file.extend(segment_bytes("ZISRAWSUBBLOCK", &body));
        }
        let dir_pos = file.len() as u64;
        let mut body = vec![];
        body.extend_from_slice(&(tiles.len() as i32).to_le_bytes());
        body.extend_from_slice(&[0u8; 124]);
        for (t, p) in tiles.iter().zip(&positions) {
            body.extend(entry(t, *p));
        }
        file.extend(segment_bytes("ZISRAWDIRECTORY", &body));
        let meta_pos = file.len() as u64;
        let xml = b"<ImageDocument><Metadata><Information><Instrument><Objectives><Objective><NominalMagnification>40</NominalMagnification></Objective></Objectives></Instrument></Information><Scaling><Items><Distance Id=\"X\"><Value>2.5E-07</Value></Distance></Items></Scaling></Metadata></ImageDocument>";
        let mut body = vec![];
        body.extend_from_slice(&(xml.len() as i32).to_le_bytes());
        body.extend_from_slice(&0i32.to_le_bytes());
        body.resize(256, 0);
        body.extend_from_slice(xml);
        file.extend(segment_bytes("ZISRAWMETADATA", &body));
        file[32 + 52..32 + 60].copy_from_slice(&dir_pos.to_le_bytes());
        file[32 + 60..32 + 68].copy_from_slice(&meta_pos.to_le_bytes());
        file
    }

    #[test]
    fn a_mosaic_is_composed_in_the_order_of_the_directory_with_its_pyramid() {
        let path = std::env::temp_dir().join(format!("exact-czi-{}.czi", std::process::id()));
        std::fs::write(&path, synthetic()).unwrap();
        let czi = Czi::open(path.to_str().unwrap()).unwrap();
        // the box of the full-resolution tiles: 6 x 8; half resolution is half of that
        assert_eq!(czi.level_dimensions(), vec![(6, 8), (3, 4)]);
        assert_eq!(czi.level_downsamples(), vec![1.0, 2.0]);
        let props = czi.properties();
        assert_eq!(props["openslide.objective-power"], "40");
        assert!((props["openslide.mpp-x"].parse::<f64>().unwrap() - 0.25).abs() < 1e-9);
        let r = czi.read_region(0, 0, 0, 6, 8, 0).unwrap();
        assert_eq!(r.get_pixel(1, 0).0, [200, 0, 0, 255]); // red: only the first tile
        assert_eq!(r.get_pixel(2, 0).0, [0, 200, 0, 255]); // green was drawn over the red one
        assert_eq!(r.get_pixel(5, 3).0, [0, 200, 0, 255]);
        assert_eq!(r.get_pixel(0, 4).0, [0, 0, 200, 255]); // blue
        assert_eq!(r.get_pixel(5, 5)[3], 0); // no tile there
                                             // half resolution is its own tile; a window past the edge of the level is transparent there
        let half = czi.read_region(0, 0, 1, 4, 4, 0).unwrap();
        assert_eq!(half.get_pixel(0, 0).0, [150, 100, 50, 255]);
        assert_eq!(half.get_pixel(2, 3).0, [150, 100, 50, 255]);
        assert_eq!(half.get_pixel(3, 0)[3], 0); // the level is 3 pixels wide
        assert_eq!(czi.best_level_for_downsample(1.9), 1);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn dimensions_that_are_not_read_are_refused() {
        // two channels
        let mut e = entry(
            &T {
                x: 0,
                y: 0,
                size: 4,
                stored: 4,
                bgr: [0; 3],
            },
            0,
        );
        let c = 32 + 20 * 2;
        e[c + 8..c + 12].copy_from_slice(&2i32.to_le_bytes());
        assert!(parse_directory(&e, 1).is_err());
        // a tile that does not fit the pyramid (stored 5 of 8)
        let odd = entry(
            &T {
                x: 0,
                y: 0,
                size: 8,
                stored: 5,
                bgr: [0; 3],
            },
            0,
        );
        assert!(parse_directory(&odd, 1).is_err());
        assert!(parse_directory(b"nonsense", 1).is_err());
    }

    #[test]
    fn the_metadata_values_are_found_by_name() {
        let xml = "<A><Objectives><Objective><NominalMagnification> 20 </NominalMagnification></Objective></Objectives></A>";
        assert_eq!(
            between(xml, "<Objectives>", "NominalMagnification"),
            Some("20")
        );
        assert_eq!(between(xml, "<Distance Id=\"X\">", "Value"), None);
    }
}
