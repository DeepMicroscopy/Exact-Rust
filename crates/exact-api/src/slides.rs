//! Slide endpoints: slide information, thumbnails, patches, DeepZoom (DZI + tiles), tile pre-caching and download.
//! One implementation serves `/api/v1/images/images/{id}/...` (exact-sync, OpenSeadragon) and `/api/v2/images/{id}/...`.

use crate::{
    auth::{authenticate, require_model_perm, require_user, Principal},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use exact_wsi::{formats::SlideCache, generator::DeepZoom, SlideExt};
use image::ImageEncoder;
use moka::sync::Cache;
use serde_json::{json, Value};
use sqlx::Row;
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};

const IMAGE_CACHE_MAX_AGE: u32 = 24 * 60 * 60;
const MAX_PATCH: i64 = 2048;
/// Bump when slide reading or thumbnail rendering changes so that cached thumbnails are rendered again.
const THUMBNAIL_VERSION: u32 = 2;

#[derive(Clone)]
pub struct SlideState {
    root: PathBuf,
    cache_dir: PathBuf,
    slides: SlideCache,
    dz: Cache<String, Arc<DeepZoom>>,
    tiles: Cache<String, Bytes>,
    build_locks: Arc<std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    /// Thumbnails being rendered at once: slide files are read from slow storage, and a burst of renderings of many different slides
    /// (the covers of a team's 200 image sets) is slower for everybody than the same work one after the other (`EXACT_THUMBNAIL_JOBS`).
    thumb_jobs: Arc<tokio::sync::Semaphore>,
    /// ...and of those that go through the Python helper (CZI, VSI, DICOM), which has few processes: a queue of its own, so that it does not
    /// hold up the other formats.
    thumb_jobs_helper: Arc<tokio::sync::Semaphore>,
    /// Thumbnails being rendered, by cache file: a second request for the same one waits for the first instead of rendering it again.
    thumb_flight: Arc<std::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>>,
    /// Files that could not be rendered, for a few minutes: a corrupt file is not opened again by every page view.
    thumb_failed: Cache<PathBuf, ()>,
}

fn env_count(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
}

impl SlideState {
    pub fn new(root: PathBuf, cache_dir: PathBuf) -> Self {
        Self {
            root,
            cache_dir,
            slides: SlideCache::new(20),
            dz: Cache::new(20),
            build_locks: Default::default(),
            thumb_jobs: Arc::new(tokio::sync::Semaphore::new(env_count(
                "EXACT_THUMBNAIL_JOBS",
                4,
            ))),
            thumb_jobs_helper: Arc::new(tokio::sync::Semaphore::new(env_count(
                "SLIDEIO_WORKERS",
                4,
            ))),
            thumb_flight: Default::default(),
            thumb_failed: Cache::builder()
                .time_to_live(std::time::Duration::from_secs(300))
                .max_capacity(5000)
                .build(),
            tiles: Cache::builder()
                .weigher(|_, v: &Bytes| v.len().try_into().unwrap_or(u32::MAX))
                .max_capacity(512 * 1024 * 1024)
                .build(),
        }
    }

    /// The image folder (`IMAGE_PATH`).
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// Opens (or fetches from the cache) the slide at `path`. Blocking.
    pub fn open_slide(&self, path: &str) -> exact_wsi::Result<Arc<dyn exact_wsi::Slide>> {
        self.slides.get(path)
    }

    /// Drops everything cached for a file that was replaced on disk.
    pub fn forget(&self, path: &str) {
        self.slides.invalidate(path);
        self.dz.invalidate_all();
        self.tiles.invalidate_all();
    }

    /// Tile geometry without registration offsets and without touching the generator cache (slide information only).
    fn plain_deepzoom(&self, path: &str) -> exact_wsi::Result<DeepZoom> {
        Ok(DeepZoom::for_plane(self.slides.get(path)?, 0))
    }

    fn dz_cached(&self, path: &str, plane: u32) -> Option<Arc<DeepZoom>> {
        self.dz.get(&format!("{path}#{plane}"))
    }

