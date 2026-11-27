//! Olympus / Evident cellSens VSI (`.vsi` plus the pixel files `_name_/stack<id>/*.ets`), read natively.
//!
//! The format has no public specification; this is written from slideio's BSD-3 driver (`src/slideio/drivers/vsi`) and the
//! reverse-engineered notes of bioio-vsi, and checked against slideio on real files. What is read:
//!
//! * the `.vsi` file is a TIFF-like header followed by a tree of tagged fields (volumes holding fields holding volumes ...). The
//!   volumes with tag 2001 are the stacks of the scan (the scan itself, an overview, a macro photo, masks, ...); each names its
//!   `.ets` file by its stack id, and says what it is (tag 2074), its size (2053), pixel size (2019) and objective (120060);
//! * an `.ets` file has a header, a table of tiles (position in the pyramid, offset, size) and the compressed tiles themselves
//!   (JPEG, 512 x 512 for the slide scanners).
//!
//! Anything this reader does not know (other compressions, 16-bit or multi-channel data, time series, a `.vsi` that is a plain
//! TIFF, an `.ets` that cannot be assigned to a stack) is an error from `open`, and the caller falls back to slideio.

use crate::{err, FrameKind, Result, Slide, WsiError};
use image::RgbaImage;
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
};

// ---------------------------------------------------------------------------------------------------------------------
// the tag tree of the .vsi file
// ---------------------------------------------------------------------------------------------------------------------

/// A value of a field, as far as its type is understood.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum Val {
    None,
    Int(i64),
    Float(f64),
    Ints(Vec<i64>),
    Floats(Vec<f64>),
    Str(String),
}

impl Val {
    fn int(&self) -> Option<i64> {
        match self {
            Val::Int(i) => Some(*i),
            Val::Ints(v) if v.len() == 1 => Some(v[0]),
            _ => None,
        }
    }
    fn float(&self) -> Option<f64> {
        match self {
            Val::Float(f) => Some(*f),
            Val::Floats(v) if v.len() == 1 => Some(v[0]),
            Val::Int(i) => Some(*i as f64),
            _ => None,
        }
    }
    fn ints(&self) -> Option<Vec<i64>> {
        match self {
            Val::Ints(v) => Some(v.clone()),
            Val::Int(i) => Some(vec![*i]),
            _ => None,
        }
    }
    fn floats(&self) -> Option<Vec<f64>> {
        match self {
            Val::Floats(v) => Some(v.clone()),
            Val::Float(f) => Some(vec![*f]),
            _ => None,
        }
    }
}

#[derive(Debug)]
pub(crate) struct Node {
    tag: i32,
    second: Option<i32>,
    value: Val,
    children: Vec<Node>,
}

impl Node {
    fn child(&self, tag: i32) -> Option<&Node> {
        self.children.iter().find(|c| c.tag == tag)
    }
    fn path(&self, tags: &[i32]) -> Option<&Node> {
        tags.iter().try_fold(self, |n, t| n.child(*t))
    }
    fn find_deep(&self, tag: i32) -> Option<&Node> {
        for c in &self.children {
            if c.tag == tag {
                return Some(c);
            }
            if let Some(f) = c.find_deep(tag) {
                return Some(f);
            }
        }
        None
    }
}

/// Value types of a single value (or an array of equal ones) and of vectors, as in the files seen.
fn scalar_kind(t: u32) -> Option<char> {
    Some(match t {
        1 => 'b',
        2 => 'B',
        3 => 'h',
        4 => 'H',
        5 => 'i',
        6 | 14 | 271 | 272 | 273 | 8470 => 'I',
        7 | 17 | 18 => 'q',
        8 => 'Q',
        9 => 'f',
        10 | 11 => 'd',
        12 => 'B',
        _ => return None,
    })
}

fn vector_kind(t: u32) -> Option<char> {
    Some(match t {
        256..=259 | 267 | 274..=277 | 8195 | 8199 | 8200 => 'i',
        260..=266 | 268 | 279 | 280 => 'd',
        269 | 270 => 'B',
        _ => return None,
    })
}

fn decode_value(t: u32, raw: &[u8]) -> Val {
    // type 13 holds UTF-16 too (unit strings such as "10^-6m^1"), unterminated
    if matches!(t, 13 | 8192 | 8194) {
        let units: Vec<u16> = raw
            .as_chunks::<2>()
            .0
            .iter()
            .map(|c| u16::from_le_bytes(*c))
            .collect();
        let s = String::from_utf16_lossy(&units);
        return Val::Str(s.split('\0').next().unwrap_or("").to_string());
    }
    let (kind, vector) = match (scalar_kind(t), vector_kind(t)) {
        (Some(k), _) => (k, false),
        (None, Some(k)) => (k, true),
        _ => return Val::None,
    };
    let size = match kind {
        'b' | 'B' => 1,
        'h' | 'H' => 2,
        'i' | 'I' | 'f' => 4,
        _ => 8,
    };
    let n = raw.len() / size;
    let at = |i: usize| &raw[i * size..(i + 1) * size];
    let int = |i: usize| -> i64 {
        let b = at(i);
        match kind {
            'b' => b[0] as i8 as i64,
            'B' => b[0] as i64,
            'h' => i16::from_le_bytes([b[0], b[1]]) as i64,
            'H' => u16::from_le_bytes([b[0], b[1]]) as i64,
            'i' => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as i64,
            'I' => u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as i64,
            'q' => i64::from_le_bytes(b.try_into().expect("8 bytes")),
            _ => u64::from_le_bytes(b.try_into().expect("8 bytes")) as i64,
        }
    };
    let float = |i: usize| -> f64 {
        let b = at(i);
        if kind == 'f' {
            f32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f64
        } else {
            f64::from_le_bytes(b.try_into().expect("8 bytes"))
        }
    };
    let is_float = matches!(kind, 'f' | 'd');
    if is_float {
        let v: Vec<f64> = (0..n).map(float).collect();
        if n == 1 && !vector {
            Val::Float(v[0])
        } else {
            Val::Floats(v)
        }
    } else {
        let v: Vec<i64> = (0..n).map(int).collect();
        if n == 1 && !vector {
            Val::Int(v[0])
        } else {
            Val::Ints(v)
        }
    }
}

