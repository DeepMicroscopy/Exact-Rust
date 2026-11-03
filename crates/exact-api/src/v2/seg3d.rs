//! 3D segmentation of volumes: the mask of a segmentation annotation seen and edited on all three planes of a volume.
//!
//! - `GET  /api/v2/segmentation/{annotation}/volume`: geometry, planes, voxel count and volume (mm³), the slices that hold mask, undo state
//! - `GET  /api/v2/segmentation/{annotation}/slice/{plane}/{frame}?color=rrggbb&alpha=140`: the mask on one plane image as a PNG, in
//!   the size of the plane (transparent where there is none), so that a viewer lays it over the plane
//! - `POST /api/v2/segmentation/{annotation}/ops`: one operation (`stroke`, `wand`, `interpolate`, `copy`, `grow`, `shrink`,
//!   `fill_holes`, `keep_largest`, `clear`), answers the new state; every operation is one undo step
//! - `POST /api/v2/segmentation/{annotation}/undo` and `/redo`
//! - `PUT  /api/v2/segmentation/{annotation}/labels?mode=replace|add`: a mask made elsewhere (an automatic method), see `seg_jobs`
//!
//! The mask lives where Django keeps it, in the axial 256 x 256 tiles of `annotations_segmentationtile`; this module reads all of
//! them once into a sparse voxel mask (`volmask`), keeps it in memory while it is used and writes back the tiles an operation
//! changed. The old per-tile routes (`segmentation.rs`) drop the in-memory copy when they write.
//!
//! Reading needs read access, everything that changes the mask `edit_annotation` in the image set.

use crate::{
    auth::{authenticate, require_user},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    v2::{
        segmentation::{annotation_for, decode_mask, encode_mask, Target},
        volmask::{self, Geometry, Gray, Journal, MaskVol, Mode, Tile, WandOptions, T},
    },
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use image::ImageEncoder;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::HashMap;
use std::sync::{Arc, OnceLock};

type Key = (i32, i32, i32);

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/segmentation/{annotation}/volume", get(volume_h))
        .route(
            "/api/v2/segmentation/{annotation}/slice/{plane}/{frame}",
            get(slice_h),
        )
        .route("/api/v2/segmentation/{annotation}/ops", post(ops_h))
        .route("/api/v2/segmentation/{annotation}/undo", post(undo_h))
        .route("/api/v2/segmentation/{annotation}/redo", post(redo_h))
        .route(
            "/api/v2/segmentation/{annotation}/labels",
            axum::routing::put(labels_h),
        )
}

const MAX_UNDO: usize = 40;
const WAND_MAX_VOXELS: usize = 40_000_000;

// ------------------------------------------------------------------------------------------------ the open mask

/// What changed in one step, as PNG tiles (None = no tile): enough to go back and forth.
struct Step {
    before: Vec<(Key, Option<Vec<u8>>)>,
    after: Vec<(Key, Option<Vec<u8>>)>,
}

pub(crate) struct Entry {
    pub(crate) vol: MaskVol,
    pub(crate) geom: Geometry,
    /// grey values of the axial slices read so far (the wand needs them, and a plane of another direction needs all of them)
    gray: Arc<GrayCache>,
    undo: Vec<Step>,
    redo: Vec<Step>,
}

pub(crate) type Open = Arc<tokio::sync::Mutex<Entry>>;

fn cache() -> &'static moka::sync::Cache<i64, Open> {
    static C: OnceLock<moka::sync::Cache<i64, Open>> = OnceLock::new();
    C.get_or_init(|| {
        moka::sync::Cache::builder()
            .max_capacity(6)
            .time_to_idle(std::time::Duration::from_secs(900))
            .build()
    })
}

/// The in-memory mask of an annotation is out of date (another writer changed its tiles): load it again when it is next used.
pub fn forget(annotation: i64) {
    cache().invalidate(&annotation);
}

fn png_of(tile: &Tile) -> Vec<u8> {
    encode_mask(&tile[..], T as u32, T as u32)
}

