//! Image upload: `POST /images/image/upload/{set}/` (exact-sync's `ExactManager` and the old UI, answers `{"files": [...]}`),
//! `POST /api/v1/images/images/` (exact-sync's `ImagesApi.create_image`, the set in the form field `image_set`, answers the
//! new images as a v1 list page) and `POST /api/v2/image-sets/{id}/images` (same processing, `{"items": [...]}`), multipart
//! with any number of files.
//!
//! Per file, as in Django's `upload_image`: a ZIP is unpacked into the set folder (a `.mrxs`, `.vms` or `.vsi` in the
//! archive makes only those files images), documents become auxiliary files, everything else is opened by the slide
//! readers and registered as an image with its size, resolution, objective power and frame descriptions. Unlike Django,
//! files are streamed to disk and no format conversion is needed (the readers handle CZI, VSI, multi-page TIFF, ...).

use crate::{
    auth::{authenticate, require_model_perm, require_user, Principal},
    compat::{engine::db_err, perms::set_row},
    error::{ApiError, ApiResult},
    page::{Flex, Page, Query},
    AppState,
};
use axum::{
    extract::{multipart::Field, DefaultBodyLimit, FromRequest, Multipart, Path, Request, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use exact_wsi::FrameKind;
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use std::path::{Path as FsPath, PathBuf};
use tokio::io::AsyncWriteExt;

const AUX_EXTENSIONS: &[&str] = &[
    "pdf", "docx", "xlsx", "doc", "csv", "txt", "xls", "pptx", "ppt", "json", "sqlite",
];

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/images/image/upload/{set_id}/", post(legacy_upload))
        .route("/api/v2/image-sets/{id}/images", post(v2_upload))
        // takes precedence over the generic `/api/v1/{group}/{name}/` (which buffers request bodies); the same methods
        .route("/api/v1/images/images/", get(v1_list).post(v1_post))
        .layer(DefaultBodyLimit::disable())
}

struct Target {
    set_id: i64,
    root: PathBuf,
}

async fn target(s: &AppState, p: &Principal, set_id: i64) -> ApiResult<Target> {
    let row = set_row(s, set_id)
        .await?
        .ok_or_else(|| ApiError::not_found("No ImageSet matches the given query."))?;
    let perms = crate::compat::perms::perms(s, p, &row).await?;
    if !perms.edit_set {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for editing this image set missing.",
        ));
    }
    let (path, locked): (String, bool) =
        sqlx::query_as("SELECT path, image_lock FROM images_imageset WHERE id = $1")
            .bind(set_id)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
    if locked {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "the image set is locked.",
        ));
    }
    Ok(Target {
        set_id,
        root: s.slides.root().join(path),
    })
}

async fn legacy_upload(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(set_id): Path<i64>,
    mp: Multipart,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let t = target(&s, &p, set_id).await?;
    let files = receive(&s, &p, &t, mp).await?;
    Ok(Json(json!({ "files": files })).into_response())
}

async fn v2_upload(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(set_id): Path<i64>,
    mp: Multipart,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let t = target(&s, &p, set_id).await?;
    let files = receive(&s, &p, &t, mp).await?;
    let created = files.iter().any(|f| f.get("error").is_none());
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    Ok((status, Json(json!({ "items": files }))).into_response())
}

/// `GET /api/v1/images/images/`: the generic v1 list.
async fn v1_list(
    State(s): State<AppState>,
    headers: HeaderMap,
    method: Method,
    uri: Uri,
) -> Response {
    crate::compat::list_response(&s, &headers, &method, &uri, "images", "images").await
}

async fn v1_post(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    req: Request,
) -> Response {
    crate::compat::respond_list(v1_create(&s, &headers, &uri, req).await)
}