fn decode_inline(t: u32, size: u32) -> Val {
    match t {
        5 => Val::Int(size as i32 as i64),
        6 | 14 | 271 | 4104 => Val::Int(size as i64),
        12 => Val::Int((size != 0) as i64),
        _ => Val::None,
    }
}

fn take<'a>(buf: &'a [u8], pos: usize, n: usize, what: &str) -> Result<&'a [u8]> {
    pos.checked_add(n)
        .and_then(|e| buf.get(pos..e))
        .ok_or_else(|| {
            WsiError(format!(
                "VSI: {what} lies outside of the file (offset {pos})"
            ))
        })
}

fn le_i32(b: &[u8]) -> i32 {
    i32::from_le_bytes([b[0], b[1], b[2], b[3]])
}
fn le_u32(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}
fn le_i64(b: &[u8]) -> i64 {
    i64::from_le_bytes(b[..8].try_into().expect("8 bytes"))
}

/// Fields of one volume at `pos`; returns them and the end of what was read.
fn parse_volume(
    buf: &[u8],
    pos: usize,
    seen: &mut HashSet<usize>,
    depth: usize,
) -> Result<(Vec<Node>, usize)> {
    if depth > 64 {
        return err("VSI: the tag tree is nested too deep");
    }
    let h = take(buf, pos, 24, "volume header")?;
    let (hs, magic) = (
        u16::from_le_bytes([h[0], h[1]]),
        u16::from_le_bytes([h[2], h[3]]),
    );
    let first = le_i64(&h[8..16]);
    let flags = le_u32(&h[16..20]);
    if hs != 24 || magic != 21321 || first < 0 {
        return err(format!("VSI: bad volume header at {pos}"));
    }
    let count = (flags & 0x0FFF_FFFF) as usize;
    if count == 0 {
        return Ok((vec![], pos + 24));
    }
    let mut p = pos + first as usize;
    let mut out = Vec::with_capacity(count);
    let mut end = p;
    let mut here = HashSet::new();
    for i in 0..count {
        if !seen.insert(p) || !here.insert(p) {
            return err(format!("VSI: field at {p} visited twice"));
        }
        let f = take(buf, p, 16, "field header")?;
        let (ft, tag, nxt, size) = (
            le_i32(f) as u32,
            le_i32(&f[4..]),
            le_i32(&f[8..]),
            le_u32(&f[12..]),
        );
        let vtype = ft & 0x00FF_FFFF;
        let (inline, extended) = (ft & 0x4000_0000 != 0, ft & 0x1000_0000 != 0);
        let mut q = p + 16;
        let second = if ft & 0x0800_0000 != 0 {
            let s = le_i32(take(buf, q, 4, "second tag")?);
            q += 4;
            Some(s)
        } else {
            None
        };
        let mut node = Node {
            tag,
            second,
            value: Val::None,
            children: vec![],
        };
        // VS200 mask and annotation blobs declare a payload past the end of the file: skipped without reading
        let skip_blob = (ft >> 24) & 0xFF == 0x28 && matches!(tag, 2023 | 2024);
        let avail = buf.len().saturating_sub(q);
        if extended {
            if vtype <= 2 {
                let (children, e2) = parse_volume(buf, q, seen, depth + 1)?;
                node.children = children;
                end = end.max(e2);
            } else if skip_blob {
                end = end.max(q);
            } else if size as usize > avail {
                return err(format!("VSI: field {tag} is cut off"));
            } else {
                end = end.max(q + size as usize);
            }
        } else if inline {
            node.value = decode_inline(vtype, size);
            end = end.max(q);
        } else if skip_blob {
            end = end.max(q);
        } else if size as usize > avail {
            return err(format!("VSI: field {tag} is cut off"));
        } else {
            if size > 0 {
                node.value = decode_value(vtype, &buf[q..q + size as usize]);
            }
            end = end.max(q + size as usize);
        }
        out.push(node);
        if nxt == 0 {
            if i + 1 < count {
                return err(format!(
                    "VSI: the field chain of the volume at {pos} ends early"
                ));
            }
            break;
        }
        let next = pos + nxt as u32 as usize;
        if nxt < 0 || next <= p {
            return err(format!("VSI: bad link from the field at {p}"));
        }
        p = next;
    }
    Ok((out, end))
}

pub(crate) fn parse_tree(buf: &[u8]) -> Result<Vec<Node>> {
    if buf.len() < 8 || &buf[..4] != b"II*\0" {
        return err("VSI: not a VSI file (no little-endian TIFF header)");
    }
    let mut seen = HashSet::new();
    Ok(parse_volume(buf, 8, &mut seen, 0)?.0)
}

// ---------------------------------------------------------------------------------------------------------------------
// the stacks of the scan
// ---------------------------------------------------------------------------------------------------------------------

const TAG_COLLECTION: i32 = 2000;
const TAG_VOLUME: i32 = 2001;
const TAG_FRAME: i32 = 2002;
const TAG_STACK_PROPS: i32 = 2005;
const TAG_DIM_DESC: i32 = 2007;
const TAG_DIM_PARAMS: i32 = 2008;
const TAG_DIM_INDEX: i32 = 2023;
const TAG_CHANNEL_INFO: i32 = 2013;
const TAG_EXTERNAL: i32 = 2018;
const TAG_BOUNDARY: i32 = 2053;
const TAG_BACKGROUND: i32 = 2034;
const TAG_SCALE: i32 = 2019;
const TAG_SCALE_UNIT: i32 = 2020;
const TAG_NAME: i32 = 2030;
const TAG_STACK_TYPE: i32 = 2074;
const TAG_MICROSCOPE: i32 = 2043;
const TAG_OBJECTIVE_MAG: i32 = 120060;
const TAG_VALUE: i32 = 0x1000_0002;
const TAG_UNITS: i32 = 0x1000_0000;

