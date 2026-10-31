//! The 3D mask engine: a sparse voxel mask (the axial 256 x 256 tiles of a segmentation annotation, all slices together), the
//! geometry that ties the three planes of a volume to it, and the operations on it (brush strokes, region growing, interpolation
//! between slices, morphology). No database and no HTTP in here; `seg3d.rs` loads, saves and serves.
//!
//! **Mask space** is the axial pixel grid: `w x h` pixels per slice, `n` slices (slice `z` counted from 0 in the order of the
//! frames). Column `c` shows the voxel `nx - 1 - c` and row `r` the voxel `ny - 1 - r` (as the NIfTI / DICOM readers render the
//! axial plane). Everything between planes is done in millimetres from the display corner (X to the right, Y downwards in the
//! axial plane = from Anterior, Z upwards = from the first slice), so that anisotropic voxels and the resampled plane images
//! need no special cases: a plane pixel has a position, a mask voxel has a position, and the voxel *containing* the position is the
//! one a pixel shows or changes.
//!
//! This is deliberately not the voxel mapping of Django's `annotations/views.py`: its sagittal plane is mirrored against the
//! picture it renders, and its coronal / sagittal frames are off by one.

use std::collections::{HashMap, VecDeque};

pub const T: usize = 256;
pub type Tile = Box<[u8; T * T]>;
type Key = (i32, i32, i32); // tile x, tile y, slice

fn new_tile() -> Tile {
    vec![0u8; T * T]
        .into_boxed_slice()
        .try_into()
        .expect("tile size")
}

// ------------------------------------------------------------------------------------------------ geometry

#[derive(Clone, Debug, PartialEq)]
pub struct Geometry {
    /// mask pixels per slice and number of slices
    pub w: usize,
    pub h: usize,
    pub n: usize,
    /// voxels of the volume along x, y, z (the frames of the sagittal, coronal and axial plane)
    pub nx: usize,
    pub ny: usize,
    pub nz: usize,
    /// physical extent in mm
    pub ext: [f64; 3],
    /// sizes of the coronal and sagittal plane images
    pub cor: (usize, usize),
    pub sag: (usize, usize),
}

impl Geometry {
    pub fn plane_dims(&self, plane: u32) -> (usize, usize) {
        match plane {
            1 => self.cor,
            2 => self.sag,
            _ => (self.w, self.h),
        }
    }

    pub fn plane_frames(&self, plane: u32) -> usize {
        match plane {
            1 => self.ny,
            2 => self.nx,
            _ => self.n,
        }
    }

    /// mm per mask voxel along x, y, z
    pub fn voxel_mm(&self) -> [f64; 3] {
        [
            self.ext[0] / self.w as f64,
            self.ext[1] / self.h as f64,
            self.ext[2] / self.n as f64,
        ]
    }

    /// Physical position of the point (`pc`, `pr`) of the plane image at `frame`.
    pub fn pixel_mm(&self, plane: u32, frame: usize, pc: f64, pr: f64) -> [f64; 3] {
        let [ex, ey, ez] = self.ext;
        match plane {
            1 => [
                pc / self.cor.0 as f64 * ex,
                (self.ny - 1 - frame.min(self.ny - 1)) as f64 / self.ny as f64 * ey
                    + ey / (2.0 * self.ny as f64),
                (self.cor.1 as f64 - pr) / self.cor.1 as f64 * ez,
            ],
            2 => [
                (self.nx - 1 - frame.min(self.nx - 1)) as f64 / self.nx as f64 * ex
                    + ex / (2.0 * self.nx as f64),
                (self.sag.0 as f64 - pc) / self.sag.0 as f64 * ey,
                (self.sag.1 as f64 - pr) / self.sag.1 as f64 * ez,
            ],
            _ => [
                pc / self.w as f64 * ex,
                pr / self.h as f64 * ey,
                (frame.min(self.n - 1) as f64 + 0.5) / self.n as f64 * ez,
            ],
        }
    }

    /// The mask voxel containing a physical position (clamped to the volume).
    pub fn voxel_at(&self, p: [f64; 3]) -> (usize, usize, usize) {
        let cell = |v: f64, ext: f64, n: usize| {
            ((v / ext * n as f64).floor().max(0.0) as usize).min(n - 1)
        };
        (
            cell(p[0], self.ext[0], self.w),
            cell(p[1], self.ext[1], self.h),
            cell(p[2], self.ext[2], self.n),
        )
    }

    /// Centre of a mask voxel in mm.
    pub fn voxel_center(&self, c: usize, r: usize, z: usize) -> [f64; 3] {
        let m = self.voxel_mm();
        [
            (c as f64 + 0.5) * m[0],
            (r as f64 + 0.5) * m[1],
            (z as f64 + 0.5) * m[2],
        ]
    }

    /// Which axis of the mask (0 column, 1 row, 2 slice) is the normal of a plane.
    pub fn normal_axis(plane: u32) -> usize {
        match plane {
            1 => 1,
            2 => 0,
            _ => 2,
        }
    }
}

// ------------------------------------------------------------------------------------------------ the mask

#[derive(Default, Clone)]
pub struct MaskVol {
    tiles: HashMap<Key, Tile>,
    /// per tile: number of voxels and the box `[c0, c1, r0, r1]` inside the tile (so that the totals do not need a pass over all voxels)
    stats: HashMap<Key, TileStat>,
}

/// Turns the per-cell sums of a coarse grid into bytes: `f(sum, number of voxels the cell covers)`; `per_axis` are the voxels per cell along columns, rows, slices.
pub(crate) fn cells_to_bytes(
    sum: &[u32],
    dims: (usize, usize, usize),
    per_axis: [&[u32]; 3],
    f: impl Fn(u32, u32) -> u8,
) -> Vec<u8> {
    let (ow, oh, _) = dims;
    sum.iter()
        .enumerate()
        .map(|(idx, &s)| {
            if s == 0 {
                return 0;
            }
            let (i, j, k) = (idx % ow, (idx / ow) % oh, idx / (ow * oh));
            f(s, (per_axis[0][i] * per_axis[1][j] * per_axis[2][k]).max(1))
        })
        .collect()
}

