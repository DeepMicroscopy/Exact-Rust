//! Moving an image (rows and files) to another image set: `POST /api/v2/images/{id}/move {"image_set": id}` and the legacy
//! `POST /images/api/image/move/{image}/{set}/`; `GET /images/api/image/move-targets/` lists the sets the user can move to.
//! Port of `exact/images/move.py`, with its checks and messages.
//!
//! The files that belong to the image (original, converted file, thumbnails, the folder of z-stacks/frames and MRXS data)
//! are moved first, the database row after; if anything fails the files go back and nothing has changed. Copies of the
//! image in other sets that are symbolic links to the moved files are re-pointed.

use crate::{
    auth::{authenticate, require_user, AuthKind, Principal},
    compat::{
        engine::db_err,
        perms::{perms, set_row},
    },
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;
use std::path::{Path as FsPath, PathBuf};

pub fn legacy_routes() -> Router<AppState> {
    Router::new()
        .route("/images/api/image/move/{image}/{set}/", post(legacy_move))
        .route("/images/api/image/move-targets/", get(targets))
}

pub fn v2_routes() -> Router<AppState> {
    Router::new().route("/api/v2/images/{id}/move", post(v2_move))
}

struct Fail(StatusCode, String);

impl From<Fail> for ApiError {
    fn from(f: Fail) -> Self {
        ApiError::detail(f.0, f.1)
    }
}

struct Img {
    id: i64,
    set_id: i64,
    name: String,
    filename: String,
    depth: i32,
    frames: i32,
    image_type: i32,
}

struct SetInfo {
    id: i64,
    team: Option<i64>,
    path: String,
    locked: bool,
}

async fn set_info(s: &AppState, id: i64) -> ApiResult<Option<SetInfo>> {
    let r = sqlx::query("SELECT id, team_id, path, image_lock FROM images_imageset WHERE id = $1")
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(r.map(|r| SetInfo {
        id: r.get(0),
        team: r.get(1),
        path: r.get::<Option<String>, _>(2).unwrap_or_default(),
        locked: r.get(3),
    }))
}

async fn is_member(s: &AppState, p: &Principal, team: Option<i64>) -> ApiResult<bool> {
    let Some(team) = team else { return Ok(false) };
    if let AuthKind::Token(scope) = &p.kind {
        if scope.team_ids.as_ref().is_some_and(|t| !t.contains(&team)) {
            return Ok(false);
        }
    }
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users_teammembership WHERE team_id = $1 AND user_id = $2)",
    )
    .bind(team)
    .bind(p.user.id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)
}

fn stem(name: &str) -> String {
    FsPath::new(name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn exists(p: &FsPath) -> bool {
    std::fs::symlink_metadata(p).is_ok()
}

/// Names (relative to the folder of the set) of the files and folders that belong to the image that exist on disk.
fn associated(root: &FsPath, img: &Img) -> Vec<String> {
    let mut candidates = vec![img.name.clone(), img.filename.clone()];
    for n in [&img.name, &img.filename] {
        candidates.push(format!("{}_thumbnail.png", stem(n)));
    }
    for n in [&img.name, &img.filename] {
        let st = stem(n);
        if root.join(&st).is_dir()
            && (img.depth > 1 || img.frames > 1 || n.to_lowercase().ends_with(".mrxs"))
        {
            candidates.push(st);
        }
    }
    let mut out: Vec<String> = vec![];
    for c in candidates {
        if !c.is_empty() && !out.contains(&c) && exists(&root.join(&c)) {
            out.push(c);
        }
    }
    out
}

fn safe(name: &str) -> bool {
    !name.contains("..") && !name.starts_with('/')
}

async fn load_image(s: &AppState, id: i64) -> ApiResult<Option<Img>> {
    let r = sqlx::query(
        "SELECT id, image_set_id, name, filename, depth, frames, image_type FROM images_image WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(r.map(|r| Img {
        id: r.get(0),
        set_id: r.get(1),
        name: r.get(2),
        filename: r.get(3),
        depth: r.get(4),
        frames: r.get(5),
        image_type: r.get(6),
    }))
}