const STACK_DEFAULT: i64 = 0;
const STACK_EFI: i64 = 64;

/// Which coordinate of a tile is which dimension (`None`: the file has none of it).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct Order {
    z: Option<usize>,
    t: Option<usize>,
    c: Option<usize>,
    l: Option<usize>,
    p: Option<usize>,
}

#[derive(Debug)]
struct Volume {
    stack_id: i32,
    kind: i64,
    name: String,
    size: (u32, u32),
    /// micrometres per pixel, 0 when the file does not say
    mpp: (f64, f64),
    magnification: f64,
    background: [u8; 3],
    order: Order,
    /// distance between z planes in micrometres, 0 when not given
    z_step: f64,
}

fn unit_to_um(unit: &str) -> Option<f64> {
    Some(match unit {
        "10^-6m^1" => 1.0,
        "10^-3m^1" => 1000.0,
        "10^-9m^1" => 0.001,
        "10^0m^1" => 1_000_000.0,
        _ => return None,
    })
}

fn volumes_of(tree: &[Node]) -> Vec<Volume> {
    let Some(coll) = tree.iter().find(|n| n.tag == TAG_COLLECTION) else {
        return vec![];
    };
    let mut out = vec![];
    for v in coll.children.iter().filter(|n| n.tag == TAG_VOLUME) {
        // the frame that has the pixels (others hold vector layers)
        let frames: Vec<&Node> = v
            .children
            .iter()
            .filter(|n| n.tag == TAG_FRAME && n.child(TAG_EXTERNAL).is_some())
            .collect();
        if frames.len() != 1 {
            continue;
        }
        let props = v.child(TAG_STACK_PROPS);
        let boundary = frames[0]
            .path(&[TAG_EXTERNAL, TAG_BOUNDARY])
            .and_then(|n| n.value.ints());
        let Some((w, h)) = boundary.as_ref().and_then(|b| {
            (b.len() == 4 && b[2] > 0 && b[3] > 0).then(|| (b[2] as u32, b[3] as u32))
        }) else {
            continue;
        };
        let kind = props
            .and_then(|p| p.child(TAG_STACK_TYPE))
            .and_then(|n| n.value.int())
            .unwrap_or(STACK_DEFAULT);
        let unit = props
            .and_then(|p| p.child(TAG_SCALE_UNIT))
            .and_then(|n| match &n.value {
                Val::Str(s) => Some(s.as_str()),
                _ => None,
            });
        let mpp = props
            .and_then(|p| p.child(TAG_SCALE))
            .and_then(|n| n.value.floats())
            .filter(|s| s.len() == 2)
            .zip(unit.and_then(unit_to_um))
            .map_or((0.0, 0.0), |(s, k)| (s[0] * k, s[1] * k));
        let magnification = props
            .and_then(|p| p.child(TAG_MICROSCOPE))
            .and_then(|m| m.find_deep(TAG_OBJECTIVE_MAG))
            .and_then(|n| n.value.float())
            .unwrap_or(0.0);
        let background = v
            .child(TAG_BACKGROUND)
            .and_then(|n| n.value.ints())
            .filter(|b| b.len() >= 3)
            .map_or([0, 0, 0], |b| [b[0] as u8, b[1] as u8, b[2] as u8]);
        let mut order = Order::default();
        let mut z_step = 0.0;
        for d in v.children.iter().filter(|n| n.tag == TAG_DIM_DESC) {
            let at = d.second.unwrap_or(0).max(0) as usize + 2;
            for params in d.children.iter().filter(|n| n.tag == TAG_DIM_PARAMS) {
                match params.child(TAG_DIM_INDEX).and_then(|n| n.value.int()) {
                    Some(1) => {
                        order.z = Some(at);
                        let info = params.child(TAG_CHANNEL_INFO);
                        let value = info
                            .and_then(|i| i.child(TAG_VALUE))
                            .and_then(|n| n.value.float());
                        let units =
                            info.and_then(|i| i.child(TAG_UNITS))
                                .and_then(|n| match &n.value {
                                    Val::Str(s) => Some(s.as_str()),
                                    _ => None,
                                });
                        if let (Some(v), Some(k)) = (value, units.and_then(unit_to_um)) {
                            z_step = v * k;
                        }
                    }
                    Some(2) => order.t = Some(at),
                    Some(3) => order.l = Some(at),
                    Some(4) => order.c = Some(at),
                    Some(9) => order.p = Some(at),
                    _ => {}
                }
            }
        }
        out.push(Volume {
            stack_id: v.second.unwrap_or(-1),
            kind,
            name: props
                .and_then(|p| p.child(TAG_NAME))
                .and_then(|n| match &n.value {
                    Val::Str(s) => Some(s.clone()),
                    _ => None,
                })
                .unwrap_or_default(),
            size: (w, h),
            mpp,
            magnification,
            background,
            order,
            z_step,
        });
    }
    out
}

/// What slideio calls a stack that is not the scan.
fn stack_type_name(kind: i64) -> &'static str {
    match kind {
        STACK_DEFAULT => "Image",
        1 => "Overview",
        2 => "Sample mask",
        4 => "Focus image",
        8 => "EFI sharpness map",
        16 => "EFI height map",
        32 => "EFI texture map",
        STACK_EFI => "EFI stack",
        256 => "Macro image",
        _ => "Unknown",
    }
}

