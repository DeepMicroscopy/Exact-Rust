//! Segmentation files linked to a volume: a 3D Slicer `.seg.nrrd` (or any NRRD label map) kept next to the images of a set and
//! drawn read-only over a NIfTI volume, without annotation types or annotations. Upload stores the file and reads its segments
//! (`exact_rust_linked_volume`); linking it to a volume resamples the labels onto the volume's grid in millimetres (the
//! orientation of the NRRD does not have to match) and reports how well they fit.
//!
//! * `GET  /api/v2/image-sets/{id}/linked-volumes`, `GET /api/v2/images/{id}/linked-volumes`: the files of a set / of a volume
//! * `GET|PUT|DELETE /api/v2/linked-volumes/{id}`: the file with its segments and the volumes it could belong to; link (`{"image": n}`)
//!   or unlink (`{"image": null}`); delete the file
//! * `GET /api/v2/linked-volumes/{id}/slice/{plane}/{frame}?hide=0,3&alpha=`: an RGBA PNG at plane size, as the mask slices of
//!   `seg3d.rs`; `GET .../at?x=&y=&z=`: the segment at a voxel; `GET .../file`: the original file
//!
//! Reading needs read access to the set, linking and deleting `edit_set`. Importing the segments as annotations is a separate step.

use crate::{
    auth::{authenticate, require_user, Principal},
    compat::{
        engine::db_err,
        perms::{perms, set_row},
    },
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use exact_wsi::nrrd;
use image::ImageEncoder;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::Row;
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/image-sets/{id}/linked-volumes", get(set_list_h))
        .route("/api/v2/images/{id}/linked-volumes", get(image_list_h))
        .route(
            "/api/v2/linked-volumes/{id}",
            get(one_h).put(link_h).delete(delete_h),
        )
        .route(
            "/api/v2/linked-volumes/{id}/slice/{plane}/{frame}",
            get(slice_h),
        )
        .route("/api/v2/linked-volumes/{id}/at", get(at_h))
        .route("/api/v2/linked-volumes/{id}/thumbnail", get(thumbnail_h))
        .route(
            "/api/v2/linked-volumes/{id}/render-mask",
            get(render_mask_h),
        )
        .route("/api/v2/linked-volumes/{id}/file", get(file_h))
}

// ------------------------------------------------------------------------------------------------ rows

struct Linked {
    id: i64,
    set: i64,
    image: Option<i64>,
    name: String,
    filename: String,
    size: i64,
    segments: Value,
    geometry: Option<Value>,
    set_path: String,
    image_file: Option<String>,
    time: String,
}

const SELECT: &str = "SELECT lv.id, lv.image_set_id, lv.image_id, lv.name, lv.filename, lv.size, lv.segments, lv.geometry, \
    st.path, i.filename, to_char(lv.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || 'T' || to_char(lv.created_at AT TIME ZONE 'UTC', 'HH24:MI:SS') || 'Z' \
    FROM exact_rust_linked_volume lv JOIN images_imageset st ON st.id = lv.image_set_id \
    LEFT JOIN images_image i ON i.id = lv.image_id";

fn row_of(r: &sqlx::postgres::PgRow) -> Linked {
    Linked {
        id: r.get(0),
        set: r.get(1),
        image: r.get(2),
        name: r.get(3),
        filename: r.get(4),
        size: r.get(5),
        segments: r.get(6),
        geometry: r.get(7),
        set_path: r.get(8),
        image_file: r.get(9),
        time: r.get(10),
    }
}

async fn load(s: &AppState, id: i64) -> ApiResult<Linked> {
    sqlx::query(&format!("{SELECT} WHERE lv.id = $1"))
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .map(|r| row_of(&r))
        .ok_or_else(|| ApiError::not_found("No segmentation file matches the given query."))
}

/// 404 unless the account may read the set of the file.
async fn can_read(s: &AppState, p: &Principal, set: i64) -> ApiResult<()> {
    if let Some(row) = set_row(s, set).await? {
        if perms(s, p, &row).await?.read {
            return Ok(());
        }
    }
    Err(ApiError::not_found(
        "No segmentation file matches the given query.",
    ))
}

async fn can_edit(s: &AppState, p: &Principal, set: i64) -> ApiResult<()> {
    can_read(s, p, set).await?;
    let row = set_row(s, set).await?.expect("checked");
    if perms(s, p, &row).await?.edit_set {
        Ok(())
    } else {
        Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for editing this image set missing.",
        ))
    }
}