pub(crate) async fn load_entry(s: &AppState, annotation: i64, t: &Target) -> ApiResult<Open> {
    if let Some(e) = cache().get(&annotation) {
        return Ok(e);
    }
    static LOADING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _one_at_a_time = LOADING.lock().await;
    if let Some(e) = cache().get(&annotation) {
        return Ok(e);
    }
    let img = sqlx::query("SELECT i.filename, st.path FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id WHERE i.id = $1")
        .bind(t.image)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    let path = s
        .slides
        .root()
        .join(img.get::<String, _>(1))
        .join(img.get::<String, _>(0));
    let slides = s.slides.clone();
    let p = path.to_string_lossy().into_owned();
    let slide = tokio::task::spawn_blocking(move || slides.open_slide(&p))
        .await
        .map_err(|e| exact_core::Error::Internal(e.to_string()))?
        .map_err(|e| {
            ApiError::detail(
                StatusCode::BAD_REQUEST,
                format!("The image cannot be read: {e}"),
            )
        })?;
    let geom = geometry(&*slide).ok_or_else(|| {
        ApiError::detail(
            StatusCode::BAD_REQUEST,
            "This image is not a volume: it has no coronal and sagittal planes.",
        )
    })?;
    let rows = sqlx::query("SELECT tile_x, tile_y, frame, data FROM annotations_segmentationtile WHERE annotation_id = $1 AND level = 0")
        .bind(annotation)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    let raw: Vec<(Key, Vec<u8>)> = rows
        .iter()
        .map(|r| {
            (
                (r.get::<i32, _>(0), r.get::<i32, _>(1), r.get::<i32, _>(2)),
                r.get::<Vec<u8>, _>(3),
            )
        })
        .collect();
    let vol = tokio::task::spawn_blocking(move || {
        MaskVol::from_tiles(raw.into_iter().filter_map(|(k, png)| {
            let (w, h, m) = decode_mask(&png, false)?;
            if w as usize != T || h as usize != T {
                return None;
            }
            let tile: Tile = m.into_boxed_slice().try_into().ok()?;
            Some((k, tile))
        }))
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))?;
    let gray = Arc::new(GrayCache::new(slide.clone(), geom.w as u32, geom.h as u32));
    let open = Arc::new(tokio::sync::Mutex::new(Entry {
        vol,
        geom,
        gray,
        undo: Vec::new(),
        redo: Vec::new(),
    }));
    cache().insert(annotation, open.clone());
    Ok(open)
}

/// The geometry of a volume as its reader renders it.
pub(crate) fn geometry(slide: &dyn exact_wsi::Slide) -> Option<Geometry> {
    let (w, h) = slide.plane_dimensions(0)?;
    let cor = slide.plane_dimensions(1)?;
    let sag = slide.plane_dimensions(2)?;
    let (nz, ny, nx) = (
        slide.plane_frames(0) as usize,
        slide.plane_frames(1) as usize,
        slide.plane_frames(2) as usize,
    );
    if nx < 2 || ny < 2 || nz < 2 {
        return None;
    }
    let props = slide.properties();
    let mm = |k: &str| {
        props
            .get(k)
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| *v > 0.0)
            .map_or(1.0, |um| um / 1000.0)
    };
    Some(Geometry {
        w: w as usize,
        h: h as usize,
        n: nz,
        nx,
        ny,
        nz,
        ext: [
            nx as f64 * mm("openslide.mpp-x"),
            ny as f64 * mm("openslide.mpp-y"),
            nz as f64 * mm("openslide.mpp-z"),
        ],
        cor: (cor.0 as usize, cor.1 as usize),
        sag: (sag.0 as usize, sag.1 as usize),
    })
}

/// Display intensities of axial slices, read from the image once and kept while the mask is open.
struct GrayCache {
    slide: Arc<dyn exact_wsi::Slide>,
    w: u32,
    h: u32,
    slices: std::sync::Mutex<HashMap<usize, Arc<Vec<u8>>>>,
}