#[derive(Clone, Copy)]
struct TileStat {
    count: u64,
    bbox: [usize; 4],
}

fn tile_stat(t: &Tile) -> TileStat {
    let (mut c0, mut c1, mut r0, mut r1, mut count) = (T, 0, T, 0, 0u64);
    for r in 0..T {
        let row = &t[r * T..(r + 1) * T];
        let first = row.iter().position(|v| *v != 0);
        if let Some(first) = first {
            let last = row.iter().rposition(|v| *v != 0).unwrap_or(first);
            count += row.iter().filter(|v| **v != 0).count() as u64;
            c0 = c0.min(first);
            c1 = c1.max(last);
            r0 = r0.min(r);
            r1 = r1.max(r);
        }
    }
    TileStat {
        count,
        bbox: [c0, c1, r0, r1],
    }
}

impl MaskVol {
    pub fn from_tiles(tiles: impl IntoIterator<Item = (Key, Tile)>) -> Self {
        let tiles: HashMap<Key, Tile> = tiles
            .into_iter()
            .filter(|(_, t)| t.iter().any(|v| *v != 0))
            .collect();
        let stats = tiles.iter().map(|(k, t)| (*k, tile_stat(t))).collect();
        Self { tiles, stats }
    }

    pub fn get(&self, c: usize, r: usize, z: usize) -> bool {
        self.tiles
            .get(&((c / T) as i32, (r / T) as i32, z as i32))
            .is_some_and(|t| t[(r % T) * T + c % T] != 0)
    }

    fn set(&mut self, journal: &mut Journal, c: usize, r: usize, z: usize, on: bool) {
        let key = ((c / T) as i32, (r / T) as i32, z as i32);
        let idx = (r % T) * T + c % T;
        match self.tiles.get_mut(&key) {
            Some(t) => {
                if (t[idx] != 0) == on {
                    return;
                }
                journal.touch(key, Some(t));
                t[idx] = on as u8;
            }
            None => {
                if !on {
                    return;
                }
                journal.touch(key, None);
                let mut t = new_tile();
                t[idx] = 1;
                self.tiles.insert(key, t);
            }
        }
    }

    pub fn tile(&self, key: Key) -> Option<&Tile> {
        self.tiles.get(&key)
    }

    pub fn put_tile(&mut self, key: Key, tile: Option<Tile>) {
        match tile {
            Some(t) if t.iter().any(|v| *v != 0) => {
                self.stats.insert(key, tile_stat(&t));
                self.tiles.insert(key, t);
            }
            _ => {
                self.tiles.remove(&key);
                self.stats.remove(&key);
            }
        }
    }

    /// The mask on a coarse grid of `dims` = (columns, rows, slices) cells for the 3D render: per cell how much of it is mask (0..255).
    pub fn coverage(&self, g: &Geometry, dims: (usize, usize, usize)) -> Vec<u8> {
        let (ow, oh, od) = dims;
        let mut sum = vec![0u32; ow * oh * od];
        let cell = |i: usize, n: usize, o: usize| i * o / n;
        for (&(tx, ty, z), t) in &self.tiles {
            let k = cell(z as usize, g.n, od);
            for r in 0..T {
                let row = ty as usize * T + r;
                if row >= g.h {
                    break;
                }
                let base = (k * oh + cell(row, g.h, oh)) * ow;
                for c in 0..T {
                    if t[r * T + c] != 0 {
                        let col = tx as usize * T + c;
                        if col < g.w {
                            sum[base + cell(col, g.w, ow)] += 1;
                        }
                    }
                }
            }
        }
        let per_axis = |n: usize, o: usize| {
            let mut c = vec![0u32; o];
            for i in 0..n {
                c[cell(i, n, o)] += 1;
            }
            c
        };
        let (cw, ch, cd) = (per_axis(g.w, ow), per_axis(g.h, oh), per_axis(g.n, od));
        cells_to_bytes(&sum, dims, [&cw, &ch, &cd], |s, full| {
            ((s as u64 * 255).div_ceil(full as u64)).min(255) as u8
        })
    }

    pub fn keys(&self) -> Vec<Key> {
        self.tiles.keys().copied().collect()
    }

    pub fn count(&self) -> u64 {
        self.stats.values().map(|s| s.count).sum()
    }

    /// Bounding box `[c0, c1, r0, r1, z0, z1]` (inclusive) of the mask, if there is one.
    pub fn bbox(&self) -> Option<[usize; 6]> {
        let mut b: Option<[usize; 6]> = None;
        for (&(tx, ty, z), st) in &self.stats {
            let [c0, c1, r0, r1] = st.bbox;
            let (c0, c1) = (tx as usize * T + c0, tx as usize * T + c1);
            let (r0, r1) = (ty as usize * T + r0, ty as usize * T + r1);
            let z = z as usize;
            b = Some(match b {
                None => [c0, c1, r0, r1, z, z],
                Some(o) => [
                    o[0].min(c0),
                    o[1].max(c1),
                    o[2].min(r0),
                    o[3].max(r1),
                    o[4].min(z),
                    o[5].max(z),
                ],
            });
        }
        b
    }

    /// Does slice `z` hold any mask?
    pub fn slice_has(&self, z: usize) -> bool {
        self.tiles.iter().any(|(k, _)| k.2 == z as i32)
    }

    /// The mask on one plane image at `frame`: `w * h` bytes, 255 where masked.
    pub fn plane_slice(&self, g: &Geometry, plane: u32, frame: usize) -> (usize, usize, Vec<u8>) {
        let (pw, ph) = g.plane_dims(plane);
        let mut out = vec![0u8; pw * ph];
        for pr in 0..ph {
            for pc in 0..pw {
                let (c, r, z) =
                    g.voxel_at(g.pixel_mm(plane, frame, pc as f64 + 0.5, pr as f64 + 0.5));
                if self.get(c, r, z) {
                    out[pr * pw + pc] = 255;
                }
            }
        }
        (pw, ph, out)
    }
}

