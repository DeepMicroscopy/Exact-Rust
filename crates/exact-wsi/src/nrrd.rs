//! Label volumes in NRRD files (`.nrrd`, 3D Slicer's `.seg.nrrd`): integer labels on a grid with a position in space, read
//! only to be drawn over a volume. Slicer stores a segmentation as a label map plus `SegmentN_*` fields (name, colour, label
//! value, layer); overlapping segments live in separate layers, as a leading `list` axis of a 4D file. A plain label map without
//! those fields gets a segment per label value.
//!
//! The grid keeps its own geometry: `Nrrd::resample` looks every voxel of a target grid (the NIfTI volume, see
//! `nifti::Grid`) up in millimetres, so tilted, flipped and swapped axes need no special cases.

use crate::{err, Result, WsiError};
use std::collections::HashMap;
use std::io::Read;

pub type M4 = [[f64; 4]; 4];

/// A segment of the file, `index` counts from 0 in the order of the file. Voxels carry `index + 1` (0 = background).
#[derive(Clone, Debug, PartialEq)]
pub struct Segment {
    pub index: usize,
    pub id: String,
    pub name: String,
    pub color: [u8; 3],
    pub label: u32,
    pub layer: usize,
    /// voxels of the segment in the file
    pub voxels: u64,
}

pub struct Nrrd {
    pub dims: [usize; 3],
    /// voxel index (x fastest) to RAS millimetres
    pub affine: M4,
    /// `segment index + 1`, 0 outside; where segments overlap the one of the later layer
    pub labels: Vec<u16>,
    pub segments: Vec<Segment>,
    /// the file has overlapping segments in layers
    pub layered: bool,
}

/// What a file's voxels become on a target grid.
pub struct Resampled {
    pub shape: [usize; 3],
    pub labels: Vec<u16>,
    /// target voxels that lie inside the label grid
    pub inside: u64,
    /// labelled volume that is on the target grid as a fraction of the labelled volume of the file (1 = nothing cut off, 0 = no overlap)
    pub kept: f64,
}

const PALETTE: [[u8; 3]; 10] = [
    [230, 25, 75],
    [60, 180, 75],
    [255, 225, 25],
    [0, 130, 200],
    [245, 130, 48],
    [145, 30, 180],
    [70, 240, 240],
    [240, 50, 230],
    [210, 245, 60],
    [250, 190, 212],
];

fn fields(head: &str) -> (HashMap<String, String>, HashMap<String, String>) {
    let (mut f, mut kv) = (HashMap::new(), HashMap::new());
    for line in head.lines().skip(1) {
        if line.starts_with('#') || line.trim().is_empty() {
            continue;
        }
        if let Some((k, v)) = line.split_once(":=") {
            kv.insert(k.trim().to_string(), v.trim().to_string());
        } else if let Some((k, v)) = line.split_once(':') {
            f.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }
    (f, kv)
}

/// `(1,2,3) (4,5,6) none` -> vectors, None for `none`
fn vectors(s: &str) -> Result<Vec<Option<[f64; 3]>>> {
    let mut out = vec![];
    let mut rest = s.trim();
    while !rest.is_empty() {
        if let Some(r) = rest.strip_prefix("none") {
            out.push(None);
            rest = r.trim_start();
        } else if rest.starts_with('(') {
            let end = rest
                .find(')')
                .ok_or_else(|| WsiError("bad vector in the NRRD header".into()))?;
            let v: Vec<f64> = rest[1..end]
                .split(',')
                .map(|x| x.trim().parse::<f64>())
                .collect::<std::result::Result<_, _>>()
                .map_err(|_| WsiError("bad number in the NRRD header".into()))?;
            if v.len() != 3 {
                return err("only 3D space vectors are supported");
            }
            out.push(Some([v[0], v[1], v[2]]));
            rest = rest[end + 1..].trim_start();
        } else {
            return err("bad vector list in the NRRD header");
        }
    }
    Ok(out)
}

fn invert(m: &M4) -> Option<M4> {
    // 3x3 inverse by cofactors, the translation follows
    let a = |i: usize, j: usize| m[i][j];
    let det = a(0, 0) * (a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1))
        - a(0, 1) * (a(1, 0) * a(2, 2) - a(1, 2) * a(2, 0))
        + a(0, 2) * (a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0));
    if det.abs() < 1e-12 {
        return None;
    }
    let mut r = [[0.0; 4]; 4];
    r[0][0] = (a(1, 1) * a(2, 2) - a(1, 2) * a(2, 1)) / det;
    r[0][1] = (a(0, 2) * a(2, 1) - a(0, 1) * a(2, 2)) / det;
    r[0][2] = (a(0, 1) * a(1, 2) - a(0, 2) * a(1, 1)) / det;
    r[1][0] = (a(1, 2) * a(2, 0) - a(1, 0) * a(2, 2)) / det;
    r[1][1] = (a(0, 0) * a(2, 2) - a(0, 2) * a(2, 0)) / det;
    r[1][2] = (a(0, 2) * a(1, 0) - a(0, 0) * a(1, 2)) / det;
    r[2][0] = (a(1, 0) * a(2, 1) - a(1, 1) * a(2, 0)) / det;
    r[2][1] = (a(0, 1) * a(2, 0) - a(0, 0) * a(2, 1)) / det;
    r[2][2] = (a(0, 0) * a(1, 1) - a(0, 1) * a(1, 0)) / det;
    for row in r.iter_mut().take(3) {
        row[3] = -(row[0] * a(0, 3) + row[1] * a(1, 3) + row[2] * a(2, 3));
    }
    r[3][3] = 1.0;
    Some(r)
}