fn file_of(s: &AppState, r: &Linked) -> PathBuf {
    s.slides.root().join(&r.set_path).join(&r.filename)
}

fn volume_of(s: &AppState, r: &Linked) -> Option<PathBuf> {
    r.image_file
        .as_ref()
        .map(|f| s.slides.root().join(&r.set_path).join(f))
}

fn json_of(r: &Linked) -> Value {
    json!({
        "id": r.id, "name": r.name, "filename": r.filename, "set": r.set, "image": r.image,
        "size": r.size, "segments": r.segments, "geometry": r.geometry, "time": r.time,
    })
}

/// What the upload stores: the segments of the file, their colours as `#rrggbb`.
pub fn segments_json(n: &nrrd::Nrrd) -> Value {
    let len = |a: usize| (0..3).map(|i| n.affine[i][a].powi(2)).sum::<f64>().sqrt();
    let voxel_mm3 = len(0) * len(1) * len(2);
    Value::Array(
        n.segments
            .iter()
            .map(|g| {
                json!({
                    "index": g.index, "name": g.name, "id": g.id, "label": g.label, "layer": g.layer, "voxels": g.voxels, "volume_mm3": g.voxels as f64 * voxel_mm3,
                    "color": format!("#{:02x}{:02x}{:02x}", g.color[0], g.color[1], g.color[2]),
                })
            })
            .collect(),
    )
}

/// The id of the segmentation file with this file name in the set, if there is one.
pub async fn existing(s: &AppState, set: i64, filename: &str) -> Result<Option<i64>, String> {
    sqlx::query_scalar(
        "SELECT id FROM exact_rust_linked_volume WHERE image_set_id = $1 AND filename = $2",
    )
    .bind(set)
    .bind(filename)
    .fetch_optional(&s.pool)
    .await
    .map_err(|e| e.to_string())
}

/// Upload of an NRRD file that has been stored at `path` in the folder of set `set`: reads it and adds the row. The error is
/// what the uploader is told, and whether the file is to be removed again (it is not when a row already owns it).
pub async fn register_file(
    s: &AppState,
    p: &Principal,
    set: i64,
    path: &std::path::Path,
    name: &str,
    filename: &str,
) -> Result<i64, (String, bool)> {
    let owned = path.to_string_lossy().into_owned();
    let n = tokio::task::spawn_blocking(move || nrrd::read(&owned))
        .await
        .map_err(|e| (e.to_string(), true))?
        .map_err(|e| {
            (
                format!("The segmentation file cannot be read: {}", e.0),
                true,
            )
        })?;
    if n.segments.is_empty() {
        return Err(("The segmentation file has no labelled voxels.".into(), true));
    }
    let size = tokio::fs::metadata(path)
        .await
        .map(|m| m.len() as i64)
        .unwrap_or(0);
    sqlx::query_scalar(
        "INSERT INTO exact_rust_linked_volume (image_set_id, name, filename, size, segments, creator_id) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(set)
    .bind(name)
    .bind(filename)
    .bind(size)
    .bind(segments_json(&n))
    .bind(p.user.id)
    .fetch_one(&s.pool)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => (
            "This segmentation file already exists in the imageset!".to_string(),
            false,
        ),
        e => (e.to_string(), true),
    })
}

// ------------------------------------------------------------------------------------------------ resampled labels

struct Entry {
    shape: [usize; 3],
    labels: Vec<u16>,
    planes: [(usize, usize); 3],
    inside: u64,
    kept: f64,
    volume_mm: [f64; 3],
}

fn cache() -> &'static moka::sync::Cache<i64, Arc<Entry>> {
    static C: OnceLock<moka::sync::Cache<i64, Arc<Entry>>> = OnceLock::new();
    C.get_or_init(|| {
        moka::sync::Cache::builder()
            .weigher(|_, e: &Arc<Entry>| {
                (e.labels.len() * 2 / 1024).clamp(1, u32::MAX as usize) as u32
            })
            .max_capacity(640 * 1024) // KB: a few volumes
            .time_to_idle(std::time::Duration::from_secs(20 * 60))
            .build()
    })
}