impl GrayCache {
    fn new(slide: Arc<dyn exact_wsi::Slide>, w: u32, h: u32) -> Self {
        Self {
            slide,
            w,
            h,
            slices: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn get(&self, z: usize) -> Option<Arc<Vec<u8>>> {
        if let Some(v) = self.slices.lock().ok()?.get(&z) {
            return Some(v.clone());
        }
        let img = self
            .slide
            .read_region_plane(0, 0, 0, self.w, self.h, z as u32, 0)
            .ok()?;
        let g: Arc<Vec<u8>> = Arc::new(
            img.pixels()
                .map(|p| {
                    ((p.0[0] as u32 * 299 + p.0[1] as u32 * 587 + p.0[2] as u32 * 114) / 1000) as u8
                })
                .collect(),
        );
        self.slices.lock().ok()?.insert(z, g.clone());
        Some(g)
    }

    /// Reads the slices `0..n` that are not there yet, on a few threads (done before the mask is locked: it takes seconds).
    fn prefetch(&self, n: usize) {
        let next = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|sc| {
            for _ in 0..4 {
                sc.spawn(|| loop {
                    let z = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    if z >= n {
                        break;
                    }
                    self.get(z);
                });
            }
        });
    }
}

struct SlideGray {
    cache: Arc<GrayCache>,
    slices: HashMap<usize, Arc<Vec<u8>>>,
}

impl Gray for SlideGray {
    fn slice(&mut self, z: usize) -> Option<&[u8]> {
        if !self.slices.contains_key(&z) {
            let g = self.cache.get(z)?;
            self.slices.insert(z, g);
        }
        self.slices.get(&z).map(|v| v.as_slice())
    }
}

// ------------------------------------------------------------------------------------------------ persistence

async fn write_tiles(
    s: &AppState,
    annotation: i64,
    tiles: &[(Key, Option<Vec<u8>>)],
) -> ApiResult<()> {
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    for ((tx_, ty, z), png) in tiles {
        match png {
            Some(png) => {
                sqlx::query(
                    "INSERT INTO annotations_segmentationtile (annotation_id, level, tile_x, tile_y, frame, data) VALUES ($1, 0, $2, $3, $4, $5) \
                     ON CONFLICT (annotation_id, level, tile_x, tile_y, frame) DO UPDATE SET data = EXCLUDED.data",
                )
                .bind(annotation)
                .bind(tx_)
                .bind(ty)
                .bind(z)
                .bind(png)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
            }
            None => {
                sqlx::query("DELETE FROM annotations_segmentationtile WHERE annotation_id = $1 AND level = 0 AND tile_x = $2 AND tile_y = $3 AND frame = $4")
                    .bind(annotation)
                    .bind(tx_)
                    .bind(ty)
                    .bind(z)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
            }
        }
    }
    tx.commit().await.map_err(db_err)?;
    Ok(())
}

fn state_json(e: &Entry, annotation: i64, image: i64) -> Value {
    let g = &e.geom;
    let vm = g.voxel_mm();
    let count = e.vol.count();
    let slices: Vec<usize> = {
        let mut z: Vec<usize> = e.vol.keys().iter().map(|k| k.2 as usize).collect();
        z.sort_unstable();
        z.dedup();
        z
    };
    json!({
        "annotation": annotation, "image": image,
        "width": g.w, "height": g.h, "frames": g.n,
        "voxels": [g.nx, g.ny, g.nz],
        "voxel_mm": vm, "extent_mm": g.ext,
        "planes": (0..3u32).map(|p| { let (w, h) = g.plane_dims(p); json!({"plane": p, "width": w, "height": h, "frames": g.plane_frames(p)}) }).collect::<Vec<_>>(),
        "count": count, "volume_mm3": count as f64 * vm[0] * vm[1] * vm[2],
        "bbox": e.vol.bbox(), "slices": slices,
        "can_undo": !e.undo.is_empty(), "can_redo": !e.redo.is_empty(),
    })
}

// ------------------------------------------------------------------------------------------------ handlers

async fn volume_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(annotation): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let t = annotation_for(&s, &p, annotation, false).await?;
    let open = load_entry(&s, annotation, &t).await?;
    let e = open.lock().await;
    Ok(Json(state_json(&e, annotation, t.image)).into_response())
}