    fn dz_put(&self, path: &str, plane: u32, dz: Arc<DeepZoom>) {
        self.dz.insert(format!("{path}#{plane}"), dz);
    }

    /// One lock per file so that concurrent first requests measure the registration once.
    fn build_lock(&self, path: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut m = self.build_locks.lock().unwrap_or_else(|e| e.into_inner());
        m.entry(path.to_string()).or_default().clone()
    }
}

pub fn routes() -> Router<AppState> {
    let mut r = Router::new();
    for base in ["/api/v1/images/images", "/api/v2/images"] {
        let sep = if base.contains("v2") { "-" } else { "_" };
        r = r
            .route(
                &format!("{base}/{{pk}}/slide{sep}information{}", slash(base)),
                get(slide_information),
            )
            .route(
                &format!("{base}/{{pk}}/thumbnail{}", slash(base)),
                get(thumbnail),
            )
            .route(
                &format!("{base}/{{pk}}/get{sep}patch{}", slash(base)),
                get(get_patch),
            );
    }
    // v1 (exact-sync, OpenSeadragon on the old API): `z` selects a file of a multi-file z-stack
    {
        let base = "/api/v1/images/images";
        r = r
            .route(&format!("{base}/{{pk}}/{{z}}/{{frame}}/tile/"), get(dzi_v1))
            .route(
                &format!("{base}/{{pk}}/{{z}}/{{frame}}/tile_files/{{level}}/{{tile}}"),
                get(tile_v1),
            )
            .route(
                &format!("{base}/{{pk}}/{{z}}/{{frame}}/tile_files/{{level}}/{{tile}}/"),
                get(tile_v1),
            );
    }
    // viewer routes (old UI paths and v2): for single-file volumes `z` is the plane, 1 axial / 2 coronal / 3 sagittal
    for base in ["/images/image", "/api/v2/images"] {
        let slash = if base.contains("v2") { "" } else { "/" };
        r = r
            .route(
                &format!("{base}/{{pk}}/{{z}}/{{frame}}/tile{slash}"),
                get(dzi_viewer),
            )
            .route(
                &format!("{base}/{{pk}}/{{z}}/{{frame}}/tile_files/{{level}}/{{tile}}"),
                get(tile_viewer),
            );
    }
    r.route(
        "/api/v1/images/images/{pk}/update_image_cache/",
        axum::routing::patch(update_image_cache),
    )
    .route("/images/api/image/download/{pk}/", get(download))
    .route("/api/v2/images/{pk}/download", get(download))
    .route("/api/v2/images/{pk}/metadata", get(metadata))
}

fn slash(base: &str) -> &'static str {
    if base.contains("v2") {
        ""
    } else {
        "/"
    }
}

pub(crate) struct ImageRow {
    pub(crate) id: i64,
    name: String,
    filename: String,
    depth: i32,
    width: i64,
    height: i64,
    set_path: String,
    set_id: i64,
}

impl ImageRow {
    /// `Image.get_file_name(depth, frame)`
    fn file_name(&self, z: i64, frame: i64) -> String {
        if z > 1 || self.depth > 1 {
            let stem = std::path::Path::new(&self.name)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            format!("{stem}/{z}_{frame}_{}", self.name)
        } else {
            self.filename.clone()
        }
    }

    pub(crate) fn path(&self, s: &AppState, z: i64, frame: i64) -> PathBuf {
        s.slides
            .root
            .join(&self.set_path)
            .join(self.file_name(z, frame))
    }

    /// Server-owned thumbnail cache entry. Keyed by image id plus the source file's size and mtime, so a replaced
    /// file gets a new thumbnail. Django's `_thumbnail.png` files in the image folders are deliberately not used: some
    /// of them were rendered from corrupt pyramid levels and cached forever.
    fn thumbnail_path(&self, s: &AppState) -> PathBuf {
        let stamp = std::fs::metadata(self.path(s, 1, 1))
            .ok()
            .map(|m| {
                let t = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map_or(0, |d| d.as_secs());
                format!("{t}-{}", m.len())
            })
            .unwrap_or_default();
        s.slides
            .cache_dir
            .join("thumbnails")
            .join(format!("{}-v{THUMBNAIL_VERSION}-{stamp}.png", self.id))
    }
}

