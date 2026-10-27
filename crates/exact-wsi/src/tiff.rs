//! Minimal TIFF / BigTIFF reader: IFD chains and SubIFDs, tiled and striped RGB8 pages with raw, LZW, Deflate and
//! JPEG compression. Enough for OME-TIFF pyramids and z-stacks (`ome.rs`).

use crate::{err, Result, WsiError};
use std::{collections::HashMap, fs::File, os::unix::fs::FileExt, sync::Arc};

#[derive(Clone, Debug)]
struct Entry {
    typ: u16,
    /// raw value bytes (inline or fetched from the file)
    data: Vec<u8>,
}

#[derive(Clone)]
pub struct Tiff {
    file: Arc<File>,
    big: bool,
    le: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Ifd {
    tags: HashMap<u16, Entry>,
    le: bool,
    pub next: u64,
}

/// Decoded chunks (pixels, rows) per (page id, chunk index).
pub type ChunkCache = moka::sync::Cache<(usize, usize), Arc<(Vec<u8>, u64)>>;

pub const TAG_WIDTH: u16 = 256;
pub const TAG_LENGTH: u16 = 257;
pub const TAG_BITS: u16 = 258;
pub const TAG_COMPRESSION: u16 = 259;
pub const TAG_PHOTOMETRIC: u16 = 262;
pub const TAG_DESCRIPTION: u16 = 270;
pub const TAG_STRIP_OFFSETS: u16 = 273;
pub const TAG_SAMPLES: u16 = 277;
pub const TAG_ROWS_PER_STRIP: u16 = 278;
pub const TAG_STRIP_COUNTS: u16 = 279;
pub const TAG_X_RESOLUTION: u16 = 282;
pub const TAG_RESOLUTION_UNIT: u16 = 296;
pub const TAG_EXTRA_SAMPLES: u16 = 338;
pub const TAG_PLANAR: u16 = 284;
pub const TAG_PREDICTOR: u16 = 317;
pub const TAG_TILE_WIDTH: u16 = 322;
pub const TAG_TILE_LENGTH: u16 = 323;
pub const TAG_TILE_OFFSETS: u16 = 324;
pub const TAG_TILE_COUNTS: u16 = 325;
pub const TAG_SUBIFDS: u16 = 330;
pub const TAG_JPEG_TABLES: u16 = 347;

fn type_size(t: u16) -> usize {
    match t {
        1 | 2 | 6 | 7 => 1,
        3 | 8 => 2,
        4 | 9 | 11 | 13 => 4,
        5 | 10 | 12 | 16 | 17 | 18 => 8,
        _ => 1,
    }
}

impl Tiff {
    pub fn open(path: &str) -> Result<Self> {
        let file = File::open(path).map_err(|e| WsiError(format!("{path}: {e}")))?;
        let mut h = [0u8; 4];
        file.read_exact_at(&mut h, 0)
            .map_err(|e| WsiError(e.to_string()))?;
        let le = match &h[..2] {
            b"II" => true,
            b"MM" => false,
            _ => return err("not a TIFF file"),
        };
        let magic = if le {
            u16::from_le_bytes([h[2], h[3]])
        } else {
            u16::from_be_bytes([h[2], h[3]])
        };
        let big = match magic {
            42 => false,
            43 => true,
            _ => return err("not a TIFF file"),
        };
        Ok(Self {
            file: Arc::new(file),
            big,
            le,
        })
    }

    fn rd(&self, off: u64, n: usize) -> Result<Vec<u8>> {
        let mut b = vec![0u8; n];
        self.file
            .read_exact_at(&mut b, off)
            .map_err(|e| WsiError(format!("TIFF read at {off}: {e}")))?;
        Ok(b)
    }

    fn uint(&self, b: &[u8]) -> u64 {
        let mut v = 0u64;
        if self.le {
            for (i, x) in b.iter().enumerate() {
                v |= (*x as u64) << (8 * i);
            }
        } else {
            for x in b {
                v = (v << 8) | *x as u64;
            }
        }
        v
    }

    pub fn first_ifd_offset(&self) -> Result<u64> {
        Ok(if self.big {
            self.uint(&self.rd(8, 8)?)
        } else {
            self.uint(&self.rd(4, 4)?)
        })
    }