/// Port of `Volume::fitDimensionOrderToTiles` (slideio, after Bio-Formats): the dimension orders the metadata states are not always
/// those of the tile coordinates (the level is the last one, and some files count one further along).
fn fit_order(mut o: Order, num_coords: usize, use_pyramid: bool) -> Order {
    let level_index = use_pyramid.then(|| num_coords - 1);
    let upper = if use_pyramid {
        num_coords - 1
    } else {
        num_coords
    };
    for dim in [&mut o.z, &mut o.t] {
        if dim.is_some() && *dim == level_index {
            *dim = None;
        }
    }
    let mut any = false;
    let mut overrun = true;
    for v in [o.z, o.c, o.t, o.l, o.p].into_iter().flatten() {
        any = true;
        overrun &= v >= upper;
    }
    if any && overrun {
        for v in [&mut o.z, &mut o.c, &mut o.t, &mut o.l, &mut o.p]
            .into_iter()
            .flatten()
        {
            *v -= 1;
        }
    }
    // no z or t stated over tiles with extra coordinates: infer them
    if o.z.is_none() && o.t.is_none() && num_coords > 4 {
        let taken = |o: &Order, order: usize, except: char| {
            [('z', o.z), ('c', o.c), ('t', o.t), ('l', o.l), ('p', o.p)]
                .iter()
                .any(|(n, d)| *n != except && *d == Some(order))
        };
        let channel_stated = o.c.is_some();
        if !channel_stated && 2 < upper && !taken(&o, 2, 'c') {
            o.c = Some(2);
        }
        let channel_order = o.c.unwrap_or(0);
        let t_order = if channel_stated { channel_order + 2 } else { 3 };
        if (2..upper).contains(&t_order) && !taken(&o, t_order, 't') {
            o.t = Some(t_order);
        }
        if num_coords > 5 {
            let z_order = if channel_stated { channel_order + 1 } else { 4 };
            if (2..upper).contains(&z_order) && !taken(&o, z_order, 'z') {
                o.z = Some(z_order);
            }
        }
    }
    o
}

// ---------------------------------------------------------------------------------------------------------------------
// the .ets pixel files
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
struct Tile {
    offset: u64,
    size: u32,
}

/// A pixel file: header, and the table of its tiles by (level, x, y, z).
struct Ets {
    file: File,
    tile: (u32, u32),
    components: u32,
    compression: u32,
    /// tile coordinates along z, 1 for a plain image
    frames: u32,
    levels: usize,
    tiles: HashMap<(i32, i32, i32, i32), Tile>,
}

const COMPRESSION_RAW: u32 = 0;
const COMPRESSION_JPEG: u32 = 2;