/// `POST /api/v1/images/images/` with the files and `image_set` (`image_type` is ignored, as in Django). Answers the images
/// that were made as a page of the v1 list (200); duplicates and unreadable files are skipped, as in Django, and only show
/// as missing from the answer. Unlike Django, the caller needs the right to edit the (unlocked) set, as for the other
/// uploads. exact-sync sends the file before `image_set`, so files are staged in the image root until the set is known.
async fn v1_create(s: &AppState, headers: &HeaderMap, uri: &Uri, req: Request) -> ApiResult<Value> {
    let spec =
        crate::compat::specs::find("images", "images").ok_or_else(ApiError::not_found_page)?;
    let p = require_model_perm(
        s,
        authenticate(s, headers, &Method::POST).await?,
        &Method::POST,
        spec.perm.0,
        spec.perm.1,
    )
    .await?;
    let mut mp = Multipart::from_request(req, s)
        .await
        .map_err(|e| ApiError::detail(StatusCode::BAD_REQUEST, e.body_text()))?;
    let staging = s.slides.root().to_path_buf();
    let mut staged: Vec<Staged> = vec![];
    let mut set_field: Option<String> = None;
    let made: ApiResult<Vec<i64>> = async {
        tokio::fs::create_dir_all(&staging)
            .await
            .map_err(|e| io_err("cannot create the image folder", e))?;
        while let Some(mut field) = next_field(&mut mp).await? {
            match file_name(&field) {
                Some(name) => staged.push(stage(&mut field, &staging, name).await?),
                None if field.name() == Some("image_set") => {
                    set_field = Some(field.text().await.map_err(|e| {
                        ApiError::detail(StatusCode::BAD_REQUEST, format!("invalid upload: {e}"))
                    })?)
                }
                None => {}
            }
        }
        // Django: `int(request.POST.get('image_set', 0))`, then `get_object_or_404`
        let set_id = match set_field
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            None => 0,
            Some(v) => v.parse::<i64>().map_err(|_| ApiError {
                status: StatusCode::BAD_REQUEST,
                body: json!({"image_set": ["A valid integer is required."]}),
            })?,
        };
        let t = target(s, &p, set_id).await?;
        tokio::fs::create_dir_all(&t.root)
            .await
            .map_err(|e| io_err("cannot create the image set folder", e))?;
        let mut made = vec![];
        for f in staged.drain(..) {
            made.extend(process(s, &p, &t, f).await.1);
        }
        Ok(made)
    }
    .await;
    // files that were not processed (the set was refused or the upload broke off)
    for f in &staged {
        let _ = tokio::fs::remove_file(&f.tmp).await;
    }
    let made = made?;
    let q = Query::parse(uri.query());
    let page = Page::from_query(&q);
    if made.is_empty() {
        return Ok(page.envelope(&q, headers, uri.path(), 0, vec![]));
    }
    let ids = made
        .iter()
        .map(i64::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let (count, results) = crate::compat::engine::list(
        &crate::compat::ctx(s, &p, headers),
        spec,
        &[("id__in".to_string(), ids)],
        &Flex::from_query(&q),
        page.limit,
        page.offset,
        None,
    )
    .await?;
    Ok(page.envelope(&q, headers, uri.path(), count, results))
}

/// A file name without any directory part (what Django's `UploadedFile.name` is).
fn base_name(n: &str) -> String {
    n.rsplit(['/', '\\'])
        .next()
        .unwrap_or("")
        .trim_matches('\0')
        .to_string()
}

async fn receive(
    s: &AppState,
    p: &Principal,
    t: &Target,
    mut mp: Multipart,
) -> ApiResult<Vec<Value>> {
    tokio::fs::create_dir_all(&t.root)
        .await
        .map_err(|e| io_err("cannot create the image set folder", e))?;
    let mut out = vec![];
    while let Some(mut field) = next_field(&mut mp).await? {
        let Some(name) = file_name(&field) else {
            continue;
        };
        let staged = stage(&mut field, &t.root, name).await?;
        out.push(process(s, p, t, staged).await.0);
    }
    Ok(out)
}