// ------------------------------------------------------------------------------------------------ journal

/// What an operation changed: the tiles as they were before it (None = there was none).
#[derive(Default)]
pub struct Journal {
    before: HashMap<Key, Option<Tile>>,
}

impl Journal {
    fn touch(&mut self, key: Key, tile: Option<&Tile>) {
        self.before.entry(key).or_insert_with(|| tile.cloned());
    }

    pub fn is_empty(&self) -> bool {
        self.before.is_empty()
    }

    pub fn keys(&self) -> Vec<Key> {
        self.before.keys().copied().collect()
    }

    pub fn into_before(self) -> HashMap<Key, Option<Tile>> {
        self.before
    }
}

// ------------------------------------------------------------------------------------------------ operations

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Mode {
    Add,
    Remove,
}

impl Mode {
    fn on(self) -> bool {
        self == Mode::Add
    }
}

/// Brush strokes. `points` are plane pixel positions; `ball` paints a sphere around every sample, otherwise a disc in the plane
/// of the stroke, one voxel thick.
#[allow(clippy::too_many_arguments)]
pub fn stroke(
    m: &mut MaskVol,
    j: &mut Journal,
    g: &Geometry,
    plane: u32,
    frame: usize,
    points: &[(f64, f64)],
    radius_mm: f64,
    ball: bool,
    mode: Mode,
) {
    if points.is_empty() {
        return;
    }
    let vm = g.voxel_mm();
    let normal = Geometry::normal_axis(plane);
    let samples = {
        let mut out: Vec<[f64; 3]> = Vec::new();
        let mut prev: Option<[f64; 3]> = None;
        for &(pc, pr) in points {
            let p = g.pixel_mm(plane, frame, pc, pr);
            if let Some(a) = prev {
                let d =
                    ((p[0] - a[0]).powi(2) + (p[1] - a[1]).powi(2) + (p[2] - a[2]).powi(2)).sqrt();
                let steps = (d / (radius_mm * 0.4).max(vm[0].min(vm[1]).min(vm[2]) * 0.5))
                    .ceil()
                    .max(1.0) as usize;
                for s in 1..=steps {
                    let t = s as f64 / steps as f64;
                    out.push([
                        a[0] + (p[0] - a[0]) * t,
                        a[1] + (p[1] - a[1]) * t,
                        a[2] + (p[2] - a[2]) * t,
                    ]);
                }
            } else {
                out.push(p);
            }
            prev = Some(p);
        }
        out
    };
    let dims = [g.w, g.h, g.n];
    for p in samples {
        let centre = g.voxel_at(p);
        let cell = [centre.0, centre.1, centre.2];
        let mut lo = [0usize; 3];
        let mut hi = [0usize; 3];
        for ax in 0..3 {
            if ax == normal && !ball {
                lo[ax] = cell[ax];
                hi[ax] = cell[ax];
            } else {
                lo[ax] = (((p[ax] - radius_mm) / g.ext[ax] * dims[ax] as f64)
                    .floor()
                    .max(0.0) as usize)
                    .min(dims[ax] - 1);
                hi[ax] = (((p[ax] + radius_mm) / g.ext[ax] * dims[ax] as f64)
                    .floor()
                    .max(0.0) as usize)
                    .min(dims[ax] - 1);
            }
        }
        for z in lo[2]..=hi[2] {
            for r in lo[1]..=hi[1] {
                for c in lo[0]..=hi[0] {
                    let q = g.voxel_center(c, r, z);
                    let mut d2 = 0.0;
                    for ax in 0..3 {
                        if ax == normal && !ball {
                            continue;
                        }
                        d2 += (q[ax] - p[ax]).powi(2);
                    }
                    if d2 <= radius_mm * radius_mm {
                        m.set(j, c, r, z, mode.on());
                    }
                }
            }
        }
    }
}

/// Loads display intensities (0..255) of axial slices on demand.
pub trait Gray {
    fn slice(&mut self, z: usize) -> Option<&[u8]>;
}

pub struct WandOptions {
    pub tolerance: u8,
    /// `true`: grow through the volume (6 neighbours), `false`: inside the plane of the click (4 neighbours)
    pub volume: bool,
    pub max_voxels: usize,
    /// only voxels this close to the click (mm), if set
    pub max_radius_mm: Option<f64>,
    pub mode: Mode,
}