/// All checks of `check_move_allowed`; returns the files to move.
async fn check(
    s: &AppState,
    p: &Principal,
    img: &Img,
    source: &SetInfo,
    target: &SetInfo,
) -> Result<Vec<String>, Fail> {
    let conflict = |m: &str| Fail(StatusCode::CONFLICT, m.to_string());
    if source.id == target.id {
        return Err(Fail(
            StatusCode::BAD_REQUEST,
            "The image is already in this image set.".into(),
        ));
    }
    if img.image_type == 1 {
        return Err(Fail(
            StatusCode::BAD_REQUEST,
            "Server generated images can not be moved.".into(),
        ));
    }
    let fail = |e: ApiError| Fail(e.status, e.body.to_string());
    let src_perm = match set_row(s, source.id).await.map_err(fail)? {
        Some(r) => perms(s, p, &r).await.map_err(fail)?,
        None => Default::default(),
    };
    if !src_perm.delete_images || source.locked {
        return Err(Fail(
            StatusCode::FORBIDDEN,
            "You are not allowed to remove images from the source image set.".into(),
        ));
    }
    let tgt_perm = match set_row(s, target.id).await.map_err(fail)? {
        Some(r) => perms(s, p, &r).await.map_err(fail)?,
        None => Default::default(),
    };
    if !tgt_perm.edit_set || target.locked {
        return Err(Fail(
            StatusCode::FORBIDDEN,
            "You are not allowed to add images to the target image set.".into(),
        ));
    }
    let clash: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM images_image WHERE image_set_id = $1 AND (name = $2 OR filename = $3))",
    )
    .bind(target.id)
    .bind(&img.name)
    .bind(&img.filename)
    .fetch_one(&s.pool)
    .await
    .map_err(|e| Fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if clash {
        return Err(conflict(
            "The target image set already contains an image with this name.",
        ));
    }
    // annotations keep their type: the target has to offer every type that is used (by non-deleted annotations)
    let missing: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT t.name FROM annotations_annotationtype t JOIN annotations_annotation a ON a.annotation_type_id = t.id \
         WHERE a.image_id = $1 AND NOT a.deleted AND (t.product_id IS NULL OR t.product_id NOT IN \
           (SELECT product_id FROM administration_product_imagesets WHERE imageset_id = $2)) ORDER BY t.name",
    )
    .bind(img.id)
    .bind(target.id)
    .fetch_all(&s.pool)
    .await
    .map_err(|e| Fail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !missing.is_empty() {
        return Err(conflict(&format!(
            "The target image set does not have the annotation types used in this image: {}",
            missing.join(", ")
        )));
    }
    let (src_root, dst_root) = (
        s.slides.root().join(&source.path),
        s.slides.root().join(&target.path),
    );
    let names = associated(&src_root, img);
    for n in &names {
        if !safe(n) {
            return Err(conflict("The image has an unsafe file name."));
        }
        if exists(&dst_root.join(n)) {
            return Err(conflict(&format!(
                "A file named \"{n}\" already exists in the target image set."
            )));
        }
    }
    Ok(names)
}

/// Symbolic links (copies of the image in other sets) that point at the files that are moved: `(link, file name)`.
async fn linked_copies(
    s: &AppState,
    img: &Img,
    src_root: &FsPath,
    names: &[String],
) -> ApiResult<Vec<(PathBuf, String)>> {
    let real: Vec<PathBuf> = names
        .iter()
        .filter_map(|n| std::fs::canonicalize(src_root.join(n)).ok())
        .collect();
    let others = sqlx::query(
        "SELECT i.filename, st.path FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE (i.filename = $1 OR i.name = $2) AND i.id <> $3",
    )
    .bind(&img.filename)
    .bind(&img.name)
    .bind(img.id)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let mut out = vec![];
    for r in others {
        let (filename, path): (String, Option<String>) = (r.get(0), r.get(1));
        if !safe(&filename) {
            continue;
        }
        let link = s
            .slides
            .root()
            .join(path.unwrap_or_default())
            .join(filename);
        let is_link = std::fs::symlink_metadata(&link)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if is_link {
            if let Ok(real_target) = std::fs::canonicalize(&link) {
                if real.contains(&real_target) {
                    let name = real_target
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    out.push((link, name));
                }
            }
        }
    }
    Ok(out)
}