#[cfg(unix)]
fn read_at(f: &File, buf: &mut [u8], offset: u64) -> std::io::Result<()> {
    std::os::unix::fs::FileExt::read_exact_at(f, buf, offset)
}
#[cfg(windows)]
fn read_at(f: &File, mut buf: &mut [u8], mut offset: u64) -> std::io::Result<()> {
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

impl Ets {
    fn open(path: &Path, vol: &Volume) -> Result<(Self, Order)> {
        let io = |e: std::io::Error| WsiError(format!("{}: {e}", path.display()));
        let file = File::open(path).map_err(io)?;
        let mut head = [0u8; 64];
        read_at(&file, &mut head, 0).map_err(io)?;
        if &head[..3] != b"SIS" || le_u32(&head[4..]) != 64 {
            return err(format!("{}: not an ETS file", path.display()));
        }
        let num_dims = le_u32(&head[12..]) as usize;
        let add_pos = le_i64(&head[16..]) as u64;
        let chunks_pos = le_i64(&head[32..]) as u64;
        let n_chunks = le_u32(&head[40..]) as usize;
        let mut add = [0u8; 160];
        read_at(&file, &mut add, add_pos).map_err(io)?;
        if &add[..3] != b"ETS" {
            return err(format!("{}: no ETS header", path.display()));
        }
        let (component_type, components, compression) =
            (le_u32(&add[8..]), le_u32(&add[12..]), le_u32(&add[20..]));
        let tile = (le_u32(&add[28..]), le_u32(&add[32..]));
        // the 17 + 10 words after sizeZ, then the component order and the pyramid flag
        let use_pyramid = le_u32(&add[40 + 4 * 27 + 4..]) != 0;
        if component_type != 2 {
            return err("VSI: only 8-bit pixels are read natively");
        }
        if !(components == 1 || components == 3) {
            return err("VSI: only gray and RGB pixels are read natively");
        }
        if !(compression == COMPRESSION_JPEG || (compression == COMPRESSION_RAW && components == 1))
        {
            return err(format!(
                "VSI: compression {compression} is not read natively"
            ));
        }
        if tile.0 == 0
            || tile.1 == 0
            || tile.0 > 4096
            || tile.1 > 4096
            || !(2..=8).contains(&num_dims)
        {
            return err("VSI: unusual tile geometry");
        }
        let entry = 4 + 4 * num_dims + 8 + 4 + 4;
        let file_len = file.metadata().map_err(io)?.len();
        if n_chunks > 50_000_000 || chunks_pos.saturating_add((n_chunks * entry) as u64) > file_len
        {
            return err("VSI: the tile table does not fit the file");
        }
        let mut table = vec![0u8; n_chunks * entry];
        read_at(&file, &mut table, chunks_pos).map_err(io)?;
        let mut coords: Vec<Vec<i32>> = Vec::with_capacity(n_chunks);
        let mut tiles_raw = Vec::with_capacity(n_chunks);
        let mut max = vec![0i32; num_dims];
        for e in table.chunks_exact(entry) {
            let c: Vec<i32> = (0..num_dims).map(|i| le_i32(&e[4 + 4 * i..])).collect();
            for (m, v) in max.iter_mut().zip(&c) {
                *m = (*m).max(*v);
            }
            let o = 4 + 4 * num_dims;
            tiles_raw.push(Tile {
                offset: le_i64(&e[o..]) as u64,
                size: le_u32(&e[o + 8..]),
            });
            coords.push(c);
        }
        let order = fit_order(vol.order, num_dims, use_pyramid);
        // dimensions this reader does not serve: more than one channel, wavelength, position or time point
        for (name, d) in [
            ("channels", order.c),
            ("wavelengths", order.l),
            ("positions", order.p),
            ("time points", order.t),
        ] {
            if d.is_some_and(|i| i < num_dims && max[i] > 0) {
                return err(format!("VSI: several {name} are not read natively"));
            }
        }
        let known: Vec<usize> = [order.z, order.t, order.c, order.l, order.p]
            .iter()
            .flatten()
            .copied()
            .collect();
        let level_index = use_pyramid.then(|| num_dims - 1);
        for (i, m) in max.iter().enumerate().skip(2) {
            if *m > 0 && !known.contains(&i) && Some(i) != level_index {
                return err("VSI: unknown tile coordinates");
            }
        }
        let z_index = order.z.filter(|i| *i > 1 && *i < num_dims);
        let frames = z_index.map_or(1, |i| max[i] as u32 + 1);
        let levels = level_index.map_or(1, |i| max[i] as usize + 1);
        let mut tiles = HashMap::with_capacity(n_chunks);
        for (c, t) in coords.iter().zip(tiles_raw) {
            let level = level_index.map_or(0, |i| c[i]);
            let z = z_index.map_or(0, |i| c[i]);
            tiles.insert((level, c[0], c[1], z), t);
        }
        Ok((
            Self {
                file,
                tile,
                components,
                compression,
                frames,
                levels,
                tiles,
            },
            order,
        ))
    }

    /// The pixels of a tile as `tile.0 * tile.1 * components` bytes.
    fn decode(&self, t: Tile) -> Result<Vec<u8>> {
        if t.size == 0 || t.size > 64 << 20 {
            return err("VSI: bad tile size");
        }
        let mut raw = vec![0u8; t.size as usize];
        read_at(&self.file, &mut raw, t.offset).map_err(|e| WsiError(format!("VSI: {e}")))?;
        let (w, h) = self.tile;
        if self.compression == COMPRESSION_RAW {
            if raw.len() < (w * h) as usize {
                return err("VSI: short tile");
            }
            raw.truncate((w * h) as usize);
            return Ok(raw);
        }
        let img = image::load_from_memory_with_format(&raw, image::ImageFormat::Jpeg)
            .map_err(|e| WsiError(format!("VSI: JPEG tile: {e}")))?;
        if img.width() != w || img.height() != h {
            return err("VSI: a tile is not of the size of the file's tiles");
        }
        Ok(if self.components == 1 {
            img.to_luma8().into_raw()
        } else {
            img.to_rgb8().into_raw()
        })
    }
}

/// Decoded tiles of all VSI slides, bounded by their size in bytes (`EXACT_VSI_CACHE_MB`, 256).
type TileKey = (u64, i32, i32, i32, i32);
fn tile_cache() -> &'static moka::sync::Cache<TileKey, Arc<Vec<u8>>> {
    static CACHE: OnceLock<moka::sync::Cache<TileKey, Arc<Vec<u8>>>> = OnceLock::new();
    CACHE.get_or_init(|| {
        let mb = std::env::var("EXACT_VSI_CACHE_MB")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(256);
        moka::sync::Cache::builder()
            .max_capacity(mb << 20)
            .weigher(|_, v: &Arc<Vec<u8>>| v.len().min(u32::MAX as usize) as u32)
            .build()
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// the slide
// ---------------------------------------------------------------------------------------------------------------------

/// A stack with pixels: the scan, or one of the pictures next to it.
struct Stack {
    vol: Volume,
    ets: Ets,
}

impl Stack {
    fn level_size(&self, level: usize) -> (u32, u32) {
        (
            (self.vol.size.0 >> level).max(1),
            (self.vol.size.1 >> level).max(1),
        )
    }

    #[allow(clippy::too_many_arguments)]
    /// Region of a level in level pixels, straight RGBA; transparent where the file has no tile or the level has no pixels.
    fn read(
        &self,
        id: u64,
        level: usize,
        x: i64,
        y: i64,
        w: u32,
        h: u32,
        z: u32,
    ) -> Result<RgbaImage> {
        let mut out = RgbaImage::new(w, h);
        let (lw, lh) = self.level_size(level);
        let (x0, y0) = (x.max(0), y.max(0));
        let (x1, y1) = ((x + w as i64).min(lw as i64), (y + h as i64).min(lh as i64));
        if x1 <= x0 || y1 <= y0 {
            return Ok(out);
        }
        let (tw, th) = (self.ets.tile.0 as i64, self.ets.tile.1 as i64);
        let comps = self.ets.components as usize;
        let z = z.min(self.ets.frames.saturating_sub(1)) as i32;
        for ty in (y0 / th)..=((y1 - 1) / th) {
            for tx in (x0 / tw)..=((x1 - 1) / tw) {
                let Some(&tile) = self.ets.tiles.get(&(level as i32, tx as i32, ty as i32, z))
                else {
                    continue;
                };
                let key = (id, level as i32, tx as i32, ty as i32, z);
                let px = match tile_cache().get(&key) {
                    Some(p) => p,
                    None => {
                        let p = Arc::new(self.ets.decode(tile)?);
                        tile_cache().insert(key, p.clone());
                        p
                    }
                };
                let (cx0, cy0) = (tx * tw, ty * th);
                for yy in y0.max(cy0)..y1.min(cy0 + th) {
                    let row = ((yy - cy0) * tw) as usize;
                    for xx in x0.max(cx0)..x1.min(cx0 + tw) {
                        let o = (row + (xx - cx0) as usize) * comps;
                        let p = if comps == 1 {
                            [px[o]; 3]
                        } else {
                            [px[o], px[o + 1], px[o + 2]]
                        };
                        out.put_pixel(
                            (xx - x) as u32,
                            (yy - y) as u32,
                            image::Rgba([p[0], p[1], p[2], 255]),
                        );
                    }
                }
            }
        }
        Ok(out)
    }
}

pub struct Vsi {
    id: u64,
    main: Stack,
    /// name -> the stack (overview, macro photo, ...)
    aux: Vec<(String, Stack)>,
    props: HashMap<String, String>,
}

/// The folder with the pixel files: `_<name>_`, and the spellings scanners write (anything but letters and digits becomes `_`,
/// some exports put an `Image_` in front).
fn data_dir(vsi: &Path) -> Option<PathBuf> {
    let (dir, stem) = (vsi.parent()?, vsi.file_stem()?.to_str()?);
    let plain = dir.join(format!("_{stem}_"));
    if plain.is_dir() {
        return Some(plain);
    }
    let flat = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect()
    };
    let want = [flat(stem), format!("Image_{}", flat(stem))];
    let mut found: Vec<(usize, PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().into_string().ok()?;
            let inner = name.strip_prefix('_')?.strip_suffix('_')?;
            let at = want.iter().position(|w| *w == flat(inner))?;
            e.path().is_dir().then(|| (at, e.path()))
        })
        .collect();
    found.sort();
    found.into_iter().next().map(|(_, p)| p)
}

/// stack id -> its `.ets` file; `None` when a stack folder has several image files (not understood).
fn ets_files(dir: &Path) -> Option<HashMap<i32, PathBuf>> {
    let mut out = HashMap::new();
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let name = e.file_name().into_string().ok()?;
        let Some(id) = name
            .strip_prefix("stack")
            .and_then(|d| d.parse::<i32>().ok())
        else {
            continue;
        };
        let files: Vec<PathBuf> = std::fs::read_dir(e.path())
            .ok()?
            .flatten()
            .map(|f| f.path())
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("ets")))
            .collect();
        // a stack folder may also hold the pixels of annotation blobs (`blob_21_f_Frame#0.ets`): the image is `frame_t*.ets`
        let image: Vec<PathBuf> = files
            .iter()
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("frame_t"))
            })
            .cloned()
            .collect();
        let pick = if image.is_empty() { files } else { image };
        match pick.len() {
            0 => {}
            1 => {
                out.insert(id, pick[0].clone());
            }
            _ => return None,
        }
    }
    Some(out)
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Vsi {
    pub fn open(path: &str) -> Result<Self> {
        let vsi = Path::new(path);
        let buf = std::fs::read(vsi).map_err(|e| WsiError(format!("{path}: {e}")))?;
        let tree = parse_tree(&buf)?;
        drop(buf);
        let mut volumes = volumes_of(&tree);
        if volumes.is_empty() {
            return err("VSI: no stacks with pixel files in the metadata");
        }
        let dir = data_dir(vsi)
            .ok_or_else(|| WsiError("VSI: the folder with the pixel files is missing".into()))?;
        let files = ets_files(&dir)
            .ok_or_else(|| WsiError("VSI: a stack folder holds several pixel files".into()))?;
        // the stacks in the order of their ids, as slideio pairs them
        volumes.sort_by_key(|v| v.stack_id);
        let mut main: Option<Stack> = None;
        let mut aux: Vec<(String, Stack)> = vec![];
        for vol in volumes {
            let Some(file) = files.get(&vol.stack_id) else {
                continue;
            };
            let is_scan = vol.kind == STACK_DEFAULT || vol.kind == STACK_EFI;
            if !is_scan {
                // pictures next to the scan: read when asked for; one that cannot be read is simply not offered
                if let Ok((ets, _)) = Ets::open(file, &vol) {
                    aux.push((stack_type_name(vol.kind).to_string(), Stack { vol, ets }));
                }
                continue;
            }
            if main.is_none() {
                let (ets, order) = Ets::open(file, &vol)?;
                main = Some(Stack {
                    vol: Volume { order, ..vol },
                    ets,
                });
            }
        }
        let main = main.ok_or_else(|| WsiError("VSI: no scan among the stacks".into()))?;
        if main.ets.levels == 0 || main.ets.levels > 40 {
            return err("VSI: unusual pyramid");
        }
        let mut props = HashMap::new();
        let bg = main.vol.background;
        props.insert(
            "openslide.background-color".to_string(),
            format!("{:02X}{:02X}{:02X}", bg[0], bg[1], bg[2]),
        );
        props.insert("openslide.mpp-x".into(), main.vol.mpp.0.to_string());
        props.insert("openslide.mpp-y".into(), main.vol.mpp.1.to_string());
        props.insert(
            "openslide.objective-power".into(),
            main.vol.magnification.to_string(),
        );
        props.insert("openslide.vendor".into(), "olympus-vsi".into());
        if !main.vol.name.is_empty() {
            props.insert("vsi.stack-name".into(), main.vol.name.clone());
        }
        Ok(Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            main,
            aux,
            props,
        })
    }
}