    pub fn read_ifd(&self, off: u64) -> Result<Ifd> {
        let (cnt_len, entry_len, val_len) = if self.big { (8, 20, 8) } else { (2, 12, 4) };
        let n = self.uint(&self.rd(off, cnt_len)?) as usize;
        let raw = self.rd(off + cnt_len as u64, n * entry_len + val_len)?;
        let mut tags = HashMap::new();
        for i in 0..n {
            let e = &raw[i * entry_len..(i + 1) * entry_len];
            let tag = self.uint(&e[0..2]) as u16;
            let typ = self.uint(&e[2..4]) as u16;
            let (count, vb) = if self.big {
                (self.uint(&e[4..12]), &e[12..20])
            } else {
                (self.uint(&e[4..8]), &e[8..12])
            };
            let size = count as usize * type_size(typ);
            let data = if size <= val_len {
                vb[..size].to_vec()
            } else {
                self.rd(self.uint(vb), size)?
            };
            tags.insert(tag, Entry { typ, data });
        }
        let next = self.uint(&raw[n * entry_len..]);
        Ok(Ifd {
            tags,
            le: self.le,
            next,
        })
    }

    pub fn read_at(&self, off: u64, n: usize) -> Result<Vec<u8>> {
        self.rd(off, n)
    }
}

impl Ifd {
    /// All entries as (tag, type, value bytes in little endian), for copying into a newly written file.
    pub fn entries_le(&self) -> Vec<(u16, u16, Vec<u8>)> {
        let mut v: Vec<_> = self
            .tags
            .iter()
            .map(|(tag, e)| {
                let unit = match e.typ {
                    3 | 8 => 2,
                    4 | 9 | 11 | 13 | 5 | 10 => 4,
                    12 | 16 | 17 | 18 => 8,
                    _ => 1,
                };
                let mut data = e.data.clone();
                if !self.le && unit > 1 {
                    for c in data.chunks_exact_mut(unit) {
                        c.reverse();
                    }
                }
                (*tag, e.typ, data)
            })
            .collect();
        v.sort_by_key(|e| e.0);
        v
    }

    pub fn has(&self, tag: u16) -> bool {
        self.tags.contains_key(&tag)
    }

    pub fn uints(&self, tag: u16) -> Option<Vec<u64>> {
        let e = self.tags.get(&tag)?;
        let sz = type_size(e.typ);
        Some(
            e.data
                .chunks_exact(sz)
                .map(|c| {
                    let mut v = 0u64;
                    if self.le {
                        for (i, x) in c.iter().enumerate() {
                            v |= (*x as u64) << (8 * i);
                        }
                    } else {
                        for x in c {
                            v = (v << 8) | *x as u64;
                        }
                    }
                    v
                })
                .collect(),
        )
    }

    pub fn uint(&self, tag: u16) -> Option<u64> {
        self.uints(tag)?.first().copied()
    }

    /// First RATIONAL value of the tag as a float.
    pub fn rational(&self, tag: u16) -> Option<f64> {
        let e = self.tags.get(&tag)?;
        if e.data.len() < 8 {
            return None;
        }
        let rd = |b: &[u8]| -> f64 {
            let mut a = [0u8; 4];
            a.copy_from_slice(b);
            (if self.le {
                u32::from_le_bytes(a)
            } else {
                u32::from_be_bytes(a)
            }) as f64
        };
        let (n, d) = (rd(&e.data[0..4]), rd(&e.data[4..8]));
        (d != 0.0).then_some(n / d)
    }

    pub fn ascii(&self, tag: u16) -> Option<String> {
        let e = self.tags.get(&tag)?;
        Some(
            String::from_utf8_lossy(&e.data)
                .trim_end_matches('\0')
                .to_string(),
        )
    }