fn apply(m: &M4, p: [f64; 3]) -> [f64; 3] {
    let mut o = [0.0; 3];
    for (i, row) in m.iter().take(3).enumerate() {
        o[i] = row[0] * p[0] + row[1] * p[1] + row[2] * p[2] + row[3];
    }
    o
}

/// bytes per value and signedness of an NRRD `type`
fn kind_of(t: &str) -> Result<(usize, bool)> {
    Ok(match t.trim().to_lowercase().as_str() {
        "uchar" | "unsigned char" | "uint8" | "uint8_t" => (1, false),
        "signed char" | "int8" | "int8_t" => (1, true),
        "ushort" | "unsigned short" | "unsigned short int" | "uint16" | "uint16_t" => (2, false),
        "short" | "short int" | "signed short" | "signed short int" | "int16" | "int16_t" => {
            (2, true)
        }
        "uint" | "unsigned int" | "uint32" | "uint32_t" => (4, false),
        "int" | "signed int" | "int32" | "int32_t" => (4, true),
        other => {
            return err(format!(
                "the NRRD data type \"{other}\" is not an integer label type"
            ))
        }
    })
}

fn parse_segments(kv: &HashMap<String, String>) -> Vec<Segment> {
    let mut segs = vec![];
    for n in 0.. {
        let get = |k: &str| kv.get(&format!("Segment{n}_{k}"));
        let Some(label) = get("LabelValue") else {
            // segments are numbered without gaps
            if get("ID").is_none() && get("Name").is_none() {
                break;
            }
            continue;
        };
        let color = get("Color")
            .map(|c| {
                let v: Vec<f64> = c
                    .split_whitespace()
                    .filter_map(|x| x.parse().ok())
                    .collect();
                if v.len() >= 3 {
                    [0, 1, 2].map(|i| (v[i].clamp(0.0, 1.0) * 255.0).round() as u8)
                } else {
                    PALETTE[n % PALETTE.len()]
                }
            })
            .unwrap_or(PALETTE[n % PALETTE.len()]);
        let id = get("ID")
            .cloned()
            .unwrap_or_else(|| format!("Segment_{}", n + 1));
        segs.push(Segment {
            index: segs.len(),
            name: get("Name").cloned().unwrap_or_else(|| id.clone()),
            id,
            color,
            label: label.trim().parse().unwrap_or(0),
            layer: get("Layer")
                .and_then(|l| l.trim().parse().ok())
                .unwrap_or(0),
            voxels: 0,
        });
    }
    segs
}

/// Reads a label volume. Errors say what is not supported.
pub fn read(path: &str) -> Result<Nrrd> {
    // the path stays out of the message: it goes to the browser
    let mut f = std::fs::File::open(path)
        .map_err(|e| WsiError(format!("the file cannot be opened ({e})")))?;
    let mut bytes = Vec::new();
    f.read_to_end(&mut bytes)
        .map_err(|e| WsiError(format!("the file cannot be read ({e})")))?;
    parse(&bytes)
}