#[derive(Deserialize)]
struct SliceQuery {
    color: Option<String>,
    alpha: Option<u8>,
}

async fn slice_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((annotation, plane, frame)): Path<(i64, u32, usize)>,
    Query(q): Query<SliceQuery>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let t = annotation_for(&s, &p, annotation, false).await?;
    if plane > 2 {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "plane is 0 (axial), 1 (coronal) or 2 (sagittal).",
        ));
    }
    let open = load_entry(&s, annotation, &t).await?;
    let e = open.lock().await;
    if frame >= e.geom.plane_frames(plane) {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "frame is outside the volume.",
        ));
    }
    let (w, h, px) = e.vol.plane_slice(&e.geom, plane, frame);
    drop(e);
    let rgb = q
        .color
        .as_deref()
        .and_then(|c| {
            u32::from_str_radix(c.trim_start_matches('#'), 16)
                .ok()
                .filter(|_| c.trim_start_matches('#').len() == 6)
        })
        .unwrap_or(0xff0000);
    let (r, g, b) = ((rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8);
    let a = q.alpha.unwrap_or(140);
    let mut out = vec![0u8; w * h * 4];
    for (i, v) in px.iter().enumerate() {
        if *v != 0 {
            out[i * 4..i * 4 + 4].copy_from_slice(&[r, g, b, a]);
        }
    }
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&out, w as u32, h as u32, image::ExtendedColorType::Rgba8)
        .map_err(|e| exact_core::Error::Internal(e.to_string()))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "no-store"),
        ],
        png,
    )
        .into_response())
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Op {
    Stroke {
        plane: u32,
        frame: usize,
        points: Vec<[f64; 2]>,
        radius_mm: f64,
        #[serde(default)]
        ball: bool,
        #[serde(default)]
        mode: Option<String>,
    },
    Lasso {
        plane: u32,
        frame: usize,
        points: Vec<[f64; 2]>,
        #[serde(default)]
        mode: Option<String>,
    },
    Wand {
        plane: u32,
        frame: usize,
        point: [f64; 2],
        #[serde(default = "default_tolerance")]
        tolerance: u8,
        #[serde(default)]
        volume: bool,
        max_radius_mm: Option<f64>,
        max_voxels: Option<usize>,
        #[serde(default)]
        mode: Option<String>,
    },
    Interpolate {
        from: Option<usize>,
        to: Option<usize>,
    },
    Copy {
        from: usize,
        to: usize,
        through: Option<usize>,
        #[serde(default)]
        add: bool,
    },
    Grow {
        #[serde(default = "one")]
        steps: usize,
    },
    Shrink {
        #[serde(default = "one")]
        steps: usize,
    },
    FillHoles,
    KeepLargest,
    Clear,
}

fn default_tolerance() -> u8 {
    25
}

fn one() -> usize {
    1
}

fn mode_of(m: &Option<String>) -> Result<Mode, ApiError> {
    match m.as_deref() {
        None | Some("add") => Ok(Mode::Add),
        Some("remove") => Ok(Mode::Remove),
        Some(_) => Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "mode is \"add\" or \"remove\".",
        )),
    }
}

fn bad(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg.to_string())
}