    pub fn bytes(&self, tag: u16) -> Option<&[u8]> {
        self.tags.get(&tag).map(|e| e.data.as_slice())
    }
}

/// One image plane (page or SubIFD) ready for chunk decoding.
pub struct Page {
    tiff: Tiff,
    pub width: u64,
    pub height: u64,
    pub chunk_w: u64,
    pub chunk_h: u64,
    tiled: bool,
    compression: u64,
    predictor: u64,
    pub samples: usize,
    /// alpha channel is premultiplied (ExtraSamples = 1)
    assoc_alpha: bool,
    offsets: Vec<u64>,
    counts: Vec<u64>,
    jpeg_tables: Option<Vec<u8>>,
    chunks_across: u64,
}

impl Page {
    pub fn new(tiff: &Tiff, ifd: &Ifd) -> Result<Self> {
        let width = ifd
            .uint(TAG_WIDTH)
            .ok_or_else(|| WsiError("no width".into()))?;
        let height = ifd
            .uint(TAG_LENGTH)
            .ok_or_else(|| WsiError("no length".into()))?;
        let samples = ifd.uint(TAG_SAMPLES).unwrap_or(1) as usize;
        if ifd
            .uints(TAG_BITS)
            .is_some_and(|b| b.iter().any(|x| *x != 8))
            || ifd.uint(TAG_PLANAR).unwrap_or(1) != 1
            || !matches!(samples, 1 | 3 | 4)
        {
            return err("only 8-bit chunky RGB/gray TIFF pages are supported");
        }
        let tiled = ifd.has(TAG_TILE_OFFSETS);
        let (chunk_w, chunk_h, offsets, counts) = if tiled {
            (
                ifd.uint(TAG_TILE_WIDTH).unwrap_or(0),
                ifd.uint(TAG_TILE_LENGTH).unwrap_or(0),
                ifd.uints(TAG_TILE_OFFSETS).unwrap_or_default(),
                ifd.uints(TAG_TILE_COUNTS).unwrap_or_default(),
            )
        } else {
            (
                width,
                ifd.uint(TAG_ROWS_PER_STRIP).unwrap_or(height).min(height),
                ifd.uints(TAG_STRIP_OFFSETS).unwrap_or_default(),
                ifd.uints(TAG_STRIP_COUNTS).unwrap_or_default(),
            )
        };
        if chunk_w == 0 || chunk_h == 0 || offsets.is_empty() || offsets.len() != counts.len() {
            return err("bad TIFF chunk layout");
        }
        Ok(Self {
            tiff: tiff.clone(),
            width,
            height,
            chunk_w,
            chunk_h,
            tiled,
            compression: ifd.uint(TAG_COMPRESSION).unwrap_or(1),
            predictor: ifd.uint(TAG_PREDICTOR).unwrap_or(1),
            samples,
            assoc_alpha: ifd.uint(TAG_EXTRA_SAMPLES) == Some(1),
            offsets,
            counts,
            jpeg_tables: ifd.bytes(TAG_JPEG_TABLES).map(|b| b.to_vec()),
            chunks_across: width.div_ceil(chunk_w),
        })
    }

    /// A page of a file written by this crate (see `repair.rs`): tiled, chunky 8-bit, no predictor.
    #[allow(clippy::too_many_arguments)]
    pub fn from_parts(
        tiff: &Tiff,
        width: u64,
        height: u64,
        chunk: u64,
        compression: u64,
        samples: usize,
        offsets: Vec<u64>,
        counts: Vec<u64>,
    ) -> Self {
        Self {
            tiff: tiff.clone(),
            width,
            height,
            chunk_w: chunk,
            chunk_h: chunk,
            tiled: true,
            compression,
            predictor: 1,
            samples,
            assoc_alpha: false,
            offsets,
            counts,
            jpeg_tables: None,
            chunks_across: width.div_ceil(chunk),
        }
    }

    pub fn compression(&self) -> u64 {
        self.compression
    }

    pub fn is_tiled(&self) -> bool {
        self.tiled
    }

    /// Stored (still compressed) bytes of a chunk, for copying without recompression.
    pub fn raw_chunk(&self, idx: usize) -> Result<Vec<u8>> {
        self.tiff
            .read_at(self.offsets[idx], self.counts[idx] as usize)
    }

    pub fn chunk_count(&self) -> usize {
        self.offsets.len()
    }

    pub fn chunk_index(&self, col: u64, row: u64) -> usize {
        (row * self.chunks_across + col) as usize
    }

    pub fn chunks_down(&self) -> u64 {
        self.height.div_ceil(self.chunk_h)
    }

    pub fn chunks_across(&self) -> u64 {
        self.chunks_across
    }