async fn next_field(mp: &mut Multipart) -> ApiResult<Option<Field<'_>>> {
    mp.next_field()
        .await
        .map_err(|e| ApiError::detail(StatusCode::BAD_REQUEST, format!("invalid upload: {e}")))
}

/// The name of a file field; `None` for plain form fields.
fn file_name(field: &Field<'_>) -> Option<String> {
    field.file_name().map(base_name).filter(|n| !n.is_empty())
}

/// An uploaded file in a temporary file (`.upload-<uuid>`), with what was learned while streaming it.
struct Staged {
    tmp: PathBuf,
    name: String,
    size: u64,
    checksum: Vec<u8>,
    zip: bool,
}

/// Streams a file field into a temporary file in `dir`, hashing on the way.
async fn stage(field: &mut Field<'_>, dir: &FsPath, name: String) -> ApiResult<Staged> {
    let tmp = dir.join(format!(".upload-{}", uuid::Uuid::new_v4()));
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| io_err("cannot write the upload", e))?;
    let (mut hash, mut size, mut head) = (Sha512::new(), 0u64, Vec::with_capacity(4));
    let streamed: Result<(), String> = async {
        while let Some(chunk) = field.chunk().await.map_err(|e| e.to_string())? {
            if head.len() < 4 {
                head.extend_from_slice(&chunk[..chunk.len().min(4 - head.len())]);
            }
            hash.update(&chunk);
            size += chunk.len() as u64;
            file.write_all(&chunk).await.map_err(|e| e.to_string())?;
        }
        file.flush().await.map_err(|e| e.to_string())
    }
    .await;
    drop(file);
    if let Err(e) = streamed {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("upload failed: {e}"),
        ));
    }
    Ok(Staged {
        tmp,
        name,
        size,
        checksum: hash.finalize().to_vec(),
        zip: head == b"PK\x03\x04",
    })
}

/// Stores a staged file in the set (a ZIP unpacked) and removes the temporary file. Returns the entry of the legacy / v2
/// answer and the ids of the images that were made.
async fn process(s: &AppState, p: &Principal, t: &Target, f: Staged) -> (Value, Vec<i64>) {
    let mut made = vec![];
    let result = if f.zip {
        from_zip(s, p, t, &f.tmp, &mut made).await
    } else {
        single(s, p, t, &f.tmp, &f.name, f.checksum).await
    };
    let _ = tokio::fs::remove_file(&f.tmp).await;
    if let Ok(("image", id)) = result {
        if !made.contains(&id) {
            made.push(id);
        }
    }
    let (name, size) = (f.name, f.size);
    let entry = match result {
        Ok((kind, id)) => json!({"name": name, "size": size, "type": kind, "id": id}),
        Err((id, e)) => json!({"name": name, "size": size, "error": e, "id": id}),
    };
    (entry, made)
}

fn io_err(what: &str, e: std::io::Error) -> ApiError {
    ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, format!("{what}: {e}"))
}

type Outcome = Result<(&'static str, i64), (i64, String)>;

/// A plain upload: duplicate check (same name or file name and checksum in the set), then register.
async fn single(
    s: &AppState,
    p: &Principal,
    t: &Target,
    tmp: &FsPath,
    name: &str,
    checksum: Vec<u8>,
) -> Outcome {
    let dup: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM images_image WHERE image_set_id = $1 AND checksum = $2 AND (name = $3 OR filename = $3) ORDER BY id LIMIT 1",
    )
    .bind(t.set_id)
    .bind(&checksum)
    .bind(name)
    .fetch_optional(&s.pool)
    .await
    .map_err(|e| (-1, e.to_string()))?;
    if let Some(id) = dup {
        return Err((id, "This image already exists in the imageset!".into()));
    }
    // a segmentation file of the same name owns the file on disk: neither overwrite nor remove it
    if name.to_lowercase().ends_with(".nrrd") {
        if let Some(_id) = crate::v2::linked::existing(s, t.set_id, name)
            .await
            .map_err(|e| (-1, e))?
        {
            return Err((
                -1,
                "This segmentation file already exists in the imageset!".into(),
            ));
        }
    }
    let dest = t.root.join(name);
    tokio::fs::copy(tmp, &dest)
        .await
        .map_err(|e| (-1, format!("cannot store the file: {e}")))?;
    register(s, p, t, &dest, name, name, checksum).await
}