/// Runs an operation on the mask; the journal of what it touched, and a note for the client.
fn run(e: &mut Entry, op: &Op) -> Result<(Journal, Option<String>), ApiError> {
    let g = e.geom.clone();
    let mut j = Journal::default();
    let mut note = None;
    match op {
        Op::Stroke {
            plane,
            frame,
            points,
            radius_mm,
            ball,
            mode,
        } => {
            if *plane > 2 || *frame >= g.plane_frames(*plane) {
                return Err(bad("plane or frame is outside the volume."));
            }
            if !(*radius_mm > 0.0 && *radius_mm <= 100.0)
                || points.is_empty()
                || points.len() > 5000
            {
                return Err(bad(
                    "radius_mm must be above 0 and at most 100, with 1 to 5000 points.",
                ));
            }
            let pts: Vec<(f64, f64)> = points.iter().map(|p| (p[0], p[1])).collect();
            volmask::stroke(
                &mut e.vol,
                &mut j,
                &g,
                *plane,
                *frame,
                &pts,
                *radius_mm,
                *ball,
                mode_of(mode)?,
            );
        }
        Op::Lasso {
            plane,
            frame,
            points,
            mode,
        } => {
            if *plane > 2 || *frame >= g.plane_frames(*plane) {
                return Err(bad("plane or frame is outside the volume."));
            }
            if points.len() < 3 || points.len() > 5000 {
                return Err(bad("A lasso needs 3 to 5000 points."));
            }
            let pts: Vec<(f64, f64)> = points.iter().map(|p| (p[0], p[1])).collect();
            volmask::lasso(&mut e.vol, &mut j, &g, *plane, *frame, &pts, mode_of(mode)?);
        }
        Op::Wand {
            plane,
            frame,
            point,
            tolerance,
            volume,
            max_radius_mm,
            max_voxels,
            mode,
        } => {
            if *plane > 2 || *frame >= g.plane_frames(*plane) {
                return Err(bad("plane or frame is outside the volume."));
            }
            let seed = g.voxel_at(g.pixel_mm(*plane, *frame, point[0], point[1]));
            let mut gray = SlideGray {
                cache: e.gray.clone(),
                slices: HashMap::new(),
            };
            let o = WandOptions {
                tolerance: *tolerance,
                volume: *volume,
                max_voxels: max_voxels.unwrap_or(WAND_MAX_VOXELS).min(WAND_MAX_VOXELS),
                max_radius_mm: *max_radius_mm,
                mode: mode_of(mode)?,
            };
            if volmask::wand(&mut e.vol, &mut j, &g, &mut gray, *plane, seed, &o).is_none() {
                return Err(bad(
                    "The region is too large: lower the tolerance or limit the radius.",
                ));
            }
        }
        Op::Interpolate { from, to } => {
            let range = match (from, to) {
                (None, None) => None,
                (a, b) => Some((a.unwrap_or(0), b.unwrap_or(g.n - 1))),
            };
            let n = volmask::interpolate(&mut e.vol, &mut j, &g, range);
            if n == 0 {
                note = Some("There are no gaps between painted slices to fill.".into());
            }
        }
        Op::Copy {
            from,
            to,
            through,
            add,
        } => {
            if *from >= g.n || *to >= g.n || through.is_some_and(|t| t >= g.n) {
                return Err(bad("slice is outside the volume."));
            }
            let end = through.unwrap_or(*to);
            let (lo, hi) = (*to.min(&end), *to.max(&end));
            for z in lo..=hi {
                volmask::copy_slice(&mut e.vol, &mut j, &g, *from, z, *add);
            }
        }
        Op::Grow { steps } | Op::Shrink { steps } => {
            if *steps == 0 || *steps > 20 {
                return Err(bad("steps is 1 to 20."));
            }
            volmask::morph(
                &mut e.vol,
                &mut j,
                &g,
                matches!(op, Op::Grow { .. }),
                *steps,
            );
        }
        Op::FillHoles => volmask::fill_holes(&mut e.vol, &mut j, &g),
        Op::KeepLargest => {
            let n = volmask::keep_largest(&mut e.vol, &mut j, &g);
            if n > 1 {
                note = Some(format!("{} smaller parts removed.", n - 1));
            }
        }
        Op::Clear => volmask::clear(&mut e.vol, &mut j),
    }
    Ok((j, note))
}