impl Slide for Vsi {
    fn level_dimensions(&self) -> Vec<(u64, u64)> {
        (0..self.main.ets.levels)
            .map(|l| {
                let (w, h) = self.main.level_size(l);
                (w as u64, h as u64)
            })
            .collect()
    }
    fn level_downsamples(&self) -> Vec<f64> {
        (0..self.main.ets.levels)
            .map(|l| (1u64 << l) as f64)
            .collect()
    }
    fn best_level_for_downsample(&self, d: f64) -> usize {
        // numpy `argmin(|downsamples - d|)`, as the slideio reader answers
        (0..self.main.ets.levels)
            .min_by(|a, b| {
                let da = ((1u64 << a) as f64 - d).abs();
                let db = ((1u64 << b) as f64 - d).abs();
                da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
            })
            .unwrap_or(0)
    }
    fn properties(&self) -> HashMap<String, String> {
        self.props.clone()
    }
    fn frame_count(&self) -> u32 {
        self.main.ets.frames
    }
    fn frame_kind(&self) -> FrameKind {
        if self.main.ets.frames > 1 {
            FrameKind::ZStack
        } else {
            FrameKind::None
        }
    }
    fn frame_labels(&self) -> Vec<String> {
        let n = self.main.ets.frames;
        let step = self.main.vol.z_step;
        (0..n)
            .map(|i| {
                if step > 0.0 {
                    format!("{:.2} µ", step * i as f64)
                } else {
                    format!("Frame {i}")
                }
            })
            .collect()
    }
    fn z_positions(&self) -> Option<(Vec<f64>, String)> {
        let step = self.main.vol.z_step;
        (self.main.ets.frames > 1 && step > 0.0).then(|| {
            (
                (0..self.main.ets.frames).map(|i| step * i as f64).collect(),
                "µm".to_string(),
            )
        })
    }
    fn associated_images(&self) -> Vec<String> {
        self.aux.iter().map(|(n, _)| n.clone()).collect()
    }
    fn associated_image(&self, name: &str) -> Result<image::RgbImage> {
        let (_, stack) = self
            .aux
            .iter()
            .find(|(n, _)| n == name)
            .ok_or_else(|| WsiError("no such associated image".into()))?;
        // the finest level that is not more than 16 megapixels
        let level = (0..stack.ets.levels)
            .find(|l| {
                let (w, h) = stack.level_size(*l);
                (w as u64) * (h as u64) <= 16_000_000
            })
            .unwrap_or(stack.ets.levels.saturating_sub(1));
        let (w, h) = stack.level_size(level);
        let rgba = stack.read(
            self.id ^ ((level as u64 + 1) << 56) ^ name.len() as u64,
            level,
            0,
            0,
            w,
            h,
            0,
        )?;
        Ok(crate::composite(&rgba, stack.vol.background))
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
        if level >= self.main.ets.levels {
            return err("Invalid level");
        }
        // positions are level-0 pixels; the levels are exact halvings
        let ds = (1u64 << level) as f64;
        let (lx, ly) = (
            (x as f64 / ds).round() as i64,
            (y as f64 / ds).round() as i64,
        );
        self.main.read(self.id, level, lx, ly, w, h, frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A volume header + fields as the files have them: header(24) then fields of 16 bytes (+ payload).
    fn volume(fields: &[(i32, i32, Vec<u8>, bool)]) -> Vec<u8> {
        // fields: (field type, tag, payload, inline) -- inline payloads are the 4 bytes of the size field
        let mut out = vec![];
        out.extend_from_slice(&24u16.to_le_bytes());
        out.extend_from_slice(&21321u16.to_le_bytes());
        out.extend_from_slice(&1u32.to_le_bytes());
        out.extend_from_slice(&24i64.to_le_bytes());
        out.extend_from_slice(&(fields.len() as u32).to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        let mut pos = 24usize;
        for (i, (ft, tag, payload, inline)) in fields.iter().enumerate() {
            let size = if *inline {
                u32::from_le_bytes(payload[..4].try_into().unwrap())
            } else {
                payload.len() as u32
            };
            let len = 16 + if *inline { 0 } else { payload.len() };
            let nxt = if i + 1 == fields.len() {
                0
            } else {
                (pos + len) as i32
            };
            out.extend_from_slice(&ft.to_le_bytes());
            out.extend_from_slice(&tag.to_le_bytes());
            out.extend_from_slice(&nxt.to_le_bytes());
            out.extend_from_slice(&size.to_le_bytes());
            if !*inline {
                out.extend_from_slice(payload);
            }
            pos += len;
        }
        out
    }

    fn file(vol: Vec<u8>) -> Vec<u8> {
        let mut f = b"II*\0\x08\0\0\0".to_vec();
        f.extend(vol);
        f
    }

    #[test]
    fn the_tag_tree_is_read_with_typed_values() {
        let utf16 = "10^-6m^1"
            .encode_utf16()
            .flat_map(|c| c.to_le_bytes())
            .collect::<Vec<u8>>();
        let doubles = [0.25f64, 0.5]
            .iter()
            .flat_map(|d| d.to_le_bytes())
            .collect::<Vec<u8>>();
        let ints = [0i32, 0, 1000, 800]
            .iter()
            .flat_map(|d| d.to_le_bytes())
            .collect::<Vec<u8>>();
        let buf = file(volume(&[
            (0x4000_0005, 2074, 256i32.to_le_bytes().to_vec(), true), // inline int
            (13, 2020, utf16, false),                                 // string
            (260, 2019, doubles, false),                              // vector of doubles
            (259, 2053, ints, false),                                 // vector of ints
        ]));
        let tree = parse_tree(&buf).unwrap();
        assert_eq!(tree.len(), 4);
        assert_eq!(tree[0].value, Val::Int(256));
        assert_eq!(tree[1].value, Val::Str("10^-6m^1".into()));
        assert_eq!(tree[2].value.floats(), Some(vec![0.25, 0.5]));
        assert_eq!(tree[3].value.ints(), Some(vec![0, 0, 1000, 800]));
    }

    #[test]
    fn a_file_that_is_not_a_vsi_is_refused() {
        assert!(parse_tree(b"MM\0*\0\0\0\x08").is_err());
        assert!(parse_tree(&file(vec![0u8; 24])).is_err()); // header size 0
                                                            // a field chain that points back
        let mut v = volume(&[
            (0x4000_0005, 1, vec![0, 0, 0, 0], true),
            (0x4000_0005, 2, vec![0, 0, 0, 0], true),
        ]);
        v[24 + 8..24 + 12].copy_from_slice(&0i32.to_le_bytes()); // first field links to the volume start
        assert!(parse_tree(&file(v)).is_err());
    }

    #[test]
    fn the_dimension_orders_follow_the_tile_coordinates() {
        // a z-stack: x, y, z, level -> z is coordinate 2 as stated
        let o = fit_order(
            Order {
                z: Some(2),
                ..Default::default()
            },
            4,
            true,
        );
        assert_eq!(o.z, Some(2));
        // the stated z is the level: dropped
        let o = fit_order(
            Order {
                z: Some(3),
                ..Default::default()
            },
            4,
            true,
        );
        assert_eq!(o.z, None);
        // every stated order is past the last dimension: the file counted one further
        let o = fit_order(
            Order {
                z: Some(4),
                c: Some(3),
                ..Default::default()
            },
            4,
            true,
        );
        assert_eq!((o.z, o.c), (Some(3), Some(2)));
        // nothing stated, none to infer from a plain image
        assert_eq!(fit_order(Order::default(), 3, true), Order::default());
    }

    #[test]
    fn an_unknown_unit_gives_no_pixel_size() {
        assert_eq!(unit_to_um("10^-6m^1"), Some(1.0));
        assert_eq!(unit_to_um("10^-3m^1"), Some(1000.0));
        assert_eq!(unit_to_um("furlong"), None);
    }

    /// A pixel file with 2 x 2 tiles of 16 x 16 pixels at level 0 (the one at the bottom right is not in the file) and one tile at level 1.
    fn pixel_file(dir: &Path) -> PathBuf {
        let jpeg = |rgb: [u8; 3], size: u32| {
            let img = image::RgbImage::from_pixel(size, size, image::Rgb(rgb));
            let mut out = vec![];
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 95)
                .encode_image(&img)
                .unwrap();
            out
        };
        let tiles: Vec<([i32; 4], Vec<u8>)> = vec![
            ([0, 0, 0, 0], jpeg([200, 20, 20], 16)),
            ([1, 0, 0, 0], jpeg([20, 200, 20], 16)),
            ([0, 1, 0, 0], jpeg([20, 20, 200], 16)),
            ([0, 0, 0, 1], jpeg([100, 100, 100], 16)),
        ];
        let mut data = vec![0u8; 64 + 228];
        let mut table = vec![];
        for (c, jpg) in &tiles {
            let offset = data.len() as i64;
            data.extend_from_slice(jpg);
            table.extend_from_slice(&[0u8; 4]);
            for v in c {
                table.extend_from_slice(&v.to_le_bytes());
            }
            table.extend_from_slice(&offset.to_le_bytes());
            table.extend_from_slice(&(jpg.len() as u32).to_le_bytes());
            table.extend_from_slice(&[0u8; 4]);
        }
        let table_pos = data.len() as i64;
        data.extend_from_slice(&table);
        data[..4].copy_from_slice(b"SIS\0");
        data[4..8].copy_from_slice(&64u32.to_le_bytes());
        data[12..16].copy_from_slice(&4u32.to_le_bytes()); // x, y, z, level
        data[16..24].copy_from_slice(&64i64.to_le_bytes());
        data[24..28].copy_from_slice(&228u32.to_le_bytes());
        data[32..40].copy_from_slice(&table_pos.to_le_bytes());
        data[40..44].copy_from_slice(&(tiles.len() as u32).to_le_bytes());
        let h = 64;
        data[h..h + 4].copy_from_slice(b"ETS\0");
        for (i, v) in [
            (8, 2u32),
            (12, 3),
            (16, 4),
            (20, 2),
            (24, 90),
            (28, 16),
            (32, 16),
            (36, 1),
        ] {
            data[h + i..h + i + 4].copy_from_slice(&v.to_le_bytes());
        }
        data[h + 152..h + 156].copy_from_slice(&1u32.to_le_bytes()); // uses a pyramid
        let path = dir.join("frame_t.ets");
        std::fs::write(&path, data).unwrap();
        path
    }

    #[test]
    fn a_region_is_composed_from_the_tiles_and_missing_tiles_stay_transparent() {
        let dir = std::env::temp_dir().join(format!("exact-vsi-ets-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let vol = Volume {
            stack_id: 1,
            kind: 0,
            name: String::new(),
            size: (32, 32),
            mpp: (0.0, 0.0),
            magnification: 0.0,
            background: [238; 3],
            order: Order::default(),
            z_step: 0.0,
        };
        let (ets, order) = Ets::open(&pixel_file(&dir), &vol).unwrap();
        assert_eq!((ets.levels, ets.frames, ets.tile), (2, 1, (16, 16)));
        let stack = Stack { vol, ets };
        assert_eq!(stack.level_size(1), (16, 16));
        let _ = order;
        // a window over the corner where all four tiles meet
        let r = stack.read(9_000_001, 0, 8, 8, 16, 16, 0).unwrap();
        let near = |p: &image::Rgba<u8>, c: [u8; 3]| {
            (0..3).all(|i| (p[i] as i32 - c[i] as i32).abs() <= 8) && p[3] == 255
        };
        assert!(near(r.get_pixel(0, 0), [200, 20, 20])); // top left tile
        assert!(near(r.get_pixel(15, 0), [20, 200, 20])); // top right tile
        assert!(near(r.get_pixel(0, 15), [20, 20, 200])); // bottom left tile
        assert_eq!(r.get_pixel(15, 15)[3], 0); // no tile there
                                               // level 1 is one tile; the part of the window past its edge is transparent
        let l1 = stack.read(9_000_001, 1, 8, 8, 16, 16, 0).unwrap();
        assert!(near(l1.get_pixel(0, 0), [100, 100, 100]));
        assert_eq!(l1.get_pixel(15, 15)[3], 0);
        // a window beside the image is empty
        assert!(stack
            .read(9_000_001, 0, 100, 100, 4, 4, 0)
            .unwrap()
            .pixels()
            .all(|p| p[3] == 0));
        std::fs::remove_dir_all(&dir).ok();
    }
}