pub fn parse(bytes: &[u8]) -> Result<Nrrd> {
    if !bytes.starts_with(b"NRRD") {
        return err("not an NRRD file");
    }
    let end = bytes
        .windows(2)
        .position(|w| w == b"\n\n")
        .ok_or_else(|| WsiError("the NRRD header does not end".into()))?;
    let head = String::from_utf8_lossy(&bytes[..end]).to_string();
    let body = &bytes[end + 2..];
    let (f, kv) = fields(&head);
    let get = |k: &str| {
        f.get(k)
            .cloned()
            .ok_or_else(|| WsiError(format!("the NRRD header has no \"{k}\"")))
    };
    if f.contains_key("data file") || f.contains_key("datafile") {
        return err("NRRD files with a detached data file are not supported");
    }
    let (width, signed) = kind_of(&get("type")?)?;
    let dimension: usize = get("dimension")?
        .parse()
        .map_err(|_| WsiError("bad dimension".into()))?;
    let sizes: Vec<usize> = get("sizes")?
        .split_whitespace()
        .map(|s| s.parse::<usize>())
        .collect::<std::result::Result<_, _>>()
        .map_err(|_| WsiError("bad sizes".into()))?;
    if sizes.len() != dimension || !(3..=4).contains(&dimension) {
        return err(format!(
            "{dimension}-dimensional NRRD files are not supported (3D, or 4D with layers)"
        ));
    }
    let dirs = vectors(&get("space directions")?)?;
    if dirs.len() != dimension {
        return err("the number of space directions does not match the dimension");
    }
    // a leading axis without a direction is the layer axis of overlapping segments
    let layered = dimension == 4;
    if layered && dirs[0].is_some() {
        return err("4D NRRD files must have a leading layer axis (space directions: none ...)");
    }
    let skip = usize::from(layered);
    let (layers, dims) = if layered {
        (sizes[0], [sizes[1], sizes[2], sizes[3]])
    } else {
        (1, [sizes[0], sizes[1], sizes[2]])
    };
    let origin = match f.get("space origin") {
        Some(o) => vectors(o)?
            .first()
            .copied()
            .flatten()
            .ok_or_else(|| WsiError("bad space origin".into()))?,
        None => [0.0; 3],
    };
    // file space to RAS
    let space = f.get("space").map(|s| s.to_lowercase()).unwrap_or_default();
    let sign = match space.as_str() {
        "left-posterior-superior" | "lps" | "3d-left-handed" => [-1.0, -1.0, 1.0],
        "right-anterior-superior" | "ras" | "3d-right-handed" => [1.0, 1.0, 1.0],
        "left-anterior-superior" | "las" => [-1.0, 1.0, 1.0],
        "" => return err("the NRRD file does not say which space it is in"),
        other => return err(format!("the NRRD space \"{other}\" is not supported")),
    };
    let mut affine = [[0.0; 4]; 4];
    for (a, d) in dirs[skip..].iter().enumerate() {
        let d = d.ok_or_else(|| WsiError("a spatial axis has no direction".into()))?;
        for i in 0..3 {
            affine[i][a] = sign[i] * d[i];
        }
    }
    for i in 0..3 {
        affine[i][3] = sign[i] * origin[i];
    }
    affine[3][3] = 1.0;

    let voxels = dims[0]
        .checked_mul(dims[1])
        .and_then(|v| v.checked_mul(dims[2]))
        .filter(|v| *v > 0 && *v <= 1 << 31)
        .ok_or_else(|| WsiError("the label volume is empty or too large".into()))?;
    let total = voxels * layers * width;
    let enc = f
        .get("encoding")
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "raw".into());
    let mut data = Vec::new();
    match enc.as_str() {
        "raw" => data.extend_from_slice(body),
        "gzip" | "gz" => {
            flate2::read::MultiGzDecoder::new(body)
                .take(total as u64)
                .read_to_end(&mut data)
                .map_err(|e| WsiError(format!("the NRRD data is damaged: {e}")))?;
        }
        other => {
            return err(format!(
                "the NRRD encoding \"{other}\" is not supported (raw or gzip)"
            ))
        }
    }
    if data.len() < total {
        return err("the NRRD data is shorter than its header says");
    }
    let big = f
        .get("endian")
        .is_some_and(|e| e.eq_ignore_ascii_case("big"));
    let value = |i: usize| -> u32 {
        let b = &data[i * width..(i + 1) * width];
        match (width, signed, big) {
            (1, false, _) => b[0] as u32,
            (1, true, _) => (b[0] as i8).max(0) as u32,
            (2, false, false) => u16::from_le_bytes([b[0], b[1]]) as u32,
            (2, false, true) => u16::from_be_bytes([b[0], b[1]]) as u32,
            (2, true, false) => i16::from_le_bytes([b[0], b[1]]).max(0) as u32,
            (2, true, true) => i16::from_be_bytes([b[0], b[1]]).max(0) as u32,
            (_, false, false) => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            (_, false, true) => u32::from_be_bytes([b[0], b[1], b[2], b[3]]),
            (_, true, false) => i32::from_le_bytes([b[0], b[1], b[2], b[3]]).max(0) as u32,
            (_, true, true) => i32::from_be_bytes([b[0], b[1], b[2], b[3]]).max(0) as u32,
        }
    };

    let mut segments = parse_segments(&kv);
    let slicer = !segments.is_empty();
    if !slicer {
        // a plain label map: a segment per value present
        let mut seen: Vec<u32> = (0..voxels * layers)
            .map(value)
            .filter(|v| *v != 0)
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect();
        seen.truncate(255);
        for (n, v) in seen.into_iter().enumerate() {
            segments.push(Segment {
                index: n,
                id: format!("Label_{v}"),
                name: format!("Label {v}"),
                color: PALETTE[n % PALETTE.len()],
                label: v,
                layer: 0,
                voxels: 0,
            });
        }
    }
    if segments.len() > u16::MAX as usize - 1 {
        return err("too many segments");
    }
    // (layer, value) -> segment index + 1
    let lookup: HashMap<(usize, u32), u16> = segments
        .iter()
        .map(|s| ((s.layer, s.label), (s.index + 1) as u16))
        .collect();
    let mut labels = vec![0u16; voxels];
    let mut counts = vec![0u64; segments.len()];
    for (v, label) in labels.iter_mut().enumerate() {
        for l in 0..layers {
            // layer is the fastest axis in a 4D file
            let i = if layered { v * layers + l } else { v };
            let val = value(i);
            if val == 0 {
                continue;
            }
            if let Some(&s) = lookup.get(&(l, val)) {
                counts[(s - 1) as usize] += 1;
                *label = s;
            }
        }
    }
    for (s, c) in segments.iter_mut().zip(counts) {
        s.voxels = c;
    }
    Ok(Nrrd {
        dims,
        affine,
        labels,
        segments,
        layered,
    })
}