/// Settles the journal, stores the changed tiles and records the step for undo.
async fn commit(
    s: &AppState,
    annotation: i64,
    mut guard: tokio::sync::OwnedMutexGuard<Entry>,
    j: Journal,
    note: Option<String>,
    image: i64,
) -> ApiResult<Response> {
    let settled = volmask::settle(&mut guard.vol, &j);
    let (before, after) = tokio::task::spawn_blocking(move || {
        let before: Vec<(Key, Option<Vec<u8>>)> = j
            .into_before()
            .into_iter()
            .map(|(k, t)| (k, t.map(|t| png_of(&t))))
            .collect();
        let after: Vec<(Key, Option<Vec<u8>>)> = settled
            .into_iter()
            .map(|(k, t)| (k, t.map(|t| png_of(&t))))
            .collect();
        (before, after)
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))?;
    if let Err(e) = write_tiles(s, annotation, &after).await {
        // the database did not take it: the open copy must not claim otherwise
        drop(guard);
        forget(annotation);
        return Err(e);
    }
    let changed = !after.is_empty();
    if changed {
        guard.undo.push(Step { before, after });
        if guard.undo.len() > MAX_UNDO {
            guard.undo.remove(0);
        }
        guard.redo.clear();
    }
    let mut body = state_json(&guard, annotation, image);
    if let (Some(n), Some(o)) = (note, body.as_object_mut()) {
        o.insert("note".into(), Value::String(n));
    }
    if let Some(o) = body.as_object_mut() {
        o.insert("changed".into(), json!(changed));
    }
    Ok(Json(body).into_response())
}

async fn ops_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(annotation): Path<i64>,
    Json(op): Json<Op>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let t = annotation_for(&s, &p, annotation, true).await?;
    let open = load_entry(&s, annotation, &t).await?;
    if let Op::Wand { plane, volume, .. } = &op {
        if *plane != 0 || *volume {
            // a plane of another direction (or the volume) is made of all axial slices: read them before the mask is locked,
            // so that the pictures of the mask are not held up meanwhile
            let (gray, n) = {
                let e = open.lock().await;
                (e.gray.clone(), e.geom.n)
            };
            tokio::task::spawn_blocking(move || gray.prefetch(n))
                .await
                .map_err(|e| exact_core::Error::Internal(e.to_string()))?;
        }
    }
    let mut guard = open.clone().lock_owned().await;
    let (guard, j, note) = tokio::task::spawn_blocking(move || {
        let r = run(&mut guard, &op);
        r.map(|(j, n)| (guard, j, n))
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))??;
    commit(&s, annotation, guard, j, note, t.image).await
}

enum Dir {
    Undo,
    Redo,
}

async fn step_h(s: AppState, headers: HeaderMap, annotation: i64, dir: Dir) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let t = annotation_for(&s, &p, annotation, true).await?;
    let open = load_entry(&s, annotation, &t).await?;
    let mut e = open.lock().await;
    let step = match dir {
        Dir::Undo => e.undo.pop(),
        Dir::Redo => e.redo.pop(),
    }
    .ok_or_else(|| ApiError::detail(StatusCode::CONFLICT, "Nothing to undo."))?;
    let target = match dir {
        Dir::Undo => &step.before,
        Dir::Redo => &step.after,
    };
    let tiles: Vec<(Key, Option<Tile>)> = target
        .iter()
        .map(|(k, png)| {
            (
                *k,
                png.as_ref()
                    .and_then(|p| decode_mask(p, false))
                    .and_then(|(_, _, m)| m.into_boxed_slice().try_into().ok()),
            )
        })
        .collect();
    if let Err(err) = write_tiles(&s, annotation, target).await {
        drop(e);
        forget(annotation);
        return Err(err);
    }
    for (k, t) in tiles {
        e.vol.put_tile(k, t);
    }
    match dir {
        Dir::Undo => e.redo.push(step),
        Dir::Redo => e.undo.push(step),
    }
    let mut body = state_json(&e, annotation, t.image);
    if let Some(o) = body.as_object_mut() {
        o.insert("changed".into(), json!(true));
    }
    Ok(Json(body).into_response())
}

async fn undo_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(annotation): Path<i64>,
) -> ApiResult<Response> {
    step_h(s, headers, annotation, Dir::Undo).await
}

async fn redo_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(annotation): Path<i64>,
) -> ApiResult<Response> {
    step_h(s, headers, annotation, Dir::Redo).await
}

#[derive(Deserialize)]
struct LabelsQuery {
    mode: Option<String>,
}