/// Region growing from a seed voxel over voxels whose intensity is within `tolerance` of the seed's (mean of its 3 x 3 x 3
/// neighbourhood). Returns the number of voxels set, or `None` when the region exceeds `max_voxels` (nothing is changed).
#[allow(clippy::too_many_arguments)]
pub fn wand(
    m: &mut MaskVol,
    j: &mut Journal,
    g: &Geometry,
    gray: &mut dyn Gray,
    plane: u32,
    seed: (usize, usize, usize),
    o: &WandOptions,
) -> Option<usize> {
    let normal = Geometry::normal_axis(plane);
    let (w, h, n) = (g.w, g.h, g.n);
    // the slices read so far (a region touches many voxels: a lookup per voxel must be an index, not a hash)
    let mut slices: Vec<Option<Vec<u8>>> = vec![None; n];
    let mut at = |c: usize, r: usize, z: usize| -> Option<i32> {
        if slices[z].is_none() {
            slices[z] = Some(gray.slice(z)?.to_vec());
        }
        slices[z].as_ref().map(|s| s[r * w + c] as i32)
    };
    let (mut sum, mut cnt) = (0i32, 0i32);
    for dz in -1i32..=1 {
        for dr in -1i32..=1 {
            for dc in -1i32..=1 {
                let (c, r, z) = (seed.0 as i32 + dc, seed.1 as i32 + dr, seed.2 as i32 + dz);
                if c < 0 || r < 0 || z < 0 || c >= w as i32 || r >= h as i32 || z >= n as i32 {
                    continue;
                }
                if let Some(v) = at(c as usize, r as usize, z as usize) {
                    sum += v;
                    cnt += 1;
                }
            }
        }
    }
    if cnt == 0 {
        return Some(0);
    }
    let target = sum / cnt;
    let seed_mm = g.voxel_center(seed.0, seed.1, seed.2);
    let lin = |c: usize, r: usize, z: usize| (z * h + r) * w + c;
    let mut seen = vec![0u64; (w * h * n).div_ceil(64)];
    let mut mark = |i: usize| -> bool {
        let (word, bit) = (i / 64, 1u64 << (i % 64));
        let fresh = seen[word] & bit == 0;
        seen[word] |= bit;
        fresh
    };
    let mut found: Vec<u32> = Vec::new();
    let mut queue: VecDeque<u32> = VecDeque::new();
    mark(lin(seed.0, seed.1, seed.2));
    queue.push_back(lin(seed.0, seed.1, seed.2) as u32);
    let cell = [seed.0, seed.1, seed.2];
    let dims = [w as i32, h as i32, n as i32];
    let r2 = o.max_radius_mm.map(|r| r * r);
    while let Some(i) = queue.pop_front() {
        let i = i as usize;
        let (c, r, z) = (i % w, i / w % h, i / (w * h));
        let Some(v) = at(c, r, z) else { continue };
        if (v - target).abs() > o.tolerance as i32 {
            continue;
        }
        found.push(i as u32);
        if found.len() > o.max_voxels {
            return None;
        }
        for (ax, d) in [(0usize, -1i32), (0, 1), (1, -1), (1, 1), (2, -1), (2, 1)] {
            if !o.volume && ax == normal {
                continue;
            }
            let mut p = [c as i32, r as i32, z as i32];
            p[ax] += d;
            if p[ax] < 0 || p[ax] >= dims[ax] {
                continue;
            }
            let np = (p[0] as usize, p[1] as usize, p[2] as usize);
            if !o.volume && [np.0, np.1, np.2][normal] != cell[normal] {
                continue;
            }
            if let Some(r2) = r2 {
                let q = g.voxel_center(np.0, np.1, np.2);
                let d2: f64 = (0..3).map(|a| (q[a] - seed_mm[a]).powi(2)).sum();
                if d2 > r2 {
                    continue;
                }
            }
            let ni = lin(np.0, np.1, np.2);
            if mark(ni) {
                queue.push_back(ni as u32);
            }
        }
    }
    let count = found.len();
    for i in found {
        let i = i as usize;
        m.set(j, i % w, i / w % h, i / (w * h), o.mode.on());
    }
    Some(count)
}

/// Copies the mask of axial slice `from` onto slice `to` (`add`: union; otherwise replace).
pub fn copy_slice(
    m: &mut MaskVol,
    j: &mut Journal,
    g: &Geometry,
    from: usize,
    to: usize,
    add: bool,
) {
    if from == to || from >= g.n || to >= g.n {
        return;
    }
    let src: Vec<(usize, usize)> = (0..g.h)
        .flat_map(|r| (0..g.w).map(move |c| (c, r)))
        .filter(|&(c, r)| m.get(c, r, from))
        .collect();
    if !add {
        let old: Vec<(usize, usize)> = (0..g.h)
            .flat_map(|r| (0..g.w).map(move |c| (c, r)))
            .filter(|&(c, r)| m.get(c, r, to))
            .collect();
        for (c, r) in old {
            m.set(j, c, r, to, false);
        }
    }
    for (c, r) in src {
        m.set(j, c, r, to, true);
    }
}

/// Exact squared Euclidean distance to the nearest `true` cell (Felzenszwalb and Huttenlocher), `INF` where there is none.
fn edt(on: &[bool], w: usize, h: usize) -> Vec<f64> {
    const INF: f64 = 1e18;
    fn pass(f: &[f64], n: usize) -> Vec<f64> {
        let mut d = vec![0.0; n];
        let mut v = vec![0usize; n];
        let mut z = vec![0.0; n + 1];
        let mut k = 0usize;
        z[0] = -1e30;
        z[1] = 1e30;
        for q in 1..n {
            loop {
                let p = v[k];
                let s = ((f[q] + (q * q) as f64) - (f[p] + (p * p) as f64))
                    / (2.0 * q as f64 - 2.0 * p as f64);
                if s <= z[k] && k > 0 {
                    k -= 1;
                    continue;
                }
                if s <= z[k] {
                    v[0] = q;
                    z[0] = -1e30;
                    z[1] = 1e30;
                    break;
                }
                k += 1;
                v[k] = q;
                z[k] = s;
                z[k + 1] = 1e30;
                break;
            }
        }
        k = 0;
        for (q, out) in d.iter_mut().enumerate() {
            while z[k + 1] < q as f64 {
                k += 1;
            }
            *out = (q as f64 - v[k] as f64).powi(2) + f[v[k]];
        }
        d
    }
    let mut g: Vec<f64> = on.iter().map(|&b| if b { 0.0 } else { INF }).collect();
    for c in 0..w {
        let col: Vec<f64> = (0..h).map(|r| g[r * w + c]).collect();
        let d = pass(&col, h);
        for r in 0..h {
            g[r * w + c] = d[r];
        }
    }
    for r in 0..h {
        let d = pass(&g[r * w..(r + 1) * w], w);
        g[r * w..(r + 1) * w].copy_from_slice(&d);
    }
    g
}

/// Signed distance (positive inside) of a binary slice.
fn signed_distance(on: &[bool], w: usize, h: usize) -> Vec<f64> {
    let outside = edt(on, w, h); // distance of background cells to the mask
    let inv: Vec<bool> = on.iter().map(|b| !b).collect();
    let inside = edt(&inv, w, h); // distance of mask cells to the background
    (0..w * h)
        .map(|i| {
            if on[i] {
                inside[i].sqrt() - 0.5
            } else {
                -(outside[i].sqrt() - 0.5)
            }
        })
        .collect()
}