impl Nrrd {
    /// Looks every voxel of a grid of `shape` whose voxel (x, y, z) sits at `target` (voxel to RAS mm) up in this volume
    /// (nearest label), x fastest.
    pub fn resample(&self, shape: [usize; 3], target: &M4) -> Result<Resampled> {
        let inv = invert(&self.affine)
            .ok_or_else(|| WsiError("the label volume's axes are degenerate".into()))?;
        // the step in file voxels for one step along each target axis
        let o = apply(&inv, apply(target, [0.0, 0.0, 0.0]));
        let step: [[f64; 3]; 3] = [0, 1, 2].map(|a| {
            let mut p = [0.0; 3];
            p[a] = 1.0;
            let q = apply(&inv, apply(target, p));
            [q[0] - o[0], q[1] - o[1], q[2] - o[2]]
        });
        let [nx, ny, nz] = shape;
        let mut out = vec![0u16; nx * ny * nz];
        let (mut inside, mut kept_vox) = (0u64, 0u64);
        let d = self.dims;
        for z in 0..nz {
            for y in 0..ny {
                let base = [
                    o[0] + step[1][0] * y as f64 + step[2][0] * z as f64,
                    o[1] + step[1][1] * y as f64 + step[2][1] * z as f64,
                    o[2] + step[1][2] * y as f64 + step[2][2] * z as f64,
                ];
                let row = (z * ny + y) * nx;
                for x in 0..nx {
                    let xf = x as f64;
                    let i = (base[0] + step[0][0] * xf).round();
                    let j = (base[1] + step[0][1] * xf).round();
                    let k = (base[2] + step[0][2] * xf).round();
                    if i < 0.0
                        || j < 0.0
                        || k < 0.0
                        || i >= d[0] as f64
                        || j >= d[1] as f64
                        || k >= d[2] as f64
                    {
                        continue;
                    }
                    inside += 1;
                    let l = self.labels[(k as usize * d[1] + j as usize) * d[0] + i as usize];
                    if l != 0 {
                        out[row + x] = l;
                        kept_vox += 1;
                    }
                }
            }
        }
        let vol = |m: &M4| {
            let c = |a: usize| (0..3).map(|i| m[i][a] * m[i][a]).sum::<f64>().sqrt();
            c(0) * c(1) * c(2)
        };
        // labelled voxels of the picture (a voxel in two overlapping segments counts once, as it does in the resampled labels)
        let src = self.labels.iter().filter(|l| **l != 0).count() as u64;
        let src_mm3 = src as f64 * vol(&self.affine);
        let kept_mm3 = kept_vox as f64 * vol(target);
        let kept = if src_mm3 > 0.0 {
            (kept_mm3 / src_mm3).min(1.0)
        } else {
            0.0
        };
        Ok(Resampled {
            shape,
            labels: out,
            inside,
            kept,
        })
    }
}