fn build(volume: &str, file: &str) -> Result<Entry, String> {
    let vol = exact_wsi::nifti::Nifti::open(volume)
        .map_err(|_| "Segmentation files can be linked to NIfTI volumes only.".to_string())?;
    let grid = vol
        .grid()
        .ok_or("A series with several volumes cannot carry a segmentation file.")?;
    let n = nrrd::read(file).map_err(|e| e.0)?;
    let r = n.resample(grid.shape, &grid.affine).map_err(|e| e.0)?;
    let len = |a: usize| {
        (0..3)
            .map(|i| grid.affine[i][a].powi(2))
            .sum::<f64>()
            .sqrt()
    };
    Ok(Entry {
        shape: r.shape,
        labels: r.labels,
        planes: grid.planes,
        inside: r.inside,
        kept: r.kept,
        volume_mm: [len(0), len(1), len(2)],
    })
}

async fn entry(s: &AppState, r: &Linked) -> ApiResult<Arc<Entry>> {
    if let Some(e) = cache().get(&r.id) {
        return Ok(e);
    }
    let Some(volume) = volume_of(s, r) else {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "The segmentation file is not linked to a volume.",
        ));
    };
    let (file, id) = (file_of(s, r), r.id);
    if !file.exists() {
        return Err(ApiError::detail(
            StatusCode::NOT_FOUND,
            "The segmentation file is missing on the server. Delete this entry and upload the file again.",
        ));
    }
    let e = tokio::task::spawn_blocking(move || {
        cache()
            .try_get_with(id, || {
                build(&volume.to_string_lossy(), &file.to_string_lossy()).map(Arc::new)
            })
            .map_err(|e| (*e).clone())
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))?
    .map_err(|e| ApiError::detail(StatusCode::BAD_REQUEST, e))?;
    Ok(e)
}

fn report(e: &Entry) -> Value {
    let total = e.shape.iter().product::<usize>().max(1) as f64;
    json!({
        "coverage": e.inside as f64 / total,
        "kept": e.kept,
        "fits": e.kept >= 0.98,
        "volume_voxels": e.shape,
        "volume_voxel_mm": e.volume_mm,
    })
}

// ------------------------------------------------------------------------------------------------ lists and names

async fn list_where(s: &AppState, clause: &str, id: i64) -> ApiResult<Vec<Linked>> {
    Ok(
        sqlx::query(&format!("{SELECT} WHERE {clause} ORDER BY lv.name"))
            .bind(id)
            .fetch_all(&s.pool)
            .await
            .map_err(db_err)?
            .iter()
            .map(row_of)
            .collect(),
    )
}

async fn set_list_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    can_read(&s, &p, id).await?;
    let rows = list_where(&s, "lv.image_set_id = $1", id).await?;
    Ok(Json(rows.iter().map(json_of).collect::<Vec<_>>()).into_response())
}

async fn image_list_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let set: Option<i64> =
        sqlx::query_scalar("SELECT image_set_id::bigint FROM images_image WHERE id = $1")
            .bind(id)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?;
    let set = set.ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    can_read(&s, &p, set).await?;
    let rows = list_where(&s, "lv.image_id = $1", id).await?;
    Ok(Json(rows.iter().map(json_of).collect::<Vec<_>>()).into_response())
}

/// Lower-case words of a file name without its extensions and without Slicer's "segmentation" suffix.
fn words(name: &str) -> Vec<String> {
    let lower = name.to_lowercase();
    let stem = [".seg.nrrd", ".nrrd", ".nii.gz", ".nii"]
        .iter()
        .find_map(|e| lower.strip_suffix(e))
        .unwrap_or(&lower);
    stem.split(|c: char| !c.is_alphanumeric())
        .filter(|w| {
            !w.is_empty() && !matches!(*w, "segmentation" | "seg" | "segment" | "labels" | "label")
        })
        .map(str::to_string)
        .collect()
}

/// How much of the segmentation file's name is in the volume's name, 0..1.
fn name_score(file: &str, volume: &str) -> f64 {
    let mut a = words(file);
    // Slicer numbers the segmentation nodes (`... segmentation_1`)
    while a
        .last()
        .is_some_and(|w| w.chars().all(|c| c.is_ascii_digit()))
        && a.len() > 1
    {
        a.pop();
    }
    let b = words(volume);
    if a.is_empty() {
        return 0.0;
    }
    a.iter().filter(|w| b.contains(w)).count() as f64 / a.len() as f64
}