/// Fills the empty slices between painted ones by interpolating the shapes (signed distances) of the neighbouring painted slices.
/// `range` limits it to slices `a..=b`. Returns the number of slices filled.
pub fn interpolate(
    m: &mut MaskVol,
    j: &mut Journal,
    g: &Geometry,
    range: Option<(usize, usize)>,
) -> usize {
    let painted: Vec<usize> = (0..g.n).filter(|&z| m.slice_has(z)).collect();
    let mut filled = 0;
    for pair in painted.windows(2) {
        let (a, b) = (pair[0], pair[1]);
        if b - a < 2 {
            continue;
        }
        if let Some((lo, hi)) = range {
            if a < lo || b > hi {
                continue;
            }
        }
        let Some((c0, c1, r0, r1)) = pair_bbox(m, g, a, b) else {
            continue;
        };
        let (w, h) = (c1 - c0 + 1, r1 - r0 + 1);
        let grab = |z: usize| -> Vec<bool> {
            (0..h)
                .flat_map(|r| (0..w).map(move |c| (c, r)))
                .map(|(c, r)| m.get(c0 + c, r0 + r, z))
                .collect()
        };
        let (da, db) = (
            signed_distance(&grab(a), w, h),
            signed_distance(&grab(b), w, h),
        );
        for z in a + 1..b {
            let t = (z - a) as f64 / (b - a) as f64;
            for r in 0..h {
                for c in 0..w {
                    let i = r * w + c;
                    if (1.0 - t) * da[i] + t * db[i] > 0.0 {
                        m.set(j, c0 + c, r0 + r, z, true);
                    }
                }
            }
            filled += 1;
        }
    }
    filled
}

/// Bounding box (with a margin of 1) of the masks of slices a and b together.
fn pair_bbox(
    m: &MaskVol,
    g: &Geometry,
    a: usize,
    b: usize,
) -> Option<(usize, usize, usize, usize)> {
    let mut bb: Option<(usize, usize, usize, usize)> = None;
    for z in [a, b] {
        for (&(tx, ty, kz), t) in &m.tiles {
            if kz as usize != z {
                continue;
            }
            for r in 0..T {
                for c in 0..T {
                    if t[r * T + c] != 0 {
                        let (cc, rr) = (tx as usize * T + c, ty as usize * T + r);
                        bb = Some(match bb {
                            None => (cc, cc, rr, rr),
                            Some((c0, c1, r0, r1)) => {
                                (c0.min(cc), c1.max(cc), r0.min(rr), r1.max(rr))
                            }
                        });
                    }
                }
            }
        }
    }
    bb.map(|(c0, c1, r0, r1)| {
        (
            c0.saturating_sub(1),
            (c1 + 1).min(g.w - 1),
            r0.saturating_sub(1),
            (r1 + 1).min(g.h - 1),
        )
    })
}

/// A dense copy of the mask inside its bounding box plus a margin: `(origin [c, r, z], size [w, h, d], voxels)`.
fn dense(m: &MaskVol, g: &Geometry, margin: usize) -> Option<([usize; 3], [usize; 3], Vec<u8>)> {
    let b = m.bbox()?;
    let o = [
        b[0].saturating_sub(margin),
        b[2].saturating_sub(margin),
        b[4].saturating_sub(margin),
    ];
    let e = [
        (b[1] + margin).min(g.w - 1),
        (b[3] + margin).min(g.h - 1),
        (b[5] + margin).min(g.n - 1),
    ];
    let s = [e[0] - o[0] + 1, e[1] - o[1] + 1, e[2] - o[2] + 1];
    let mut v = vec![0u8; s[0] * s[1] * s[2]];
    for z in 0..s[2] {
        for r in 0..s[1] {
            for c in 0..s[0] {
                if m.get(o[0] + c, o[1] + r, o[2] + z) {
                    v[(z * s[1] + r) * s[0] + c] = 1;
                }
            }
        }
    }
    Some((o, s, v))
}

fn write_back(m: &mut MaskVol, j: &mut Journal, o: [usize; 3], s: [usize; 3], v: &[u8]) {
    for z in 0..s[2] {
        for r in 0..s[1] {
            for c in 0..s[0] {
                m.set(
                    j,
                    o[0] + c,
                    o[1] + r,
                    o[2] + z,
                    v[(z * s[1] + r) * s[0] + c] != 0,
                );
            }
        }
    }
}

const N6: [(i32, i32, i32); 6] = [
    (-1, 0, 0),
    (1, 0, 0),
    (0, -1, 0),
    (0, 1, 0),
    (0, 0, -1),
    (0, 0, 1),
];

fn neighbours(i: usize, s: [usize; 3]) -> impl Iterator<Item = usize> {
    let (c, r, z) = (
        (i % s[0]) as i32,
        (i / s[0] % s[1]) as i32,
        (i / (s[0] * s[1])) as i32,
    );
    N6.into_iter().filter_map(move |(dc, dr, dz)| {
        let (c, r, z) = (c + dc, r + dr, z + dz);
        (c >= 0 && r >= 0 && z >= 0 && c < s[0] as i32 && r < s[1] as i32 && z < s[2] as i32)
            .then(|| (z as usize * s[1] + r as usize) * s[0] + c as usize)
    })
}

/// Grows (`grow`) or shrinks the mask by `steps` voxels (6-neighbourhood).
pub fn morph(m: &mut MaskVol, j: &mut Journal, g: &Geometry, grow: bool, steps: usize) {
    let Some((o, s, mut v)) = dense(m, g, if grow { steps } else { 0 }) else {
        return;
    };
    for _ in 0..steps {
        let src = v.clone();
        for i in 0..v.len() {
            let hit = neighbours(i, s).any(|n| (src[n] != 0) == grow);
            if grow {
                if src[i] == 0 && hit {
                    v[i] = 1;
                }
            } else if src[i] != 0 && (hit || neighbours(i, s).count() < 6) {
                v[i] = 0;
            }
        }
    }
    write_back(m, j, o, s, &v);
}