async fn principal(s: &AppState, headers: &HeaderMap) -> ApiResult<Principal> {
    require_model_perm(
        s,
        authenticate(s, headers, &Method::GET).await?,
        &Method::GET,
        "images",
        "image",
    )
    .await
}

/// Image visible to the viewer through team membership (and token scope); 404 otherwise, as `get_object_or_404`
/// on the scoped queryset does in Django.
async fn image_of(s: &AppState, p: &Principal, id: &str) -> ApiResult<ImageRow> {
    let id: i64 = id.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let v = p.viewer();
    let r = sqlx::query(
        "SELECT i.id, i.name, i.filename, i.depth, i.width, i.height, s.path, s.id FROM images_image i \
         JOIN images_imageset s ON s.id = i.image_set_id \
         WHERE i.id = $1 AND s.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $2 \
           AND ($3::bigint[] IS NULL OR team_id = ANY($3)))",
    )
    .bind(id)
    .bind(v.id)
    .bind(v.token_teams)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    Ok(ImageRow {
        id: r.get(0),
        name: r.get(1),
        filename: r.get(2),
        depth: r.get(3),
        width: r.get::<i32, _>(4).into(),
        height: r.get::<i32, _>(5).into(),
        set_path: r.get(6),
        set_id: r.get(7),
    })
}

fn blocking_err(e: tokio::task::JoinError) -> ApiError {
    exact_core::Error::Internal(e.to_string()).into()
}

fn slide_err(e: exact_wsi::WsiError) -> ApiError {
    tracing::warn!("slide error: {e}");
    ApiError::detail(StatusCode::BAD_REQUEST, "The slide cannot be read.")
}

fn png(rgb: &image::RgbImage) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = image::codecs::png::PngEncoder::new(&mut out).write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    );
    out
}

fn encode(rgb: &image::RgbImage, format: &str) -> Vec<u8> {
    if format == "png" {
        return png(rgb);
    }
    let mut out = Vec::new();
    let _ = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90).write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    );
    out
}

fn browser_cached(content_type: &'static str, body: impl Into<Bytes>) -> Response {
    let mut r = (StatusCode::OK, body.into()).into_response();
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_str(&format!("max-age={IMAGE_CACHE_MAX_AGE}, private")).expect("ascii"),
    );
    r
}

async fn slide_information(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
) -> ApiResult<Json<Value>> {
    let p = principal(&s, &headers).await?;
    let img = image_of(&s, &p, &pk).await?;
    let path = img.path(&s, 1, 1).to_string_lossy().into_owned();
    let st = s.slides.clone();
    let info = tokio::task::spawn_blocking(move || {
        let dz = st.plain_deepzoom(&path)?;
        let slide = dz.slide();
        Ok::<_, exact_wsi::WsiError>(json!({
            "id": pk,
            "level_dimensions": slide.level_dimensions().iter().map(|&(w, h)| json!([w, h])).collect::<Vec<_>>(),
            "level_downsamples": slide.level_downsamples(),
            "level_tiles": dz.level_tiles().iter().map(|&(w, h)| json!([w, h])).collect::<Vec<_>>(),
            "levels": slide.level_count(),
        }))
    })
    .await
    .map_err(blocking_err)?
    .map_err(slide_err)?;
    Ok(Json(info))
}