/// A mask made elsewhere: the body is the raw voxels of the *mask grid* (`width` x `height` x `frames` bytes, column fastest, then
/// row, then slice; non-zero = masked), optionally gzip-compressed (`Content-Encoding: gzip`). `mode=add` unites it with
/// the mask, `replace` (default) replaces the mask.
async fn labels_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(annotation): Path<i64>,
    Query(q): Query<LabelsQuery>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PUT).await?)?;
    let t = annotation_for(&s, &p, annotation, true).await?;
    let open = load_entry(&s, annotation, &t).await?;
    let guard = open.clone().lock_owned().await;
    let gz = headers
        .get(header::CONTENT_ENCODING)
        .and_then(|v| v.to_str().ok())
        == Some("gzip");
    let replace = match q.mode.as_deref() {
        None | Some("replace") => true,
        Some("add") => false,
        Some(_) => return Err(bad("mode is \"replace\" or \"add\".")),
    };
    let (guard, j) = tokio::task::spawn_blocking(move || -> Result<_, ApiError> {
        let mut guard = guard;
        let data = if gz {
            use std::io::Read;
            let mut v = Vec::new();
            flate2::read::GzDecoder::new(&body[..])
                .read_to_end(&mut v)
                .map_err(|_| bad("The body is not valid gzip."))?;
            v
        } else {
            body.to_vec()
        };
        let g = guard.geom.clone();
        if data.len() != g.w * g.h * g.n {
            return Err(bad(&format!(
                "The body must hold {} x {} x {} = {} bytes (it has {}).",
                g.w,
                g.h,
                g.n,
                g.w * g.h * g.n,
                data.len()
            )));
        }
        let mut j = Journal::default();
        volmask::import(&mut guard.vol, &mut j, &g, replace, &|c, r, z| {
            data[(z * g.h + r) * g.w + c] != 0
        });
        Ok((guard, j))
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))??;
    commit(&s, annotation, guard, j, None, t.image).await
}

/// Writes the voxels of the mask grid where `pick(column, row, slice)` holds into the mask of `annotation` (`replace`, or unite
/// with it), as `PUT labels` does with a body: for masks that are made on the server, such as a segment of a linked segmentation
/// file. The permission is checked by the caller.
pub(crate) async fn import_with(
    s: &AppState,
    annotation: i64,
    image: i64,
    replace: bool,
    pick: impl Fn(usize, usize, usize) -> bool + Send + 'static,
) -> ApiResult<Response> {
    let open = load_entry(s, annotation, &Target { image }).await?;
    let guard = open.clone().lock_owned().await;
    let (guard, j) = tokio::task::spawn_blocking(move || {
        let mut guard = guard;
        let g = guard.geom.clone();
        let mut j = Journal::default();
        volmask::import(&mut guard.vol, &mut j, &g, replace, &|c, r, z| {
            pick(c, r, z)
        });
        (guard, j)
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))?;
    commit(s, annotation, guard, j, None, image).await
}

/// Reads the whole mask of an annotation as raw voxels of the mask grid (the form `labels` takes), for the programs that
/// make masks: used by the segmentation job code.
pub async fn mask_bytes(s: &AppState, annotation: i64) -> ApiResult<(Geometry, Vec<u8>)> {
    let row = crate::compat::writes::annotation_row(s, annotation)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let open = load_entry(
        s,
        annotation,
        &Target {
            image: row.image_id,
        },
    )
    .await?;
    let e = open.lock().await;
    let g = e.geom.clone();
    let mut out = vec![0u8; g.w * g.h * g.n];
    for (tx, ty, z) in e.vol.keys() {
        if let Some(t) = e.vol.tile((tx, ty, z)) {
            for r in 0..T {
                let row = ty as usize * T + r;
                if row >= g.h {
                    break;
                }
                for c in 0..T {
                    let col = tx as usize * T + c;
                    if col < g.w && t[r * T + c] != 0 {
                        out[(z as usize * g.h + row) * g.w + col] = 1;
                    }
                }
            }
        }
    }
    Ok((g, out))
}