/// The labels on the coarse grid of the 3D render, two bytes per cell (coverage 0..255, segment index + 1): `dims` = (columns, rows,
/// slices) of the render grid, whose columns and rows run as the axial plane is shown (column = voxel x counted from the right, row
/// = voxel y counted from the front). The segment of a cell is the one most of its labelled voxels belong to (a majority vote
/// that is exact when one segment holds more than half). `hidden[i]` leaves segment i out.
pub fn render_cells(
    labels: &[u16],
    shape: [usize; 3],
    dims: (usize, usize, usize),
    hidden: &[bool],
) -> Vec<u8> {
    let [nx, ny, nz] = shape;
    let (ow, oh, od) = dims;
    let cells = ow * oh * od;
    let (mut count, mut cand, mut votes) =
        (vec![0u32; cells], vec![0u16; cells], vec![0u32; cells]);
    let axis = |n: usize, o: usize, flip: bool| -> Vec<usize> {
        (0..n)
            .map(|i| (if flip { n - 1 - i } else { i }) * o / n)
            .collect()
    };
    let (cx, cy, cz) = (axis(nx, ow, true), axis(ny, oh, true), axis(nz, od, false));
    for z in 0..nz {
        for y in 0..ny {
            let base = (cz[z] * oh + cy[y]) * ow;
            let row = &labels[(z * ny + y) * nx..(z * ny + y + 1) * nx];
            for (x, &l) in row.iter().enumerate() {
                if l == 0 || hidden.get((l - 1) as usize).copied().unwrap_or(false) {
                    continue;
                }
                let c = base + cx[x];
                count[c] += 1;
                if votes[c] == 0 {
                    cand[c] = l;
                    votes[c] = 1;
                } else if cand[c] == l {
                    votes[c] += 1;
                } else {
                    votes[c] -= 1;
                }
            }
        }
    }
    // voxels per cell along each axis, to say how much of a cell is labelled
    let per = |n: usize, o: usize, flip: bool| {
        let mut c = vec![0u64; o];
        for v in axis(n, o, flip) {
            c[v] += 1;
        }
        c
    };
    let (px, py, pz) = (per(nx, ow, true), per(ny, oh, true), per(nz, od, false));
    let mut out = vec![0u8; cells * 2];
    for (idx, &n) in count.iter().enumerate() {
        if n == 0 {
            continue;
        }
        let (i, j, k) = (idx % ow, (idx / ow) % oh, idx / (ow * oh));
        let full = (px[i] * py[j] * pz[k]).max(1);
        out[idx * 2] = ((n as u64 * 255).div_ceil(full)).min(255) as u8;
        out[idx * 2 + 1] = cand[idx].min(255) as u8;
    }
    out
}

/// A mask on the display grid of a volume (`size` = columns x rows per slice, the slices in order; the axial picture as `plane_labels`
/// cuts it) on the voxels of the volume's reoriented grid `shape` (x, y, z; x fastest): the voxel's column is counted from the
/// right, its row from the front, in the nearest picture pixel. The inverse of `plane_labels` for the axial plane.
pub fn display_to_voxels(mask: &[u8], size: (usize, usize), shape: [usize; 3]) -> Vec<u8> {
    let [nx, ny, nz] = shape;
    let (w, h) = size;
    let pix = |n: usize, o: usize, i: usize| {
        ((((n - 1 - i) as f64 + 0.5) * o as f64 / n as f64) as usize).min(o - 1)
    };
    let (cols, rows): (Vec<usize>, Vec<usize>) = (
        (0..nx).map(|x| pix(nx, w, x)).collect(),
        (0..ny).map(|y| pix(ny, h, y)).collect(),
    );
    let mut out = vec![0u8; nx * ny * nz];
    for z in 0..nz {
        for y in 0..ny {
            let src = &mask[(z * h + rows[y]) * w..(z * h + rows[y] + 1) * w];
            let dst = &mut out[(z * ny + y) * nx..(z * ny + y + 1) * nx];
            for (d, &c) in dst.iter_mut().zip(&cols) {
                *d = src[c];
            }
        }
    }
    out
}

/// A segment of a file to write: `label` is its value in its `layer` (see `write_seg`).
pub struct OutSegment {
    pub id: String,
    pub name: String,
    pub color: [u8; 3],
    pub label: u32,
    pub layer: usize,
}

/// A 3D Slicer segmentation (`.seg.nrrd`) on the grid `dims` whose voxel (x, y, z) sits at `affine` (voxel to RAS mm): `layers`
/// are label maps of that grid (value = the `label` of the segment that holds the voxel in that layer, 0 elsewhere); segments that
/// overlap have to be in different layers. One layer is a 3D file, several a 4D one with a leading layer axis, as Slicer writes
/// them. Written as LPS, gzip.
pub fn write_seg(
    dims: [usize; 3],
    affine: &M4,
    layers: &[Vec<u16>],
    segments: &[OutSegment],
) -> Vec<u8> {
    use std::io::Write;
    let [nx, ny, nz] = dims;
    let wide = layers.iter().any(|l| l.iter().any(|v| *v > 255));
    let n = nx * ny * nz;
    let multi = layers.len() > 1;
    // sizes, directions (RAS columns to LPS: x and y negated)
    let dir = |a: usize| format!("({},{},{})", -affine[0][a], -affine[1][a], affine[2][a]);
    let mut h = String::from("NRRD0004\n# Complete NRRD file format specification at:\n# http://teem.sourceforge.net/nrrd/format.html\n");
    h += &format!(
        "type: {}\ndimension: {}\nspace: left-posterior-superior\n",
        if wide {
            "unsigned short"
        } else {
            "unsigned char"
        },
        if multi { 4 } else { 3 }
    );
    if multi {
        h += &format!("sizes: {} {nx} {ny} {nz}\nspace directions: none {} {} {}\nkinds: list domain domain domain\n", layers.len(), dir(0), dir(1), dir(2));
    } else {
        h += &format!(
            "sizes: {nx} {ny} {nz}\nspace directions: {} {} {}\nkinds: domain domain domain\n",
            dir(0),
            dir(1),
            dir(2)
        );
    }
    h += &format!(
        "encoding: gzip\nspace origin: ({},{},{})\n",
        -affine[0][3], -affine[1][3], affine[2][3]
    );
    for (i, g) in segments.iter().enumerate() {
        let c = g.color.map(|v| format!("{:.6}", v as f64 / 255.0));
        h += &format!(
            "Segment{i}_Color:={} {} {}\nSegment{i}_ColorAutoGenerated:=0\nSegment{i}_Extent:=0 {} 0 {} 0 {}\nSegment{i}_ID:={}\nSegment{i}_LabelValue:={}\nSegment{i}_Layer:={}\nSegment{i}_Name:={}\nSegment{i}_NameAutoGenerated:=0\n",
            c[0], c[1], c[2], nx - 1, ny - 1, nz - 1, g.id, g.label, g.layer, g.name
        );
    }
    h += "Segmentation_ContainedRepresentationNames:=Binary labelmap|\nSegmentation_MasterRepresentation:=Binary labelmap\nSegmentation_ReferenceImageExtentOffset:=0 0 0\n\n";
    // data: x fastest; in a 4D file the layer is the fastest axis
    let mut raw = Vec::with_capacity(n * layers.len() * if wide { 2 } else { 1 });
    for v in 0..n {
        for l in layers {
            if wide {
                raw.extend_from_slice(&l[v].to_le_bytes());
            } else {
                raw.push(l[v] as u8);
            }
        }
    }
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    enc.write_all(&raw).expect("memory");
    let mut out = h.into_bytes();
    out.extend(enc.finish().expect("memory"));
    out
}