    /// Decoded pixels of one tile or strip: `rows * chunk_w * samples` bytes, rows = chunk_h (strips: clipped).
    pub fn decode_chunk(&self, idx: usize) -> Result<(Vec<u8>, u64)> {
        let (off, len) = (
            *self
                .offsets
                .get(idx)
                .ok_or_else(|| WsiError("chunk index".into()))?,
            self.counts[idx],
        );
        let rows = if self.tiled {
            self.chunk_h
        } else {
            let row = idx as u64;
            self.chunk_h.min(self.height - row * self.chunk_h)
        };
        let raw = self.tiff.read_at(off, len as usize)?;
        let want = (rows * self.chunk_w) as usize * self.samples;
        let mut px = match self.compression {
            1 => raw,
            5 => weezl::decode::Decoder::with_tiff_size_switch(weezl::BitOrder::Msb, 8)
                .decode(&raw)
                .map_err(|e| WsiError(format!("LZW: {e}")))?,
            8 | 32946 => {
                use std::io::Read;
                let mut out = Vec::with_capacity(want);
                flate2::read::ZlibDecoder::new(&raw[..])
                    .read_to_end(&mut out)
                    .map_err(|e| WsiError(format!("deflate: {e}")))?;
                out
            }
            7 => {
                let mut stream = Vec::with_capacity(raw.len() + 600);
                match &self.jpeg_tables {
                    // abbreviated streams: tables (without EOI) + tile (without SOI)
                    Some(t) if t.len() > 4 => {
                        stream.extend_from_slice(&t[..t.len() - 2]);
                        stream.extend_from_slice(raw.get(2..).unwrap_or(&[]));
                    }
                    _ => stream = raw,
                }
                image::load_from_memory_with_format(&stream, image::ImageFormat::Jpeg)
                    .map_err(|e| WsiError(format!("JPEG tile: {e}")))?
                    .to_rgb8()
                    .into_raw()
            }
            c => return err(format!("TIFF compression {c} is not supported")),
        };
        if px.len() < want {
            px.resize(want, 0);
        }
        if self.predictor == 2 && self.compression != 7 {
            let (w, s) = (self.chunk_w as usize, self.samples);
            for r in 0..rows as usize {
                let row = &mut px[r * w * s..(r + 1) * w * s];
                for i in s..row.len() {
                    row[i] = row[i].wrapping_add(row[i - s]);
                }
            }
        }
        Ok((px, rows))
    }

    /// Reads the region (x, y, w, h) of this page as straight RGBA (alpha 255 inside the page, 0 outside).
    pub fn read_rgba(
        &self,
        x: i64,
        y: i64,
        w: u32,
        h: u32,
        cache: &ChunkCache,
        page_id: usize,
    ) -> Result<image::RgbaImage> {
        let mut out = image::RgbaImage::new(w, h);
        let (x0, y0) = (x.max(0) as u64, y.max(0) as u64);
        let (x1, y1) = (
            ((x + w as i64).max(0) as u64).min(self.width),
            ((y + h as i64).max(0) as u64).min(self.height),
        );
        if x1 <= x0 || y1 <= y0 {
            return Ok(out);
        }
        let s = self.samples;
        for row in y0 / self.chunk_h..=(y1 - 1) / self.chunk_h {
            for col in (if self.tiled { x0 / self.chunk_w } else { 0 })..=(if self.tiled {
                (x1 - 1) / self.chunk_w
            } else {
                0
            }) {
                let idx = if self.tiled {
                    self.chunk_index(col, row)
                } else {
                    row as usize
                };
                let chunk = match cache.get(&(page_id, idx)) {
                    Some(c) => c,
                    None => {
                        let c = Arc::new(self.decode_chunk(idx)?);
                        cache.insert((page_id, idx), c.clone());
                        c
                    }
                };
                let (px, rows) = (&chunk.0, chunk.1);
                let (cx0, cy0) = (col * self.chunk_w, row * self.chunk_h);
                for yy in y0.max(cy0)..y1.min(cy0 + rows) {
                    for xx in x0.max(cx0)..x1.min(cx0 + self.chunk_w) {
                        let o = (((yy - cy0) * self.chunk_w + (xx - cx0)) as usize) * s;
                        let (p, a) = match s {
                            1 => ([px[o]; 3], 255),
                            3 => ([px[o], px[o + 1], px[o + 2]], 255),
                            _ => {
                                let a = px[o + 3];
                                let mut p = [px[o], px[o + 1], px[o + 2]];
                                if self.assoc_alpha && a != 0 && a != 255 {
                                    for c in &mut p {
                                        *c = ((*c as u32 * 255 + a as u32 / 2) / a as u32).min(255)
                                            as u8;
                                    }
                                }
                                (p, a)
                            }
                        };
                        out.put_pixel(
                            (xx as i64 - x) as u32,
                            (yy as i64 - y) as u32,
                            image::Rgba([p[0], p[1], p[2], a]),
                        );
                    }
                }
            }
        }
        Ok(out)
    }
}