/// The NIfTI volumes of the file's set, the best name match first.
async fn volumes_of(s: &AppState, r: &Linked) -> ApiResult<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT id::bigint, name, filename FROM images_image WHERE image_set_id = $1 \
         AND (filename ILIKE '%.nii' OR filename ILIKE '%.nii.gz') ORDER BY name LIMIT 500",
    )
    .bind(r.set)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let mut out: Vec<(f64, Value)> = rows
        .iter()
        .map(|v| {
            let name: String = v.get(1);
            let score =
                name_score(&r.filename, &name).max(name_score(&r.filename, &v.get::<String, _>(2)));
            (
                score,
                json!({"id": v.get::<i64, _>(0), "name": name, "score": score}),
            )
        })
        .collect();
    out.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out.into_iter().map(|(_, v)| v).collect())
}

async fn one_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let r = load(&s, id).await?;
    can_read(&s, &p, r.set).await?;
    let mut v = json_of(&r);
    v["volumes"] = Value::Array(volumes_of(&s, &r).await?);
    Ok(Json(v).into_response())
}

// ------------------------------------------------------------------------------------------------ link, unlink, delete

#[derive(Deserialize)]
struct LinkBody {
    image: Option<i64>,
}

async fn link_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(b): Json<LinkBody>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PUT).await?)?;
    let mut r = load(&s, id).await?;
    can_edit(&s, &p, r.set).await?;
    cache().invalidate(&id);
    let Some(image) = b.image else {
        sqlx::query(
            "UPDATE exact_rust_linked_volume SET image_id = NULL, geometry = NULL WHERE id = $1",
        )
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
        r.image = None;
        r.geometry = None;
        return Ok(Json(json_of(&r)).into_response());
    };
    let img = sqlx::query("SELECT filename, image_set_id::bigint FROM images_image WHERE id = $1")
        .bind(image)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    if img.get::<i64, _>(1) != r.set {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "The volume must be in the same image set as the segmentation file.",
        ));
    }
    r.image = Some(image);
    r.image_file = Some(img.get(0));
    let e = entry(&s, &r).await?;
    if e.kept < 0.01 {
        cache().invalidate(&id);
        return Err(ApiError::detail(
            StatusCode::UNPROCESSABLE_ENTITY,
            "The segmentation lies outside this volume: no labelled voxel is inside it. Is it the segmentation of another scan?",
        ));
    }
    let geometry = report(&e);
    sqlx::query("UPDATE exact_rust_linked_volume SET image_id = $2, geometry = $3 WHERE id = $1")
        .bind(id)
        .bind(image)
        .bind(&geometry)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    r.geometry = Some(geometry);
    Ok(Json(json_of(&r)).into_response())
}

async fn delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let r = load(&s, id).await?;
    can_edit(&s, &p, r.set).await?;
    sqlx::query("DELETE FROM exact_rust_linked_volume WHERE id = $1")
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    cache().invalidate(&id);
    let _ = tokio::fs::remove_file(file_of(&s, &r)).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ------------------------------------------------------------------------------------------------ pictures

#[derive(Deserialize)]
struct SliceQuery {
    hide: Option<String>,
    alpha: Option<u8>,
}

fn segment_colors(r: &Linked) -> Vec<[u8; 3]> {
    r.segments
        .as_array()
        .map(|a| {
            a.iter()
                .map(|g| {
                    let c = g["color"]
                        .as_str()
                        .unwrap_or("#ff0000")
                        .trim_start_matches('#');
                    let v = u32::from_str_radix(c, 16).unwrap_or(0xff0000);
                    [(v >> 16) as u8, (v >> 8) as u8, v as u8]
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn slice_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((id, plane, frame)): Path<(i64, u32, usize)>,
    Query(q): Query<SliceQuery>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let r = load(&s, id).await?;
    can_read(&s, &p, r.set).await?;
    if plane > 2 {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "plane is 0 (axial), 1 (coronal) or 2 (sagittal).",
        ));
    }
    let e = entry(&s, &r).await?;
    let colors = segment_colors(&r);
    let hidden: Vec<usize> = q
        .hide
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter_map(|v| v.trim().parse().ok())
        .collect();
    let alpha = q.alpha.unwrap_or(150);
    let (w, h) = e.planes[plane as usize];
    let png = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let px = nrrd::plane_labels(&e.labels, e.shape, plane, frame, (w, h))
            .ok_or("frame is outside the volume.")?;
        let mut out = vec![0u8; w * h * 4];
        for (i, l) in px.iter().enumerate() {
            if *l == 0 {
                continue;
            }
            let seg = (*l - 1) as usize;
            if hidden.contains(&seg) {
                continue;
            }
            let c = colors.get(seg).copied().unwrap_or([255, 0, 0]);
            out[i * 4..i * 4 + 4].copy_from_slice(&[c[0], c[1], c[2], alpha]);
        }
        let mut png = Vec::new();
        image::codecs::png::PngEncoder::new(&mut png)
            .write_image(&out, w as u32, h as u32, image::ExtendedColorType::Rgba8)
            .map_err(|e| e.to_string())?;
        Ok(png)
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))?
    .map_err(|e| ApiError::detail(StatusCode::BAD_REQUEST, e))?;
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        png,
    )
        .into_response())
}