/// Fills the cavities of the mask: background not connected to the outside of its bounding box.
pub fn fill_holes(m: &mut MaskVol, j: &mut Journal, g: &Geometry) {
    let Some((o, s, mut v)) = dense(m, g, 1) else {
        return;
    };
    let mut outside = vec![false; v.len()];
    let mut q = VecDeque::from([0usize]);
    outside[0] = true;
    while let Some(i) = q.pop_front() {
        for n in neighbours(i, s) {
            if v[n] == 0 && !outside[n] {
                outside[n] = true;
                q.push_back(n);
            }
        }
    }
    for i in 0..v.len() {
        if v[i] == 0 && !outside[i] {
            v[i] = 1;
        }
    }
    write_back(m, j, o, s, &v);
}

/// Keeps only the largest connected component (6-neighbourhood). Returns how many components there were.
pub fn keep_largest(m: &mut MaskVol, j: &mut Journal, g: &Geometry) -> usize {
    let Some((o, s, mut v)) = dense(m, g, 0) else {
        return 0;
    };
    let mut label = vec![0u32; v.len()];
    let mut sizes: Vec<usize> = vec![0];
    for start in 0..v.len() {
        if v[start] == 0 || label[start] != 0 {
            continue;
        }
        let id = sizes.len() as u32;
        sizes.push(0);
        let mut q = VecDeque::from([start]);
        label[start] = id;
        while let Some(i) = q.pop_front() {
            sizes[id as usize] += 1;
            for n in neighbours(i, s) {
                if v[n] != 0 && label[n] == 0 {
                    label[n] = id;
                    q.push_back(n);
                }
            }
        }
    }
    if sizes.len() <= 2 {
        return sizes.len() - 1;
    }
    let best = (1..sizes.len())
        .max_by_key(|&k| sizes[k])
        .expect("components") as u32;
    for i in 0..v.len() {
        if label[i] != best {
            v[i] = 0;
        }
    }
    write_back(m, j, o, s, &v);
    sizes.len() - 1
}

/// Removes everything.
pub fn clear(m: &mut MaskVol, j: &mut Journal) {
    for key in m.keys() {
        if let Some(t) = m.tiles.get(&key) {
            j.touch(key, Some(t));
        }
        m.tiles.remove(&key);
        m.stats.remove(&key);
    }
}

/// Replaces (or adds to) the mask by a label volume given as a function of the mask voxel; used for imports.
pub fn import(
    m: &mut MaskVol,
    j: &mut Journal,
    g: &Geometry,
    replace: bool,
    on: &dyn Fn(usize, usize, usize) -> bool,
) {
    if replace {
        clear(m, j);
    }
    for z in 0..g.n {
        for r in 0..g.h {
            for c in 0..g.w {
                if on(c, r, z) {
                    m.set(j, c, r, z, true);
                }
            }
        }
    }
}