async fn do_move(s: &AppState, p: &Principal, image_id: i64, set_id: i64) -> Result<(), Fail> {
    let internal = |m: String| Fail(StatusCode::INTERNAL_SERVER_ERROR, m);
    let not_found = || Fail(StatusCode::NOT_FOUND, "Not found.".into());
    let img = load_image(s, image_id)
        .await
        .map_err(|e| internal(e.body.to_string()))?
        .ok_or_else(not_found)?;
    let target = set_info(s, set_id)
        .await
        .map_err(|e| internal(e.body.to_string()))?
        .ok_or_else(not_found)?;
    let source = set_info(s, img.set_id)
        .await
        .map_err(|e| internal(e.body.to_string()))?
        .ok_or_else(not_found)?;
    // users only see the sets of their teams
    for t in [source.team, target.team] {
        if !is_member(s, p, t)
            .await
            .map_err(|e| internal(e.body.to_string()))?
        {
            return Err(Fail(StatusCode::NOT_FOUND, "Image set not found.".into()));
        }
    }
    let names = check(s, p, &img, &source, &target).await?;
    let (src_root, dst_root) = (
        s.slides.root().join(&source.path),
        s.slides.root().join(&target.path),
    );
    let links = linked_copies(s, &img, &src_root, &names)
        .await
        .map_err(|e| internal(e.body.to_string()))?;

    let mut moved: Vec<(PathBuf, PathBuf)> = vec![];
    let result: Result<(), String> = async {
        tokio::fs::create_dir_all(&dst_root)
            .await
            .map_err(|e| e.to_string())?;
        for n in &names {
            let (from, to) = (src_root.join(n), dst_root.join(n));
            tokio::fs::rename(&from, &to)
                .await
                .map_err(|e| format!("{n}: {e}"))?;
            moved.push((from, to));
        }
        let mut tx = s.pool.begin().await.map_err(|e| e.to_string())?;
        sqlx::query("UPDATE images_image SET image_set_id = $2 WHERE id = $1")
            .bind(img.id)
            .bind(target.id)
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        sqlx::query("UPDATE images_imageset SET zip_state = 0 WHERE id = ANY($1)")
            .bind(vec![source.id, target.id])
            .execute(&mut *tx)
            .await
            .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = result {
        for (from, to) in moved.iter().rev() {
            let _ = tokio::fs::rename(to, from).await;
        }
        tracing::error!("moving image {image_id} to image set {set_id} failed: {e}");
        return Err(internal(
            "Moving the image failed. Nothing was changed.".into(),
        ));
    }
    #[cfg(unix)]
    for (link, name) in links {
        let abs = std::fs::canonicalize(&dst_root)
            .unwrap_or(dst_root.clone())
            .join(name);
        let _ = std::fs::remove_file(&link);
        if let Err(e) = std::os::unix::fs::symlink(&abs, &link) {
            tracing::error!(
                "could not update link {} after moving image {image_id}: {e}",
                link.display()
            );
        }
    }
    #[cfg(not(unix))]
    let _ = links;
    Ok(())
}

async fn legacy_move(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((image, set)): Path<(i64, i64)>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    do_move(&s, &p, image, set).await?;
    Ok(Json(json!({"id": image, "image_set": set})).into_response())
}

async fn v2_move(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(image): Path<i64>,
    body: axum::body::Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let set = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("image_set").and_then(Value::as_i64))
        .ok_or_else(|| {
            ApiError {
                status: StatusCode::BAD_REQUEST,
                body: json!({"detail": "Validation failed.", "errors": {"image_set": ["This field is required."]}}),
            }
        })?;
    do_move(&s, &p, image, set).await?;
    Ok(Json(json!({"id": image, "image_set": set})).into_response())
}

/// Image sets of the user's teams that are not locked: `[{id, name, team}]`, by team name and set name.
async fn targets(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let v = p.viewer();
    let rows = sqlx::query(
        "SELECT st.id, st.name, t.name FROM images_imageset st JOIN users_team t ON t.id = st.team_id \
         WHERE NOT st.image_lock AND st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $1 \
           AND ($2::bigint[] IS NULL OR team_id = ANY($2))) ORDER BY t.name, st.name",
    )
    .bind(v.id)
    .bind(v.token_teams)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| json!({"id": r.get::<i64, _>(0), "name": r.get::<String, _>(1), "team": r.get::<String, _>(2)}))
        .collect();
    Ok(Json(out).into_response())
}