/// PNGs by (file, volume it is linked to)
type Thumbs = moka::sync::Cache<(i64, i64), Arc<Vec<u8>>>;

fn thumbnails() -> &'static Thumbs {
    static C: OnceLock<Thumbs> = OnceLock::new();
    C.get_or_init(|| {
        moka::sync::Cache::builder()
            .weigher(|_, v: &Arc<Vec<u8>>| (v.len() / 1024).clamp(1, u32::MAX as usize) as u32)
            .max_capacity(16 * 1024)
            .build()
    })
}

const THUMB: u32 = 256;

/// The axial slice with the most labelled voxels, as the picture of the card of the file in the image set: over the volume's
/// own slice when it is linked, else the labels alone on a dark ground (in the file's own axes).
async fn thumbnail_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let r = load(&s, id).await?;
    can_read(&s, &p, r.set).await?;
    let key = (id, r.image.unwrap_or(0));
    let png = match thumbnails().get(&key) {
        Some(p) => p,
        None => {
            let colors = segment_colors(&r);
            let entry = if r.image.is_some() {
                Some(entry(&s, &r).await?)
            } else {
                None
            };
            let (file, volume) = (file_of(&s, &r), volume_of(&s, &r));
            let bytes =
                tokio::task::spawn_blocking(move || thumbnail_png(entry, volume, file, &colors))
                    .await
                    .map_err(|e| exact_core::Error::Internal(e.to_string()))?
                    .map_err(|e| ApiError::detail(StatusCode::BAD_REQUEST, e))?;
            let bytes = Arc::new(bytes);
            thumbnails().insert(key, bytes.clone());
            bytes
        }
    };
    Ok((
        [
            (header::CONTENT_TYPE, "image/png"),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        (*png).clone(),
    )
        .into_response())
}