/// After an operation: tiles that became empty are dropped. Returns the keys that were touched and the tile each holds now.
pub fn settle(m: &mut MaskVol, j: &Journal) -> Vec<(Key, Option<Tile>)> {
    let mut out = Vec::new();
    for key in j.keys() {
        let empty = m.tiles.get(&key).is_none_or(|t| t.iter().all(|v| *v == 0));
        if empty {
            m.tiles.remove(&key);
            m.stats.remove(&key);
            out.push((key, None));
        } else {
            let t = m.tiles.get(&key).cloned();
            if let Some(t) = &t {
                m.stats.insert(key, tile_stat(t));
            }
            out.push((key, t));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 40 x 30 pixels, 20 slices, isotropic 1 mm voxels; coronal 40 x 20, sagittal 30 x 20
    fn geom() -> Geometry {
        Geometry {
            w: 40,
            h: 30,
            n: 20,
            nx: 40,
            ny: 30,
            nz: 20,
            ext: [40.0, 30.0, 20.0],
            cor: (40, 20),
            sag: (30, 20),
        }
    }

    /// the totals are kept per tile and refreshed by `settle`; these tests change tiles without it
    fn cnt(m: &mut MaskVol) -> u64 {
        m.stats = m.tiles.iter().map(|(k, t)| (*k, tile_stat(t))).collect();
        m.count()
    }

    fn clear_box(
        m: &mut MaskVol,
        j: &mut Journal,
        c: std::ops::Range<usize>,
        r: std::ops::Range<usize>,
        z: std::ops::Range<usize>,
    ) {
        for z in z {
            for r in r.clone() {
                for c in c.clone() {
                    m.set(j, c, r, z, false);
                }
            }
        }
    }

    fn fill_box(
        m: &mut MaskVol,
        c: std::ops::Range<usize>,
        r: std::ops::Range<usize>,
        z: std::ops::Range<usize>,
    ) {
        let mut j = Journal::default();
        for z in z {
            for r in r.clone() {
                for c in c.clone() {
                    m.set(&mut j, c, r, z, true);
                }
            }
        }
        settle(m, &j);
    }

    #[test]
    fn count_and_box_follow_every_change() {
        let mut m = MaskVol::default();
        let mut j = Journal::default();
        for z in 3..6 {
            for r in 2..9 {
                for c in 5..12 {
                    m.set(&mut j, c, r, z, true);
                }
            }
        }
        settle(&mut m, &j);
        assert_eq!(m.count(), 3 * 7 * 7);
        assert_eq!(m.bbox(), Some([5, 11, 2, 8, 3, 5]));
        let mut j = Journal::default();
        clear_box(&mut m, &mut j, 5..12, 2..9, 5..6);
        settle(&mut m, &j);
        assert_eq!(m.count(), 2 * 7 * 7);
        assert_eq!(m.bbox(), Some([5, 11, 2, 8, 3, 4]));
        m.put_tile((0, 0, 3), None);
        assert_eq!(m.count(), 7 * 7);
        assert_eq!(m.bbox(), Some([5, 11, 2, 8, 4, 4]));
        let mut j = Journal::default();
        clear(&mut m, &mut j);
        assert_eq!((m.count(), m.bbox()), (0, None));
    }

    #[test]
    fn a_pixel_of_each_plane_lands_on_the_voxel_it_shows() {
        let g = geom();
        // axial pixel (7, 4) of slice 3
        assert_eq!(g.voxel_at(g.pixel_mm(0, 3, 7.5, 4.5)), (7, 4, 3));
        // coronal frame 5 = y voxel 5 = mask row 30 - 1 - 5 = 24; pixel (7, 2) is slice 20 - 1 - 2 = 17
        assert_eq!(g.voxel_at(g.pixel_mm(1, 5, 7.5, 2.5)), (7, 24, 17));
        // sagittal frame 6 = x voxel 6 = mask column 33; pixel column 4 = y voxel 4 = mask row 25
        assert_eq!(g.voxel_at(g.pixel_mm(2, 6, 4.5, 2.5)), (33, 25, 17));
    }

    #[test]
    fn a_plane_slice_shows_the_mask_where_the_image_is() {
        let g = geom();
        let mut m = MaskVol::default();
        fill_box(&mut m, 10..14, 20..22, 5..8);
        // coronal at y voxel 29 - 20 = 9 .. 8: mask rows 20, 21
        let (w, h, px) = m.plane_slice(&g, 1, 9);
        assert_eq!((w, h), (40, 20));
        // columns 10..14, slices 5..8 are plane rows 20 - 1 - z: 14..11
        for r in 0..h {
            for c in 0..w {
                let want = (10..14).contains(&c) && (12..=14).contains(&r);
                assert_eq!(px[r * w + c] != 0, want, "coronal ({c}, {r})");
            }
        }
        // sagittal at x voxel 39 - 12 = 27: mask column 12; plane columns are y voxels 8..10 (mask rows 21, 20)
        let (w, h, px) = m.plane_slice(&g, 2, 27);
        for r in 0..h {
            for c in 0..w {
                let want = (8..=9).contains(&c) && (12..=14).contains(&r);
                assert_eq!(px[r * w + c] != 0, want, "sagittal ({c}, {r})");
            }
        }
        let (w, _, px) = m.plane_slice(&g, 0, 6);
        assert!(px[20 * w + 11] != 0 && px[19 * w + 11] == 0 && px[20 * w + 14] == 0);
    }

    #[test]
    fn a_disc_stroke_stays_in_its_plane_and_a_ball_does_not() {
        let g = geom();
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        stroke(
            &mut m,
            &mut j,
            &g,
            0,
            10,
            &[(20.5, 15.5)],
            3.0,
            false,
            Mode::Add,
        );
        assert!(m.get(20, 15, 10) && m.get(22, 15, 10) && !m.get(25, 15, 10));
        assert!(!m.get(20, 15, 9) && !m.get(20, 15, 11), "one slice only");
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        stroke(
            &mut m,
            &mut j,
            &g,
            0,
            10,
            &[(20.5, 15.5)],
            3.0,
            true,
            Mode::Add,
        );
        assert!(m.get(20, 15, 10) && m.get(20, 15, 12) && m.get(20, 15, 8) && !m.get(20, 15, 14));
        // a stroke on the coronal plane paints one mask row, whatever the plane's other coordinate
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        stroke(
            &mut m,
            &mut j,
            &g,
            1,
            9,
            &[(10.5, 5.5), (30.5, 5.5)],
            2.0,
            false,
            Mode::Add,
        );
        assert!(m.get(20, 20, 14) && m.get(12, 20, 14) && !m.get(20, 19, 14) && !m.get(20, 21, 14));
        // removing
        stroke(
            &mut m,
            &mut j,
            &g,
            1,
            9,
            &[(20.5, 5.5)],
            2.0,
            false,
            Mode::Remove,
        );
        assert!(!m.get(20, 20, 14) && m.get(12, 20, 14));
    }

    #[test]
    fn a_stroke_in_anisotropic_voxels_is_round_in_mm() {
        // slices 3 mm thick: a ball of 3 mm reaches one slice up and down
        let g = Geometry {
            ext: [40.0, 30.0, 60.0],
            cor: (40, 60),
            sag: (30, 60),
            ..geom()
        };
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        stroke(
            &mut m,
            &mut j,
            &g,
            0,
            10,
            &[(20.5, 15.5)],
            3.0,
            true,
            Mode::Add,
        );
        assert!(m.get(20, 15, 10) && m.get(20, 15, 11) && m.get(20, 15, 9) && !m.get(20, 15, 12));
    }

    struct Img(Vec<Vec<u8>>);
    impl Gray for Img {
        fn slice(&mut self, z: usize) -> Option<&[u8]> {
            self.0.get(z).map(|v| v.as_slice())
        }
    }

    fn two_blobs(g: &Geometry) -> Img {
        // a bright cube (200) at columns 5..15, rows 5..15, slices 4..10 and another far away; background 20
        let mut v = vec![vec![20u8; g.w * g.h]; g.n];
        for (c0, r0) in [(5usize, 5usize), (25, 18)] {
            for plane in v.iter_mut().take(10).skip(4) {
                for r in r0..r0 + 10 {
                    for c in c0..c0 + 10 {
                        plane[r * g.w + c] = 200;
                    }
                }
            }
        }
        Img(v)
    }

    #[test]
    fn the_wand_grows_over_the_connected_region_only() {
        let g = geom();
        let mut img = two_blobs(&g);
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        let o = WandOptions {
            tolerance: 30,
            volume: true,
            max_voxels: 1_000_000,
            max_radius_mm: None,
            mode: Mode::Add,
        };
        let n = wand(&mut m, &mut j, &g, &mut img, 0, (8, 8, 6), &o).unwrap();
        assert_eq!(n, 10 * 10 * 6);
        assert!(
            m.get(5, 5, 4)
                && m.get(14, 14, 9)
                && !m.get(25, 18, 6)
                && !m.get(8, 8, 3)
                && !m.get(4, 8, 6)
        );
        // in the plane only
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        let o2 = WandOptions { volume: false, ..o };
        assert_eq!(
            wand(&mut m, &mut j, &g, &mut img, 0, (8, 8, 6), &o2).unwrap(),
            100
        );
        assert!(m.get(8, 8, 6) && !m.get(8, 8, 7));
        // a coronal wand stays in its mask row
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        assert_eq!(
            wand(&mut m, &mut j, &g, &mut img, 1, (8, 8, 6), &o2).unwrap(),
            10 * 6
        );
        // too large a region is refused and changes nothing
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        let o3 = WandOptions {
            max_voxels: 50,
            ..o2
        };
        assert!(wand(&mut m, &mut j, &g, &mut img, 0, (8, 8, 6), &o3).is_none());
        assert!(j.is_empty());
        // limited by radius
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        let o4 = WandOptions {
            max_radius_mm: Some(2.0),
            tolerance: 30,
            volume: true,
            max_voxels: 1_000_000,
            mode: Mode::Add,
        };
        let n = wand(&mut m, &mut j, &g, &mut img, 0, (8, 8, 6), &o4).unwrap();
        assert!(n > 10 && n < 60);
    }

    #[test]
    fn interpolation_fills_between_painted_slices() {
        let g = geom();
        let mut m = MaskVol::default();
        fill_box(&mut m, 10..20, 10..20, 2..3); // a square on slice 2
        fill_box(&mut m, 12..18, 12..18, 8..9); // a smaller one on slice 8
        let mut j = Journal::default();
        let n = interpolate(&mut m, &mut j, &g, None);
        assert_eq!(n, 5);
        let area = |z: usize| {
            (0..g.h)
                .flat_map(|r| (0..g.w).map(move |c| (c, r)))
                .filter(|&(c, r)| m.get(c, r, z))
                .count()
        };
        let areas: Vec<usize> = (2..=8).map(area).collect();
        assert_eq!(areas[0], 100);
        assert_eq!(areas[6], 36);
        assert!(
            areas.windows(2).all(|w| w[0] >= w[1]),
            "shrinks steadily: {areas:?}"
        );
        assert!(
            areas[1..6].iter().all(|a| *a >= 36 && *a <= 100) && areas[3] < 100 && areas[3] > 36
        );
        assert!(m.get(15, 15, 5));
        // nothing below the first or above the last painted slice
        assert_eq!((area(1), area(9)), (0, 0));
        // the journal knows the slices it touched, so that the operation can be undone
        assert_eq!(j.keys().len(), 5);
    }

    #[test]
    fn morphology_and_components() {
        let g = geom();
        let mut m = MaskVol::default();
        fill_box(&mut m, 10..15, 10..15, 5..10);
        let before = cnt(&mut m);
        let mut j = Journal::default();
        morph(&mut m, &mut j, &g, true, 1);
        assert!(cnt(&mut m) > before && m.get(9, 12, 7) && !m.get(8, 12, 7));
        morph(&mut m, &mut j, &g, false, 1);
        assert_eq!(cnt(&mut m), before);
        // fill holes: a hollow cube becomes solid
        let mut m = MaskVol::default();
        fill_box(&mut m, 10..20, 10..20, 5..15);
        let mut j = Journal::default();
        for z in 7..13 {
            for r in 12..18 {
                for c in 12..18 {
                    m.set(&mut j, c, r, z, false);
                }
            }
        }
        settle(&mut m, &j);
        assert!(!m.get(15, 15, 10));
        fill_holes(&mut m, &mut Journal::default(), &g);
        assert!(m.get(15, 15, 10));
        assert_eq!(cnt(&mut m), 1000);
        // a cavity open to the outside stays
        let mut m = MaskVol::default();
        fill_box(&mut m, 10..20, 10..20, 5..15);
        let mut j = Journal::default();
        for z in 7..13 {
            for r in 12..18 {
                for c in 12..30 {
                    m.set(&mut j, c, r, z, false);
                }
            }
        }
        let c0 = cnt(&mut m);
        fill_holes(&mut m, &mut Journal::default(), &g);
        assert_eq!(cnt(&mut m), c0);
        // largest component
        let mut m = MaskVol::default();
        fill_box(&mut m, 2..6, 2..6, 2..6);
        fill_box(&mut m, 20..30, 10..20, 5..15);
        let mut j = Journal::default();
        assert_eq!(keep_largest(&mut m, &mut j, &g), 2);
        assert!(!m.get(3, 3, 3) && m.get(25, 15, 10));
    }

    #[test]
    fn copying_a_slice_and_clearing() {
        let g = geom();
        let mut m = MaskVol::default();
        fill_box(&mut m, 10..15, 10..15, 5..6);
        let mut j = Journal::default();
        copy_slice(&mut m, &mut j, &g, 5, 6, false);
        assert!(m.get(12, 12, 6));
        clear(&mut m, &mut j);
        assert_eq!(cnt(&mut m), 0);
        assert_eq!(j.keys().len(), 2);
    }

    #[test]
    fn settle_drops_tiles_that_became_empty_and_reports_the_rest() {
        let g = geom();
        let (mut m, mut j) = (MaskVol::default(), Journal::default());
        stroke(
            &mut m,
            &mut j,
            &g,
            0,
            3,
            &[(5.5, 5.5)],
            2.0,
            false,
            Mode::Add,
        );
        let mut j2 = Journal::default();
        stroke(
            &mut m,
            &mut j2,
            &g,
            0,
            3,
            &[(5.5, 5.5)],
            5.0,
            false,
            Mode::Remove,
        );
        let out = settle(&mut m, &j2);
        assert_eq!(out.len(), 1);
        assert!(out[0].1.is_none());
        assert_eq!(cnt(&mut m), 0);
    }
}