async fn thumbnail(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
) -> ApiResult<Response> {
    let p = principal(&s, &headers).await?;
    let img = Arc::new(image_of(&s, &p, &pk).await?);
    let st = s.slides.clone();
    let path = img.path(&s, 1, 1);
    // everything that touches the file system runs off the async threads (the storage may be slow: even a stat can take a while)
    let (thumb_path, hit) = {
        let (s, img) = (s.clone(), img.clone());
        tokio::task::spawn_blocking(move || {
            let tp = img.thumbnail_path(&s);
            let hit = std::fs::read(&tp).ok();
            (tp, hit)
        })
        .await
        .map_err(blocking_err)?
    };
    if let Some(b) = hit {
        return Ok(browser_cached("image/png", b));
    }
    if st.thumb_failed.contains_key(&thumb_path) {
        return Err(slide_err(exact_wsi::WsiError("failed before".into())));
    }
    // one rendering per thumbnail at a time, and a limited number of renderings altogether
    let flight = {
        let mut m = st.thumb_flight.lock().unwrap_or_else(|e| e.into_inner());
        m.entry(thumb_path.clone()).or_default().clone()
    };
    let _one = flight.lock().await;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let queue = if matches!(ext.as_str(), "czi" | "vsi" | "dcm") {
        st.thumb_jobs_helper.clone()
    } else {
        st.thumb_jobs.clone()
    };
    let _permit = queue
        .acquire_owned()
        .await
        .map_err(|e| ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let (slides, tp) = (st.clone(), thumb_path.clone());
    let result = tokio::task::spawn_blocking(move || -> exact_wsi::Result<Vec<u8>> {
        if let Ok(b) = std::fs::read(&tp) {
            return Ok(b); // another request finished it while this one waited
        }
        let slide = slides.slides.get_light(&path.to_string_lossy())?;
        let b = png(&slide.thumbnail((128, 128))?);
        if let Some(dir) = tp.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // best effort cache; written whole under another name, so that nobody reads half a file
        let tmp = tp.with_extension(format!("tmp{}", std::process::id()));
        if std::fs::write(&tmp, &b).is_ok() && std::fs::rename(&tmp, &tp).is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        Ok(b)
    })
    .await
    .map_err(blocking_err)?;
    {
        let mut m = st.thumb_flight.lock().unwrap_or_else(|e| e.into_inner());
        if m.get(&thumb_path)
            .is_some_and(|f| Arc::strong_count(f) <= 2)
        {
            m.remove(&thumb_path); // nobody else waits for it
        }
    }
    match result {
        Ok(bytes) => Ok(browser_cached("image/png", bytes)),
        Err(e) => {
            st.thumb_failed.insert(thumb_path, ());
            Err(slide_err(e))
        }
    }
}

async fn get_patch(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let p = principal(&s, &headers).await?;
    let img = image_of(&s, &p, &pk).await?;
    let num = |k: &str, d: i64| -> ApiResult<i64> {
        q.get(k).map_or(Ok(d), |v| {
            v.parse().map_err(|_| {
                ApiError::detail(StatusCode::BAD_REQUEST, format!("{k} must be an integer."))
            })
        })
    };
    let (x, y, level) = (num("x", 0)?, num("y", 0)?, num("level", 0)?);
    let mut width = num("width", img.width)?;
    if x + width > img.width {
        width = img.width - x;
    }
    let mut height = num("height", img.height)?;
    if y + height > img.height {
        height = img.height - y;
    }
    if !(width > 0 && height > 0 && width <= MAX_PATCH && height <= MAX_PATCH) || level < 0 {
        return Ok((
            StatusCode::BAD_REQUEST,
            Json(
                json!({"Error": "Image patch not valid max size 2048x2048 pixel or size negativ"}),
            ),
        )
            .into_response());
    }
    let path = img.path(&s, 1, 1).to_string_lossy().into_owned();
    let st = s.slides.clone();
    let bytes = tokio::task::spawn_blocking(move || -> exact_wsi::Result<Vec<u8>> {
        let slide = st.slides.get(&path)?;
        let region = slide.read_region(x, y, level as usize, width as u32, height as u32, 0)?;
        // Django drops the alpha channel without compositing
        let rgb = image::DynamicImage::ImageRgba8(region).to_rgb8();
        Ok(png(&rgb))
    })
    .await
    .map_err(blocking_err)?
    .map_err(slide_err)?;
    let mut r = (StatusCode::OK, Bytes::from(bytes)).into_response();
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    Ok(r)
}

async fn dzi_v1(
    state: State<AppState>,
    headers: HeaderMap,
    Path((pk, z, frame)): Path<(String, i64, i64)>,
) -> ApiResult<Response> {
    let p = principal(&state.0, &headers).await?;
    let img = image_of(&state.0, &p, &pk).await?;
    dzi_for(&state.0, &img, z, frame, 0).await
}

/// Viewer access: the user must be able to read the image set (403 otherwise), like Django's `has_perm('read')`.
pub(crate) async fn viewer_image(
    s: &AppState,
    headers: &HeaderMap,
    pk: &str,
) -> ApiResult<ImageRow> {
    let p = require_user(authenticate(s, headers, &Method::GET).await?)?;
    let id: i64 = pk.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let r = sqlx::query("SELECT i.id, i.name, i.filename, i.depth, i.width, i.height, s.path, s.id FROM images_image i JOIN images_imageset s ON s.id = i.image_set_id WHERE i.id = $1")
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    let img = ImageRow {
        id: r.get(0),
        name: r.get(1),
        filename: r.get(2),
        depth: r.get(3),
        width: r.get::<i32, _>(4).into(),
        height: r.get::<i32, _>(5).into(),
        set_path: r.get(6),
        set_id: r.get(7),
    };
    if !crate::compat::legacy::can_read_set(s, &p, img.set_id).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for reading this image set missing.",
        ));
    }
    Ok(img)
}