type Index = Box<dyn Fn(usize, usize) -> usize>;

/// One plane image of a label volume on the grid `shape` (x, y, z), in the orientation `nifti.rs` renders: axial 0 (anterior
/// at the top, right on the left), coronal 1, sagittal 2, stretched to `size` pixels (nearest label). The frame counts as in
/// the viewer: axial by z, coronal by y, sagittal by x. `None` when the frame is outside.
pub fn plane_labels(
    labels: &[u16],
    shape: [usize; 3],
    plane: u32,
    frame: usize,
    size: (usize, usize),
) -> Option<Vec<u16>> {
    let [nx, ny, nz] = shape;
    let (w, h, at): (usize, usize, Index) = match plane {
        1 if frame < ny => (
            nx,
            nz,
            Box::new(move |c, r| ((nz - 1 - r) * ny + frame) * nx + (nx - 1 - c)),
        ),
        2 if frame < nx => (
            ny,
            nz,
            Box::new(move |c, r| ((nz - 1 - r) * ny + c) * nx + frame),
        ),
        0 if frame < nz => (
            nx,
            ny,
            Box::new(move |c, r| (frame * ny + (ny - 1 - r)) * nx + (nx - 1 - c)),
        ),
        _ => return None,
    };
    let (sw, sh) = size;
    let mut out = vec![0u16; sw * sh];
    for r in 0..sh {
        let rr = ((r as f64 + 0.5) * h as f64 / sh as f64) as usize;
        for c in 0..sw {
            let cc = ((c as f64 + 0.5) * w as f64 / sw as f64) as usize;
            out[r * sw + c] = labels[at(cc.min(w - 1), rr.min(h - 1))];
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn gz(data: &[u8]) -> Vec<u8> {
        let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        e.write_all(data).unwrap();
        e.finish().unwrap()
    }

    fn file(head: &str, data: &[u8], encoding: &str) -> Vec<u8> {
        let mut b = format!("NRRD0004\n{head}encoding: {encoding}\n\n").into_bytes();
        b.extend(if encoding == "gzip" {
            gz(data)
        } else {
            data.to_vec()
        });
        b
    }

    /// labels of a RAS grid: 1 in one corner block, 2 in another
    fn ras_labels(nx: usize, ny: usize, nz: usize) -> Vec<u16> {
        let mut v = vec![0u16; nx * ny * nz];
        for z in 0..nz {
            for y in 0..ny {
                for x in 0..nx {
                    v[(z * ny + y) * nx + x] = if x == 0 && y == 1 && z == 2 {
                        1
                    } else if x == nx - 1 && y == ny - 1 && z == 0 {
                        2
                    } else {
                        0
                    };
                }
            }
        }
        v
    }

    const IDENTITY: M4 = [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ];

    #[test]
    fn swapped_lps_axes_land_where_ras_voxels_are() {
        // RAS grid 3 x 4 x 5 written with swapped axes (file axis 0 = RAS y, axis 1 = RAS x), in LPS space
        let (nx, ny, nz) = (3, 4, 5);
        let l = ras_labels(nx, ny, nz);
        let mut data = vec![0u8; nx * ny * nz];
        for z in 0..nz {
            for j in 0..nx {
                for i in 0..ny {
                    data[(z * nx + j) * ny + i] = l[(z * ny + i) * nx + j] as u8;
                }
            }
        }
        let head = format!(
            "type: unsigned char\ndimension: 3\nspace: left-posterior-superior\nsizes: {ny} {nx} {nz}\nspace directions: (0,-1,0) (-1,0,0) (0,0,1)\nspace origin: (0,0,0)\nSegment0_ID:=a\nSegment0_Name:=First\nSegment0_Color:=1 0 0\nSegment0_LabelValue:=1\nSegment0_Layer:=0\nSegment1_ID:=b\nSegment1_Name:=Second\nSegment1_LabelValue:=2\nSegment1_Layer:=0\n"
        );
        let n = parse(&file(&head, &data, "gzip")).unwrap();
        assert_eq!(n.segments.len(), 2);
        assert_eq!(
            (
                n.segments[0].name.as_str(),
                n.segments[0].color,
                n.segments[0].voxels
            ),
            ("First", [255, 0, 0], 1)
        );
        let r = n.resample([nx, ny, nz], &IDENTITY).unwrap();
        assert_eq!(r.labels, l);
        assert_eq!(r.kept, 1.0);
        assert_eq!(r.inside as usize, nx * ny * nz);
    }

    #[test]
    fn a_grid_beside_the_labels_keeps_nothing() {
        let data = [1u8; 8];
        let head = "type: uchar\ndimension: 3\nspace: right-anterior-superior\nsizes: 2 2 2\nspace directions: (1,0,0) (0,1,0) (0,0,1)\nspace origin: (100,0,0)\n";
        let n = parse(&file(head, &data, "raw")).unwrap();
        let r = n.resample([4, 4, 4], &IDENTITY).unwrap();
        assert_eq!((r.inside, r.kept), (0, 0.0));
        // a plain label map: one segment per value
        assert_eq!(n.segments.len(), 1);
        assert_eq!(n.segments[0].name, "Label 1");
    }

    #[test]
    fn layers_overlap_and_the_later_layer_shows() {
        // 4D: layers x 2 x 1 x 1; voxel 0 is in both segments, voxel 1 only in the second
        let data = [1u8, 1, 0, 1];
        let head = "type: uchar\ndimension: 4\nspace: left-posterior-superior\nsizes: 2 2 1 1\nspace directions: none (-1,0,0) (0,-1,0) (0,0,1)\nkinds: list domain domain domain\nspace origin: (0,0,0)\nSegment0_ID:=a\nSegment0_LabelValue:=1\nSegment0_Layer:=0\nSegment1_ID:=b\nSegment1_LabelValue:=1\nSegment1_Layer:=1\n";
        let n = parse(&file(head, &data, "raw")).unwrap();
        assert!(n.layered);
        assert_eq!(n.dims, [2, 1, 1]);
        assert_eq!(n.labels, vec![2, 2]);
        assert_eq!((n.segments[0].voxels, n.segments[1].voxels), (1, 2));
    }

    #[test]
    fn what_is_not_supported_is_said() {
        let e = |head: &str, enc: &str| parse(&file(head, &[0; 8], enc)).err().unwrap().0;
        assert!(e("type: float\ndimension: 3\nspace: ras\nsizes: 2 2 2\nspace directions: (1,0,0) (0,1,0) (0,0,1)\n", "raw").contains("not an integer label type"));
        assert!(e("type: uchar\ndimension: 3\nspace: ras\nsizes: 2 2 2\nspace directions: (1,0,0) (0,1,0) (0,0,1)\n", "ascii").contains("encoding"));
        assert!(e(
            "type: uchar\ndimension: 3\nsizes: 2 2 2\nspace directions: (1,0,0) (0,1,0) (0,0,1)\n",
            "raw"
        )
        .contains("space"));
    }

    #[test]
    fn the_render_grid_has_coverage_and_the_majority_segment_per_cell() {
        // 4 x 2 x 1 voxels in 2 x 1 x 1 cells: the cell on the left (voxels x 2, 3 as the plane is shown) holds two voxels of
        // segment 1 and one of segment 2, the cell on the right holds one voxel of segment 2
        let mut l = vec![0u16; 8];
        l[3] = 1; // x 3, y 0: the leftmost column of the picture
        l[7] = 1; // x 3, y 1
        l[2] = 2; // x 2, y 0
        l[0] = 2; // x 0, y 0: the rightmost column
        let out = render_cells(&l, [4, 2, 1], (2, 1, 1), &[false, false]);
        assert_eq!((out[0], out[1]), ((3 * 255u32).div_ceil(4) as u8, 1)); // 3 of 4 voxels, mostly segment 1
        assert_eq!((out[2], out[3]), (64, 2)); // 1 of 4
                                               // a hidden segment is left out of both
        let out = render_cells(&l, [4, 2, 1], (2, 1, 1), &[true, false]);
        assert_eq!((out[0], out[1], out[2], out[3]), (64, 2, 64, 2));
    }

    #[test]
    fn a_mask_goes_back_to_the_voxels_it_was_cut_from() {
        // labels on a 5 x 4 x 3 grid, cut onto the axial picture (same size) and back
        let shape = [5usize, 4, 3];
        let mut l = vec![0u16; 60];
        for v in [7usize, 22, 41, 58] {
            l[v] = 1;
        }
        let mut display = vec![0u8; 60];
        for z in 0..3 {
            let px = plane_labels(&l, shape, 0, z, (5, 4)).unwrap();
            for (i, v) in px.iter().enumerate() {
                display[z * 20 + i] = (*v != 0) as u8;
            }
        }
        let back = display_to_voxels(&display, (5, 4), shape);
        assert_eq!(back.iter().map(|v| *v as u16).collect::<Vec<_>>(), l);
        // a picture one row taller (non-square voxels): every voxel row reads the nearest picture row, nothing is lost
        let tall = [vec![0u8; 5 * 5 * 3]].concat();
        assert_eq!(display_to_voxels(&tall, (5, 5), shape).len(), 60);
    }

    #[test]
    fn a_written_segmentation_reads_back_alike() {
        let dims = [4usize, 3, 2];
        let n = 24;
        // an oblique affine (RAS): 0.5 mm in x, 2 mm in y and z, shifted
        let affine: M4 = [
            [0.5, 0.0, 0.0, -10.0],
            [0.0, 2.0, 0.0, 5.5],
            [0.0, 0.0, 2.0, 7.0],
            [0.0, 0.0, 0.0, 1.0],
        ];
        let mut a = vec![0u16; n];
        let mut b = vec![0u16; n];
        a[1] = 1; // segment "A" (layer 0, value 1)
        a[2] = 1;
        a[5] = 2; // segment "B" (layer 0, value 2)
        b[1] = 1; // segment "C" overlaps A at voxel 1 (layer 1, value 1)
        b[7] = 1;
        let segs = |names: [&str; 3]| -> Vec<OutSegment> {
            vec![
                OutSegment {
                    id: "a".into(),
                    name: names[0].into(),
                    color: [255, 0, 0],
                    label: 1,
                    layer: 0,
                },
                OutSegment {
                    id: "b".into(),
                    name: names[1].into(),
                    color: [0, 128, 255],
                    label: 2,
                    layer: 0,
                },
                OutSegment {
                    id: "c".into(),
                    name: names[2].into(),
                    color: [10, 20, 30],
                    label: 1,
                    layer: 1,
                },
            ]
        };
        // two layers: a 4D file; the overlap is kept per segment, the combined volume shows the later layer
        let bytes = write_seg(
            dims,
            &affine,
            &[a.clone(), b.clone()],
            &segs(["Nasal cavity", "pharynx", "Lesion"]),
        );
        let r = parse(&bytes).unwrap();
        assert!(r.layered && r.dims == dims);
        assert_eq!(
            r.segments
                .iter()
                .map(|s| (s.name.as_str(), s.voxels, s.color, s.layer))
                .collect::<Vec<_>>(),
            vec![
                ("Nasal cavity", 2, [255, 0, 0], 0),
                ("pharynx", 1, [0, 128, 255], 0),
                ("Lesion", 2, [10, 20, 30], 1)
            ]
        );
        assert_eq!(r.labels[1], 3); // the later layer wins in the combined picture
        assert_eq!(r.labels[2], 1);
        // the position survived: the same grid looked up on itself gives the same labels
        let back = r.resample(dims, &affine).unwrap();
        assert_eq!(back.labels, r.labels);
        assert_eq!(back.kept, 1.0);
        // one layer: a 3D file
        let one = write_seg(dims, &affine, &[a], &segs(["x", "y", "z"])[..2]);
        let r = parse(&one).unwrap();
        assert!(!r.layered);
        assert_eq!(r.segments.len(), 2);
        assert_eq!(r.labels.iter().filter(|v| **v != 0).count(), 3);
    }

    #[test]
    fn plane_images_follow_the_viewer_orientation() {
        // 3 x 2 x 2 grid, one labelled voxel at (x 0, y 0, z 1)
        let mut l = vec![0u16; 12];
        l[6] = 7; // (x 0, y 0, z 1): (z * ny + y) * nx + x
                  // axial z = 1: the voxel x 0 shows in the right-most column (right is on the left), y 0 in the bottom row (anterior on top)
        let ax = plane_labels(&l, [3, 2, 2], 0, 1, (3, 2)).unwrap();
        assert_eq!(ax, vec![0, 0, 0, 0, 0, 7]);
        // coronal y = 0: z 1 is the top row
        let cor = plane_labels(&l, [3, 2, 2], 1, 0, (3, 2)).unwrap();
        assert_eq!(cor, vec![0, 0, 7, 0, 0, 0]);
        // sagittal x = 0: columns are y, z 1 on top
        let sag = plane_labels(&l, [3, 2, 2], 2, 0, (2, 2)).unwrap();
        assert_eq!(sag, vec![7, 0, 0, 0]);
        assert!(plane_labels(&l, [3, 2, 2], 0, 2, (3, 2)).is_none());
    }
}