/// ZIP: unpack, then register each entry (`.mrxs`, `.vms`, `.vsi` in the archive select the files that are images).
/// The ids of all images made are added to `made`, also when some entries were skipped.
async fn from_zip(
    s: &AppState,
    p: &Principal,
    t: &Target,
    tmp: &FsPath,
    made: &mut Vec<i64>,
) -> Outcome {
    let (tmp, root) = (tmp.to_path_buf(), t.root.clone());
    let names: Result<Vec<String>, String> = tokio::task::spawn_blocking(move || {
        let mut z = zip::ZipArchive::new(std::fs::File::open(&tmp).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        let mut names = vec![];
        for i in 0..z.len() {
            let mut e = z.by_index(i).map_err(|e| e.to_string())?;
            let Some(rel) = e.enclosed_name() else {
                continue;
            };
            let dest = root.join(&rel);
            if e.is_dir() {
                std::fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
                continue;
            }
            if let Some(dir) = dest.parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::io::copy(
                &mut e,
                &mut std::fs::File::create(&dest).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            names.push(rel.to_string_lossy().replace('\\', "/"));
        }
        Ok(names)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    let mut names = names.map_err(|e| {
        (
            -1,
            format!("damaged files in the archive have been skipped! ({e})"),
        )
    })?;
    for marker in [".mrxs", ".vms", ".vsi"] {
        if names.iter().any(|n| n.to_lowercase().contains(marker)) {
            names.retain(|n| n.contains(marker));
        }
    }
    names.sort();
    let (mut last, mut duplicates, mut failed) = (None, 0, 0);
    for rel in names {
        let path = t.root.join(&rel);
        let name = base_name(&rel);
        // Django's zip entries are checksummed over their first 10000 bytes
        let checksum = match first_bytes_digest(&path).await {
            Some(c) => c,
            None => {
                failed += 1;
                continue;
            }
        };
        let exists: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM images_image WHERE image_set_id = $1 AND (name = $2 OR filename = $3)",
        )
        .bind(t.set_id)
        .bind(&name)
        .bind(&rel)
        .fetch_one(&s.pool)
        .await
        .map_err(|e| (-1, e.to_string()))?;
        if exists > 0 {
            duplicates += 1;
            continue;
        }
        match register(s, p, t, &path, &name, &rel, checksum).await {
            Ok(r) => {
                if r.0 == "image" {
                    made.push(r.1);
                }
                last = Some(r)
            }
            Err(_) => failed += 1,
        }
    }
    let mut problems = vec![];
    if failed > 0 {
        problems.push("unsupported files".to_string());
    }
    if duplicates > 0 {
        problems.push(format!("{duplicates} duplicates"));
    }
    if !problems.is_empty() {
        return Err((
            -1,
            format!(
                "{} in the archive have been skipped!",
                problems.join(" and ")
            ),
        ));
    }
    last.ok_or((-1, "The archive contains no files.".into()))
}

async fn first_bytes_digest(path: &FsPath) -> Option<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    let mut f = tokio::fs::File::open(path).await.ok()?;
    let mut buf = vec![0u8; 10000];
    let n = f.read(&mut buf).await.ok()?;
    Some(Sha512::digest(&buf[..n]).to_vec())
}

/// Creates the database rows for a stored file: auxiliary file or image (read through the slide readers).
async fn register(
    s: &AppState,
    p: &Principal,
    t: &Target,
    path: &FsPath,
    name: &str,
    filename: &str,
    checksum: Vec<u8>,
) -> Outcome {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if AUX_EXTENSIONS.contains(&ext.as_str()) {
        let size = tokio::fs::metadata(path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        let id: i64 = sqlx::query_scalar(
            "INSERT INTO images_auxiliaryfile (name, filesize, time, image_set_id, creator_id) VALUES ($1, $2, now(), $3, $4) RETURNING id",
        )
        .bind(name)
        .bind(size as i64)
        .bind(t.set_id)
        .bind(p.user.id)
        .fetch_one(&s.pool)
        .await
        .map_err(|e| (-1, e.to_string()))?;
        return Ok(("auxfile", id));
    }
    if ext == "nrrd" {
        // a segmentation: stored as a file that waits to be linked to a volume (v2/linked.rs)
        return match crate::v2::linked::register_file(s, p, t.set_id, path, name, filename).await {
            Ok(id) => Ok(("segmentation", id)),
            Err((e, remove)) => {
                if remove {
                    let _ = tokio::fs::remove_file(path).await;
                }
                Err((-1, e))
            }
        };
    }
    let owned = path.to_string_lossy().to_string();
    let info = tokio::task::spawn_blocking(move || {
        let slide = exact_wsi::formats::open(&owned).map_err(|e| e.to_string())?;
        let (w, h) = *slide.level_dimensions().first().ok_or("no levels")?;
        let props = slide.properties();
        let num = |k: &str| props.get(k).and_then(|v| v.parse::<f64>().ok());
        let mpp = match (num("openslide.mpp-x"), num("openslide.mpp-y")) {
            (Some(x), Some(y)) => (x + y) / 2.0,
            _ => 0.0,
        };
        let frames = slide.frame_count().max(1);
        Ok::<_, String>((
            w as i32,
            h as i32,
            mpp,
            num("openslide.objective-power").unwrap_or(1.0),
            frames,
            slide.frame_kind(),
            slide.frame_labels(),
        ))
    })
    .await
    .map_err(|e| (-1, e.to_string()))
    .and_then(|r| r.map_err(|_| (-1, "This file type is unsupported!".to_string())));
    let (w, h, mpp, objective, frames, kind, labels) = match info {
        Ok(i) => i,
        Err(e) => {
            // not an image: do not leave the file behind
            let _ = tokio::fs::remove_file(path).await;
            return Err(e);
        }
    };
    let default_frame = match kind {
        FrameKind::ZStack | FrameKind::Volume => frames / 2,
        _ => 0,
    };
    let mut tx = s.pool.begin().await.map_err(|e| (-1, e.to_string()))?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO images_image (name, filename, time, checksum, image_set_id, height, width, mpp, \"objectivePower\", \
         image_type, channels, depth, frames, \"defaultFrame\", creator_id) \
         VALUES ($1, $2, now(), $3, $4, $5, $6, $7, $8, 0, 3, 1, $9, $10, $11) RETURNING id",
    )
    .bind(name)
    .bind(filename)
    .bind(&checksum)
    .bind(t.set_id)
    .bind(h)
    .bind(w)
    .bind(mpp)
    .bind(objective)
    .bind(frames as i32)
    .bind(default_frame as i32)
    .bind(p.user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| (-1, e.to_string()))?;
    if frames > 1 {
        let frame_type = if kind == FrameKind::TimeSeries { 1 } else { 0 };
        for f in 0..frames {
            let label: String = labels
                .get(f as usize)
                .map(|l| l.chars().take(160).collect())
                .unwrap_or_default();
            sqlx::query(
                "INSERT INTO images_framedescription (frame_type, description, frame_id, \"Image_id\", file_path) VALUES ($1, $2, $3, $4, $5)",
            )
            .bind(frame_type)
            .bind(label)
            .bind(f as i32)
            .bind(id)
            .bind(filename)
            .execute(&mut *tx)
            .await
            .map_err(|e| (-1, e.to_string()))?;
        }
    }
    tx.commit().await.map_err(|e| (-1, e.to_string()))?;
    Ok(("image", id))
}