fn thumbnail_png(
    entry: Option<Arc<Entry>>,
    volume: Option<PathBuf>,
    file: PathBuf,
    colors: &[[u8; 3]],
) -> Result<Vec<u8>, String> {
    use exact_wsi::Slide;
    let busiest = |labels: &[u16], per: usize| {
        (0..labels.len() / per.max(1))
            .max_by_key(|z| {
                labels[z * per..(z + 1) * per]
                    .iter()
                    .filter(|l| **l != 0)
                    .count()
            })
            .unwrap_or(0)
    };
    let (w, h, mut rgba, px, linked): (usize, usize, Vec<u8>, Vec<u16>, bool) =
        match (entry, volume) {
            (Some(e), Some(v)) => {
                let [nx, ny, _] = e.shape;
                let z = busiest(&e.labels, nx * ny);
                let (w, h) = e.planes[0];
                let vol = exact_wsi::nifti::Nifti::open(&v.to_string_lossy()).map_err(|e| e.0)?;
                let img = vol
                    .read_region(0, 0, 0, w as u32, h as u32, z as u32)
                    .map_err(|e| e.0)?;
                let px = nrrd::plane_labels(&e.labels, e.shape, 0, z, (w, h)).ok_or("no slice")?;
                (w, h, img.into_raw(), px, true)
            }
            _ => {
                let n = nrrd::read(&file.to_string_lossy()).map_err(|e| e.0)?;
                let [nx, ny, _] = n.dims;
                let z = busiest(&n.labels, nx * ny);
                let px = n.labels[z * nx * ny..(z + 1) * nx * ny].to_vec();
                let ground = [24u8, 24, 30, 255];
                (nx, ny, ground.repeat(nx * ny), px, false)
            }
        };
    for (i, l) in px.iter().enumerate() {
        if *l == 0 {
            continue;
        }
        let c = colors
            .get((*l - 1) as usize)
            .copied()
            .unwrap_or([255, 0, 0]);
        for k in 0..3 {
            let g = rgba[i * 4 + k] as f32;
            rgba[i * 4 + k] = if linked {
                (0.45 * g + 0.55 * c[k] as f32) as u8
            } else {
                c[k]
            };
        }
        rgba[i * 4 + 3] = 255;
    }
    let img = image::RgbaImage::from_raw(w as u32, h as u32, rgba).ok_or("bad picture")?;
    let scale = (THUMB as f64 / w.max(h) as f64).min(1.0);
    let small = if scale < 1.0 {
        image::imageops::resize(
            &img,
            ((w as f64 * scale).round() as u32).max(1),
            ((h as f64 * scale).round() as u32).max(1),
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            small.as_raw(),
            small.width(),
            small.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|e| e.to_string())?;
    Ok(png)
}

#[derive(Deserialize)]
struct RenderQuery {
    max: Option<usize>,
    hide: Option<String>,
}

/// The labels for the 3D render (`render3d.rs`): the grid of the volume's render, two bytes per cell (how much of the cell is
/// labelled, which segment + 1), headers `x-dims`, `x-extent-mm` and `x-channels: 2`.
async fn render_mask_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<RenderQuery>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let r = load(&s, id).await?;
    can_read(&s, &p, r.set).await?;
    let image = r.image.ok_or_else(|| {
        ApiError::detail(
            StatusCode::CONFLICT,
            "The segmentation file is not linked to a volume.",
        )
    })?;
    let e = entry(&s, &r).await?;
    let (_, g) = crate::v2::seg_jobs::open_volume(&s, image).await?;
    let dims = crate::v2::render3d::render_dims(&g, q.max.unwrap_or(256));
    let mut hidden = vec![false; r.segments.as_array().map_or(0, |a| a.len())];
    for i in q
        .hide
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter_map(|v| v.trim().parse::<usize>().ok())
    {
        if let Some(h) = hidden.get_mut(i) {
            *h = true;
        }
    }
    let body =
        tokio::task::spawn_blocking(move || nrrd::render_cells(&e.labels, e.shape, dims, &hidden))
            .await
            .map_err(|e| exact_core::Error::Internal(e.to_string()))?;
    let mut resp = crate::v2::render3d::answer(&g, dims, body);
    resp.headers_mut()
        .insert("x-channels", header::HeaderValue::from_static("2"));
    Ok(resp)
}

#[derive(Deserialize)]
struct AtQuery {
    x: usize,
    y: usize,
    z: usize,
}

async fn at_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Query(q): Query<AtQuery>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let r = load(&s, id).await?;
    can_read(&s, &p, r.set).await?;
    let e = entry(&s, &r).await?;
    let [nx, ny, nz] = e.shape;
    if q.x >= nx || q.y >= ny || q.z >= nz {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "the voxel is outside the volume.",
        ));
    }
    let l = e.labels[(q.z * ny + q.y) * nx + q.x];
    let segment = (l != 0)
        .then(|| r.segments.get((l - 1) as usize).cloned())
        .flatten();
    Ok(Json(json!({ "segment": segment })).into_response())
}

async fn file_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let r = load(&s, id).await?;
    can_read(&s, &p, r.set).await?;
    let f = tokio::fs::File::open(file_of(&s, &r))
        .await
        .map_err(|_| ApiError::not_found("The file is missing on the server."))?;
    let len = f.metadata().await.map(|m| m.len()).unwrap_or(0);
    let name = r.filename.replace(['"', '\r', '\n'], "_");
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{name}\""),
            ),
        ],
        axum::body::Body::from_stream(tokio_util::io::ReaderStream::new(f)),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_slicer_name_finds_its_volume() {
        let seg = "P1_CT_postop_7m_pkj6zk52 segmentation_1.seg.nrrd";
        assert_eq!(name_score(seg, "P1_CT_postop_7m_pkj6zk52.nii.gz"), 1.0);
        assert!(name_score(seg, "P1_CT_preop_7m_abcdef.nii.gz") < 0.7);
        assert_eq!(name_score(seg, "other.nii"), 0.0);
    }
}