/// `(plane, file selector)` of a viewer request, see `routes`.
fn plane_and_z(img: &ImageRow, z: i64) -> (u32, i64) {
    if img.depth == 1 {
        ((z - 1).max(0) as u32, 1)
    } else {
        (0, z)
    }
}

async fn dzi_viewer(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((pk, z, frame)): Path<(String, i64, i64)>,
) -> ApiResult<Response> {
    let img = viewer_image(&s, &headers, &pk).await?;
    let (plane, z) = plane_and_z(&img, z);
    dzi_for(&s, &img, z, frame, plane).await
}

/// Slide metadata for the viewer: size, levels, frames, resolution and the MPR planes of volumes.
async fn metadata(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
) -> ApiResult<Json<Value>> {
    let img = viewer_image(&s, &headers, &pk).await?;
    let path = img.path(&s, 1, 1).to_string_lossy().into_owned();
    let st = s.slides.clone();
    let out = tokio::task::spawn_blocking(move || -> exact_wsi::Result<Value> {
        let slide = st.slides.get(&path)?;
        let (w, h) = slide.dimensions();
        let props = slide.properties();
        let num = |k: &str| props.get(k).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
        let planes = if slide.plane_dimensions(0).is_some() {
            let names = ["axial", "coronal", "sagittal"];
            Some(
                (0..3u32)
                    .filter_map(|p| {
                        let (pw, ph) = slide.plane_dimensions(p)?;
                        Some(json!({"plane": p, "name": names[p as usize], "width": pw, "height": ph,
                            "frames": slide.plane_frames(p), "frame_descriptors": slide.plane_frame_descriptors(p)}))
                    })
                    .collect::<Vec<_>>(),
            )
        } else {
            None
        };
        Ok(json!({
            "level_count": slide.level_count(), "width": w, "height": h, "frames": slide.frame_count(),
            "mpp_x": num("openslide.mpp-x"), "mpp_y": num("openslide.mpp-y"), "mpp_z": num("openslide.mpp-z"),
            "objective_power": num("openslide.objective-power"), "planes": planes,
            "issues": slide.issues(),
            "frame_kind": slide.frame_kind().as_str(),
            "frame_labels": slide.frame_labels(),
            "frame_rate": slide.frame_rate(),
            "z_range": slide.z_positions().and_then(|(z, unit)| Some(json!({"start": z.first()?, "end": z.last()?, "positions": z, "unit": unit}))),
        }))
    })
    .await
    .map_err(blocking_err)?
    .map_err(slide_err)?;
    Ok(Json(out))
}

/// (size, mtime in seconds) of a file: identifies the version of an image file stored offsets were measured on.
fn file_stamp(path: &str) -> Option<(i64, i64)> {
    let m = std::fs::metadata(path).ok()?;
    let t = m
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((m.len() as i64, t as i64))
}

/// Tile generator of an image file. Pyramids whose levels are displaced against each other (slideio formats) need
/// registration offsets: they are measured once, stored in `images_pyramidregistration` (shared with EXACT) together with
/// the file's size and mtime, and read from there afterwards, so only the first opening of a file pays for the measurement.
/// Level 0, the full resolution, is never shifted.
pub(crate) async fn get_dz(
    s: &AppState,
    img: &ImageRow,
    z: i64,
    frame: i64,
    plane: u32,
) -> ApiResult<Arc<DeepZoom>> {
    let path = img.path(s, z, frame).to_string_lossy().into_owned();
    if let Some(d) = s.slides.dz_cached(&path, plane) {
        return Ok(d);
    }
    let lock = s.slides.build_lock(&path);
    let _guard = lock.lock().await;
    if let Some(d) = s.slides.dz_cached(&path, plane) {
        return Ok(d); // built while this request waited
    }
    // stored offsets are per image; the files of multi-file z-stacks (depth > 1) are measured without storing
    let stamp = file_stamp(&path).filter(|_| img.depth == 1);
    let stored = match stamp {
        Some((size, mtime)) => exact_db::registration::get(&s.pool, img.id)
            .await?
            .filter(|r| {
                r.algorithm == exact_wsi::registration::ALGORITHM
                    && r.file_size == size
                    && r.file_mtime == mtime
            })
            .map(|r| r.offsets),
        None => None,
    };
    let st = s.slides.clone();
    let (dz, measured) = tokio::task::spawn_blocking(move || -> exact_wsi::Result<_> {
        let slide = st.open_slide(&path)?;
        let (offsets, measured) = match stored {
            Some(o) => (o, None),
            None if slide.needs_registration() => {
                let o = exact_wsi::registration::estimate_level_offsets(slide.as_ref());
                (o.clone(), Some(o))
            }
            None => (Vec::new(), None),
        };
        Ok((
            Arc::new(DeepZoom::build(slide, plane, offsets)),
            measured,
            path,
        ))
    })
    .await
    .map_err(blocking_err)?
    .map_err(slide_err)
    .map(|(dz, measured, path)| {
        s.slides.dz_put(&path, plane, dz.clone());
        (dz, measured)
    })?;
    if let (Some(offsets), Some((size, mtime))) = (measured, stamp) {
        if let Err(e) = exact_db::registration::put(
            &s.pool,
            img.id,
            &offsets,
            exact_wsi::registration::ALGORITHM,
            size,
            mtime,
        )
        .await
        {
            tracing::warn!(
                "cannot store the pyramid registration of image {}: {e}",
                img.id
            );
        }
    }
    Ok(dz)
}

async fn dzi_for(
    s: &AppState,
    img: &ImageRow,
    z: i64,
    frame: i64,
    plane: u32,
) -> ApiResult<Response> {
    let xml = get_dz(s, img, z, frame, plane).await?.dzi("jpeg");
    let mut r = (StatusCode::OK, xml).into_response();
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/xml"),
    );
    Ok(r)
}

fn parse_tile(t: &str) -> Option<(u64, u64, &'static str)> {
    let (stem, ext) = t.rsplit_once('.')?;
    let (c, r) = stem.split_once('_')?;
    let fmt = match ext {
        "png" => "png",
        "jpeg" => "jpeg",
        _ => return None,
    };
    Some((c.parse().ok()?, r.parse().ok()?, fmt))
}

async fn tile_v1(
    state: State<AppState>,
    headers: HeaderMap,
    Path((pk, z, frame, level, tile)): Path<(String, i64, i64, usize, String)>,
) -> ApiResult<Response> {
    let p = principal(&state.0, &headers).await?;
    let img = image_of(&state.0, &p, &pk).await?;
    tile_for(&state.0, &img, z, frame, level, &tile, 0).await
}

async fn tile_viewer(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((pk, z, frame, level, tile)): Path<(String, i64, i64, usize, String)>,
) -> ApiResult<Response> {
    let img = viewer_image(&s, &headers, &pk).await?;
    let (plane, z) = plane_and_z(&img, z);
    tile_for(&s, &img, z, frame, level, &tile, plane).await
}

async fn tile_for(
    s: &AppState,
    img: &ImageRow,
    z: i64,
    frame: i64,
    level: usize,
    tile: &str,
    plane: u32,
) -> ApiResult<Response> {
    let Some((col, row, format)) = parse_tile(tile) else {
        return Err(ApiError::not_found_page());
    };
    let key = format!(
        "{}/{z}/{frame}/{plane}/{level}/{col}/{row}.{format}",
        img.id
    );
    let ctype = if format == "png" {
        "image/png"
    } else {
        "image/jpeg"
    };
    if let Some(b) = s.slides.tiles.get(&key) {
        return Ok(browser_cached(ctype, b));
    }
    let dz = get_dz(s, img, z, frame, plane).await?;
    let bytes = tokio::task::spawn_blocking(move || -> exact_wsi::Result<Bytes> {
        let n = dz.slide().frame_count().max(1);
        let t = dz.tile(level, (col, row), (frame.max(0) as u32).min(n - 1))?;
        Ok(Bytes::from(encode(&t, format)))
    })
    .await
    .map_err(blocking_err)?;
    // Django answers every failure here with a bare 400
    let Ok(bytes) = bytes else {
        return Ok(StatusCode::BAD_REQUEST.into_response());
    };
    s.slides.tiles.insert(key, bytes.clone());
    Ok(browser_cached(ctype, bytes))
}

async fn update_image_cache(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::PATCH).await?,
        &Method::PATCH,
        "images",
        "image",
    )
    .await?;
    let img = image_of(&s, &p, &pk).await?;
    let data: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let get = |k: &str, d: i64| {
        data.get(k)
            .and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
            })
            .unwrap_or(d)
    };
    let (mem_mb, z, frame) = (
        get("mem_size_mb", 5) as f64,
        get("z_dimension", 1),
        get("frame", 1),
    );
    let id = img.id;
    let dz = get_dz(&s, &img, 1, 1, 0).await?;
    let st = s.slides.clone();
    let out = tokio::task::spawn_blocking(move || -> exact_wsi::Result<Value> {
        let (mut results, mut total, mut sum) = (serde_json::Map::new(), 0u64, 0f64);
        for (level, &(cols, rows)) in dz.level_tiles().iter().enumerate() {
            let t0 = Instant::now();
            'level: for col in 0..cols {
                for row in 0..rows {
                    let key = format!("{id}/{z}/{frame}/0/{level}/{col}/{row}.jpeg");
                    if st.tiles.get(&key).is_none() {
                        let t = dz.tile(level, (col, row), frame.max(0) as u32)?;
                        let b = Bytes::from(encode(&t, "jpeg"));
                        sum += b.len() as f64 / (1024.0 * 1024.0);
                        total += 1;
                        st.tiles.insert(key, b);
                    }
                    if sum > mem_mb {
                        break 'level;
                    }
                }
            }
            results.insert(
                level.to_string(),
                json!({"Level": level, "Size_MB": sum, "Tiles": [cols, rows], "Total": total, "Sec.": t0.elapsed().as_secs_f64()}),
            );
            if sum > mem_mb {
                break;
            }
        }
        Ok(Value::Object(results))
    })
    .await
    .map_err(blocking_err)?
    .map_err(slide_err)?;
    Ok(Json(out))
}

async fn download(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let id: i64 = pk.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let row = sqlx::query("SELECT i.id, i.name, i.filename, i.depth, i.width, i.height, s.path, s.id FROM images_image i JOIN images_imageset s ON s.id = i.image_set_id WHERE i.id = $1")
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    let set_id: i64 = row.get(7);
    let img = ImageRow {
        id: row.get(0),
        name: row.get(1),
        filename: row.get(2),
        depth: row.get(3),
        width: row.get::<i32, _>(4).into(),
        height: row.get::<i32, _>(5).into(),
        set_path: row.get(6),
        set_id,
    };
    if !crate::compat::legacy::can_read_set(&s, &p, set_id).await? {
        return Ok((
            StatusCode::FORBIDDEN,
            Json(json!({"message": "you do not have the permission to access this imageset"})),
        )
            .into_response());
    }
    let file = if q.get("original_image").map(String::as_str) == Some("True") {
        s.slides.root.join(&img.set_path).join(&img.name)
    } else {
        img.path(&s, 1, 1)
    };
    let ext = file
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_uppercase())
        .unwrap_or_default();
    if ext == "MRXS" || ext == "VSI" {
        let name = file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let zipped =
            tokio::task::spawn_blocking(move || crate::slides::zip_companions(&file, &ext))
                .await
                .map_err(blocking_err)?
                .map_err(|e| ApiError::from(exact_core::Error::Internal(e.to_string())))?;
        let mut r = (StatusCode::OK, Bytes::from(zipped)).into_response();
        r.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/zip"),
        );
        r.headers_mut().insert(
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(&format!("attachment; filename=\"{name}.zip\""))
                .map_err(|_| ApiError::not_found("Not found."))?,
        );
        return Ok(r);
    }
    let meta = tokio::fs::metadata(&file)
        .await
        .map_err(|_| ApiError::not_found("Not found."))?;
    let f = tokio::fs::File::open(&file)
        .await
        .map_err(|_| ApiError::not_found("Not found."))?;
    let mut r = Response::new(axum::body::Body::from_stream(
        tokio_util::io::ReaderStream::new(f),
    ));
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    r.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    r.headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
    // keeps the compression layer from re-encoding the stream, which would drop Content-Length
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-transform"),
    );
    r.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename={name}"))
            .map_err(|_| ApiError::not_found("Not found."))?,
    );
    Ok(r)
}

/// MRXS / VSI slides consist of the index file plus a companion directory; they are downloaded as one zip.
pub fn zip_companions(file: &std::path::Path, ext: &str) -> std::io::Result<Vec<u8>> {
    use std::io::Write;
    let stem_dir = file.with_extension("");
    let dir = if ext == "VSI" {
        let stem = stem_dir
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        stem_dir.with_file_name(format!("_{stem}_"))
    } else {
        stem_dir
    };
    let dir_name = dir
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut out = std::io::Cursor::new(Vec::new());
    let mut zip = zip::ZipWriter::new(&mut out);
    let opts = zip::write::SimpleFileOptions::default();
    fn walk(
        zip: &mut zip::ZipWriter<&mut std::io::Cursor<Vec<u8>>>,
        dir: &std::path::Path,
        prefix: &str,
        o: zip::write::SimpleFileOptions,
    ) -> std::io::Result<()> {
        let mut entries: Vec<_> = std::fs::read_dir(dir)?.collect::<Result<_, _>>()?;
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = format!("{prefix}/{}", e.file_name().to_string_lossy());
            if e.path().is_dir() {
                zip.add_directory(format!("{name}/"), o)?;
                walk(zip, &e.path(), &name, o)?;
            } else {
                zip.start_file(name, o)?;
                zip.write_all(&std::fs::read(e.path())?)?;
            }
        }
        Ok(())
    }
    walk(&mut zip, &dir, &dir_name, opts)?;
    let main = if ext == "VSI" {
        format!(
            "{dir_name}/{}",
            file.file_name().unwrap_or_default().to_string_lossy()
        )
    } else {
        file.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    };
    zip.start_file(main, opts)?;
    zip.write_all(&std::fs::read(file)?)?;
    zip.finish()?;
    Ok(out.into_inner())
}
