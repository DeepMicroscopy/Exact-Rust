//! `/api/v2` image set and image writes, plus the legacy `images/api/imageset/create/` used by exact-sync.
//!
//! - `POST /api/v2/image-sets`: needs team membership (Django: `create_set`); creates the folder `<db>_<team>_<id>`.
//! - `PATCH /api/v2/image-sets/{id}`: needs `edit_set`.
//! - `DELETE /api/v2/image-sets/{id}`: needs `delete_set`; removes everything that depends on the set and its folder.
//! - `DELETE /api/v2/images/{id}`: needs `delete_images`, set not locked; removes the files too.
//! - Auxiliary files (documents uploaded into a set): `GET /api/v2/image-sets/{id}/auxiliary-files`,
//!   `GET /api/v2/auxiliary-files/{id}/download` (read), `DELETE /api/v2/auxiliary-files/{id}` (`delete_images`).

use crate::{
    auth::{authenticate, require_user, AuthKind, Principal},
    cascade,
    compat::{
        engine::{self, db_err, snake_keys, Ctx},
        legacy::serialize_imagesets,
        perms::{perms, set_row},
        specs,
    },
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use serde_json::{json, Map, Value};
use sqlx::Row;

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/image-sets/{id}/settings",
            axum::routing::get(settings_h),
        )
        .route(
            "/api/v2/image-sets/{id}/auxiliary-files",
            axum::routing::get(aux_list_h),
        )
        .route(
            "/api/v2/image-sets/{id}/annotation-counts",
            axum::routing::get(annotation_counts_h),
        )
        .route(
            "/api/v2/auxiliary-files/{id}/download",
            axum::routing::get(aux_download_h),
        )
        .route(
            "/api/v2/auxiliary-files/{id}",
            axum::routing::delete(aux_delete_h),
        )
}

/// `GET /api/v2/image-sets/{id}/annotation-counts`: every annotation type of the set (those of its products, and any other that has
/// annotations in it) with the number of annotations and of images that have one; for the overview's side list.
async fn annotation_counts_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(set): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let row = set_row(&s, set)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if !perms(&s, &p, &row).await?.read {
        return Err(ApiError::not_found("Not found."));
    }
    let rows = sqlx::query(
        "SELECT t.id, t.name, t.color_code, COALESCE(c.n, 0), COALESCE(c.images, 0) FROM annotations_annotationtype t \
         LEFT JOIN (SELECT a.annotation_type_id, count(*) AS n, count(DISTINCT a.image_id) AS images FROM annotations_annotation a \
                    JOIN images_image i ON i.id = a.image_id WHERE i.image_set_id = $1 AND NOT a.deleted GROUP BY a.annotation_type_id) c \
                ON c.annotation_type_id = t.id \
         WHERE c.n IS NOT NULL OR t.product_id IN (SELECT product_id FROM administration_product_imagesets WHERE imageset_id = $1) \
         ORDER BY t.name, t.id",
    )
    .bind(set)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({"id": r.get::<i64, _>(0), "name": r.get::<String, _>(1), "color": r.get::<String, _>(2),
                   "count": r.get::<i64, _>(3), "images": r.get::<i64, _>(4)})
        })
        .collect();
    Ok(Json(json!({"items": items})).into_response())
}

async fn aux_list_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(set): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let row = set_row(&s, set)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let pm = perms(&s, &p, &row).await?;
    if !pm.read {
        return Err(ApiError::not_found("Not found."));
    }
    let rows = sqlx::query(
        "SELECT a.id, a.name, a.filesize, a.time, a.description, u.username FROM images_auxiliaryfile a \
         LEFT JOIN users_user u ON u.id = a.creator_id WHERE a.image_set_id = $1 ORDER BY a.name, a.id",
    )
    .bind(set)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({"id": r.get::<i64, _>(0), "name": r.get::<String, _>(1), "filesize": r.get::<i32, _>(2),
                   "time": r.get::<chrono::DateTime<chrono::Utc>, _>(3), "description": r.get::<Option<String>, _>(4),
                   "creator": r.get::<Option<String>, _>(5)})
        })
        .collect();
    Ok(Json(json!({"files": out, "can_delete": pm.delete_images})).into_response())
}

/// The set of an auxiliary file, its folder and name, once the caller may read the set.
async fn aux_target(
    s: &AppState,
    p: &Principal,
    id: i64,
) -> ApiResult<(i64, String, crate::compat::perms::Perms)> {
    let r = sqlx::query(
        "SELECT a.image_set_id, a.name, st.path FROM images_auxiliaryfile a JOIN images_imageset st ON st.id = a.image_set_id WHERE a.id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("Not found."))?;
    let set: i64 = r.get(0);
    let (name, dir): (String, Option<String>) = (r.get(1), r.get(2));
    let row = set_row(s, set)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let pm = perms(s, p, &row).await?;
    if !pm.read {
        return Err(ApiError::not_found("Not found."));
    }
    if name.contains("..") || name.starts_with('/') {
        return Err(ApiError::not_found("Not found."));
    }
    let path = s
        .slides
        .root()
        .join(dir.unwrap_or_default())
        .join(&name)
        .to_string_lossy()
        .to_string();
    Ok((set, path, pm))
}

async fn aux_download_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let (_, path, _) = aux_target(&s, &p, id).await?;
    let f = tokio::fs::File::open(&path)
        .await
        .map_err(|_| ApiError::not_found("The file is missing on the server."))?;
    let len = f.metadata().await.map(|m| m.len()).unwrap_or(0);
    let name = std::path::Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().replace(['"', '\r', '\n'], "_"))
        .unwrap_or_default();
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

async fn aux_delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let (_, path, pm) = aux_target(&s, &p, id).await?;
    if !pm.delete_images {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for deleting files in this image set missing.",
        ));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    cascade::delete_rows(&mut tx, "images_auxiliaryfile", &[id]).await?;
    tx.commit().await.map_err(db_err)?;
    let _ = tokio::fs::remove_file(path).await;
    Ok(StatusCode::NO_CONTENT.into_response())
}

pub fn legacy_routes() -> Router<AppState> {
    Router::new().route("/images/api/imageset/create/", post(legacy_create))
}

fn field_err(field: &str, msg: &str) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({"detail": "Validation failed.", "errors": {field: [msg]}}),
    }
}

fn object(body: &[u8]) -> ApiResult<Map<String, Value>> {
    if body.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Expected a JSON object.",
        )),
        Err(e) => Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("JSON parse error - {e}"),
        )),
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(t) => matches!(t.as_str(), "true" | "True" | "1"),
        _ => false,
    }
}

/// An id given as `5`, `"5"` or `{"id": 5}` (exact-sync sends the latter).
fn id_of(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64(),
        Value::String(t) => t.trim().parse().ok(),
        Value::Object(m) => m.get("id").and_then(id_of),
        _ => None,
    }
}

fn text(d: &Map<String, Value>, key: &str, max: usize) -> ApiResult<Option<Option<String>>> {
    match d.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(t)) if t.chars().count() <= max => Ok(Some(Some(t.clone()))),
        Some(Value::String(_)) => Err(field_err(key, &format!("At most {max} characters."))),
        Some(_) => Err(field_err(key, "Expected text.")),
    }
}

async fn team_may_create(s: &AppState, p: &Principal, team: i64) -> ApiResult<bool> {
    if let AuthKind::Token(scope) = &p.kind {
        if scope.team_ids.as_ref().is_some_and(|t| !t.contains(&team)) {
            return Ok(false);
        }
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users_teammembership WHERE team_id = $1 AND user_id = $2",
    )
    .bind(team)
    .bind(p.user.id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(n > 0)
}

struct NewSet {
    name: String,
    team: i64,
    location: Option<String>,
    description: Option<String>,
    public: bool,
    public_collaboration: bool,
    image_lock: bool,
    priority: i32,
    main_annotation_type: Option<i64>,
    collaboration_type: i32,
    products: Vec<i64>,
}

fn parse_new(d: &Map<String, Value>) -> ApiResult<NewSet> {
    let name = match d.get("name") {
        Some(Value::String(t)) if !t.trim().is_empty() && t.chars().count() <= 256 => t.clone(),
        Some(_) => {
            return Err(field_err(
                "name",
                "A name of 1 to 256 characters is required.",
            ))
        }
        None => return Err(field_err("name", "This field is required.")),
    };
    let team = d
        .get("team")
        .and_then(id_of)
        .ok_or_else(|| field_err("team", "This field is required."))?;
    let collaboration_type = match d.get("collaboration_type") {
        None => 0,
        Some(v) => match id_of(v) {
            Some(c @ (0 | 1)) => c as i32,
            _ => {
                return Err(field_err(
                    "collaboration_type",
                    "Must be 0 (collaborative) or 1 (competitive).",
                ))
            }
        },
    };
    Ok(NewSet {
        name,
        team,
        location: text(d, "location", 256)?.flatten(),
        description: text(d, "description", 1000)?.flatten(),
        public: d.get("public").is_some_and(truthy),
        public_collaboration: d.get("public_collaboration").is_some_and(truthy),
        image_lock: d.get("image_lock").is_some_and(truthy),
        priority: d.get("priority").and_then(id_of).unwrap_or(0) as i32,
        main_annotation_type: d.get("main_annotation_type").and_then(id_of),
        collaboration_type,
        products: d
            .get("products")
            .or_else(|| d.get("product_set")) // the name /api/v1 uses
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(id_of).collect())
            .unwrap_or_default(),
    })
}

/// Creates the set and its folder; returns the id.
async fn create_set(s: &AppState, p: &Principal, n: NewSet) -> ApiResult<i64> {
    let team_exists: bool =
        sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users_team WHERE id = $1)")
            .bind(n.team)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
    if !team_exists {
        return Err(field_err("team", "Team does not exist."));
    }
    if !team_may_create(s, p, n.team).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "You do not have permission to create image sets in this team.",
        ));
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM images_imageset WHERE team_id = $1 AND name = $2)",
    )
    .bind(n.team)
    .bind(&n.name)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if taken {
        return Err(field_err(
            "name",
            "An image set with this name exists in the team.",
        ));
    }
    if let Some(t) = n.main_annotation_type {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM annotations_annotationtype WHERE id = $1)",
        )
        .bind(t)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
        if !ok {
            return Err(field_err(
                "main_annotation_type",
                "Annotation type does not exist.",
            ));
        }
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO images_imageset (name, location, description, time, public, image_lock, team_id, public_collaboration, \
         main_annotation_type_id, priority, creator_id, zip_state, collaboration_type) \
         VALUES ($1, $2, $3, now(), $4, $5, $6, $7, $8, $9, $10, 0, $11) RETURNING id",
    )
    .bind(&n.name)
    .bind(&n.location)
    .bind(&n.description)
    .bind(n.public)
    .bind(n.image_lock)
    .bind(n.team)
    .bind(n.public_collaboration)
    .bind(n.main_annotation_type)
    .bind(n.priority)
    .bind(p.user.id)
    .bind(n.collaboration_type)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    let folder = format!("{}_{}_{}", s.db_name, n.team, id);
    sqlx::query("UPDATE images_imageset SET path = $2 WHERE id = $1")
        .bind(id)
        .bind(&folder)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    for product in &n.products {
        sqlx::query(
            "INSERT INTO administration_product_imagesets (product_id, imageset_id) \
             SELECT id, $2 FROM administration_product WHERE id = $1",
        )
        .bind(product)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    let dir = s.slides.root().join(&folder);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        ApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot create {folder}: {e}"),
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).await;
    }
    Ok(id)
}

async fn one(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &str,
    id: i64,
) -> ApiResult<Value> {
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string(),
        v2: true,
    };
    engine::serialize_ids(&ctx, specs::by_name(spec), &[id])
        .await?
        .into_iter()
        .next()
        .map(snake_keys)
        .ok_or_else(|| ApiError::not_found("Not found."))
}

pub async fn create_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let n = parse_new(&object(&body)?)?;
    let id = create_set(&s, &p, n).await?;
    Ok((
        StatusCode::CREATED,
        Json(one(&s, &p, &headers, "ImageSet", id).await?),
    )
        .into_response())
}

/// exact-sync: `{"name", "team": {"id"}, ..., "products": [{"id"}]}`; answers `serialize_imageset`.
async fn legacy_create(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let n = parse_new(&object(&body)?)?;
    let id = create_set(&s, &p, n).await?;
    let set = serialize_imagesets(&s, &[id])
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    Ok(Json(set).into_response())
}

/// `POST /api/v1/images/image_sets/`: as Django's `ImageSetViewSet.create`: the caller is the creator, the folder is made, the answer
/// is the v1 representation (201) and errors are DRF's `{"field": ["message"]}`. Needs `images.add_imageset` and membership of the team.
pub async fn v1_create(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    body: &[u8],
) -> ApiResult<Response> {
    let drf = |e: ApiError| match e.body.get("errors").cloned() {
        Some(errors) if e.status == StatusCode::BAD_REQUEST => ApiError {
            status: e.status,
            body: errors,
        },
        _ => e,
    };
    let n = parse_new(&object(body)?).map_err(drf)?;
    let id = create_set(s, p, n).await.map_err(drf)?;
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string(),
        v2: false,
    };
    let v = engine::serialize_ids(&ctx, specs::by_name("ImageSet"), &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    Ok((StatusCode::CREATED, Json(v)).into_response())
}

pub async fn patch_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PATCH).await?)?;
    let id: i64 = id.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let d = object(&body)?;
    let row = set_row(&s, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let pm = perms(&s, &p, &row).await?;
    if !pm.read {
        return Err(ApiError::not_found("Not found."));
    }
    if !pm.edit_set {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for editing this image set missing.",
        ));
    }
    let name = match d.get("name") {
        None => None,
        Some(Value::String(t)) if !t.trim().is_empty() && t.chars().count() <= 256 => {
            Some(t.clone())
        }
        Some(_) => {
            return Err(field_err(
                "name",
                "A name of 1 to 256 characters is required.",
            ))
        }
    };
    if let (Some(n), Some(team)) = (&name, row.team_id) {
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM images_imageset WHERE team_id = $1 AND name = $2 AND id <> $3)",
        )
        .bind(team)
        .bind(n)
        .bind(id)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
        if taken {
            return Err(field_err(
                "name",
                "An image set with this name exists in the team.",
            ));
        }
    }
    let location = text(&d, "location", 256)?;
    let description = text(&d, "description", 1000)?;
    let ctype = match d.get("collaboration_type") {
        None => None,
        Some(v) => match id_of(v) {
            Some(c @ (0 | 1)) => Some(c as i32),
            _ => {
                return Err(field_err(
                    "collaboration_type",
                    "Must be 0 (collaborative) or 1 (competitive).",
                ))
            }
        },
    };
    let main_type = d.get("main_annotation_type").map(id_of);
    if let Some(Some(t)) = main_type {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM annotations_annotationtype WHERE id = $1)",
        )
        .bind(t)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
        if !ok {
            return Err(field_err(
                "main_annotation_type",
                "Annotation type does not exist.",
            ));
        }
    }
    let flag = |k: &str| d.get(k).map(truthy);
    sqlx::query(
        "UPDATE images_imageset SET name = COALESCE($2, name), \
           location = CASE WHEN $3 THEN $4 ELSE location END, description = CASE WHEN $5 THEN $6 ELSE description END, \
           public = COALESCE($7, public), public_collaboration = COALESCE($8, public_collaboration), \
           image_lock = COALESCE($9, image_lock), priority = COALESCE($10, priority), \
           collaboration_type = COALESCE($11, collaboration_type), \
           main_annotation_type_id = CASE WHEN $12 THEN $13 ELSE main_annotation_type_id END WHERE id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(location.is_some())
    .bind(location.flatten())
    .bind(description.is_some())
    .bind(description.flatten())
    .bind(flag("public"))
    .bind(flag("public_collaboration"))
    .bind(flag("image_lock"))
    .bind(d.get("priority").and_then(id_of).map(|v| v as i32))
    .bind(ctype)
    .bind(main_type.is_some())
    .bind(main_type.flatten())
    .execute(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(one(&s, &p, &headers, "ImageSet", id).await?).into_response())
}

/// Removes a folder below the image root; never anything outside it.
async fn remove_dir(s: &AppState, rel: &str) {
    if rel.is_empty() || rel.contains("..") || rel.starts_with('/') {
        return;
    }
    let _ = tokio::fs::remove_dir_all(s.slides.root().join(rel)).await;
}

pub async fn delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let id: i64 = id.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let row = set_row(&s, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let pm = perms(&s, &p, &row).await?;
    if !pm.read {
        return Err(ApiError::not_found("Not found."));
    }
    if !pm.delete_set {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for deleting this image set missing.",
        ));
    }
    let path: Option<String> = sqlx::query_scalar("SELECT path FROM images_imageset WHERE id = $1")
        .bind(id)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    cascade::delete_rows(&mut tx, "images_imageset", &[id]).await?;
    tx.commit().await.map_err(db_err)?;
    if let Some(path) = path {
        remove_dir(&s, &path).await;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(serde::Deserialize)]
pub struct DeleteImageQuery {
    /// what happens to the segmentation files linked to the image: `unlink` (the default: they stay in the image set) or `delete`
    segmentations: Option<String>,
}

pub async fn delete_image_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    axum::extract::Query(q): axum::extract::Query<DeleteImageQuery>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let id: i64 = id.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let with_files = match q.segmentations.as_deref() {
        None | Some("unlink") => false,
        Some("delete") => true,
        Some(_) => {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "segmentations is \"unlink\" or \"delete\".",
            ))
        }
    };
    delete_image(&s, &p, id, with_files).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Deletes an image with its rows and files (the file the viewer reads and the uploaded original). The segmentation files linked
/// to it are unlinked, or with `with_segmentations` deleted too (rows and files).
pub async fn delete_image(
    s: &AppState,
    p: &Principal,
    id: i64,
    with_segmentations: bool,
) -> ApiResult<()> {
    let r = sqlx::query(
        "SELECT i.image_set_id, i.name, i.filename, s.path, s.image_lock FROM images_image i \
         JOIN images_imageset s ON s.id = i.image_set_id WHERE i.id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("Not found."))?;
    let set_id: i64 = r.get(0);
    let (name, filename): (String, String) = (r.get(1), r.get(2));
    let (path, locked): (Option<String>, bool) = (r.get(3), r.get(4));
    let row = set_row(s, set_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let pm = perms(s, p, &row).await?;
    if !pm.read {
        return Err(ApiError::not_found("Not found."));
    }
    if !pm.delete_images || locked {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for deleting images in this image set missing (or the set is locked).",
        ));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let linked: Vec<(i64, String)> =
        sqlx::query_as("SELECT id, filename FROM exact_rust_linked_volume WHERE image_id = $1")
            .bind(id)
            .fetch_all(&mut *tx)
            .await
            .map_err(db_err)?;
    if with_segmentations {
        sqlx::query("DELETE FROM exact_rust_linked_volume WHERE image_id = $1")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    cascade::delete_rows(&mut tx, "images_image", &[id]).await?;
    tx.commit().await.map_err(db_err)?;
    for (lid, file) in &linked {
        crate::v2::linked::forget(*lid);
        if with_segmentations && !file.contains("..") && !file.starts_with('/') {
            if let Some(path) = &path {
                let _ = tokio::fs::remove_file(s.slides.root().join(path).join(file)).await;
            }
        }
    }
    if let Some(path) = path {
        for f in [filename, name] {
            let still_used: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM images_image WHERE image_set_id = $1 AND (name = $2 OR filename = $2))",
            )
            .bind(set_id)
            .bind(&f)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
            if !still_used && !f.contains("..") && !f.starts_with('/') {
                let _ = tokio::fs::remove_file(s.slides.root().join(&path).join(&f)).await;
            }
        }
    }
    Ok(())
}

/// `GET /api/v2/image-sets/{id}/settings`: what the image set page needs beyond the resource representation: the flags (public,
/// locked, ...), the number of images, and what the caller may do with the set.
async fn settings_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let row = set_row(&s, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let pm = perms(&s, &p, &row).await?;
    if !pm.read {
        return Err(ApiError::not_found("Not found."));
    }
    let r = sqlx::query(
        "SELECT st.name, st.description, st.location, st.public, st.public_collaboration, st.image_lock, st.priority, st.collaboration_type, \
         st.main_annotation_type_id, st.team_id, t.name, st.time, st.creator_id, \
         (SELECT count(*) FROM images_image WHERE image_set_id = st.id), (SELECT count(*) FROM images_auxiliaryfile WHERE image_set_id = st.id) \
         FROM images_imageset st LEFT JOIN users_team t ON t.id = st.team_id WHERE st.id = $1",
    )
    .bind(id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(json!({
        "id": id,
        "name": r.get::<String, _>(0),
        "description": r.get::<Option<String>, _>(1),
        "location": r.get::<Option<String>, _>(2),
        "public": r.get::<bool, _>(3),
        "public_collaboration": r.get::<bool, _>(4),
        "image_lock": r.get::<bool, _>(5),
        "priority": r.get::<i32, _>(6),
        "collaboration_type": r.get::<i32, _>(7),
        "main_annotation_type": r.get::<Option<i64>, _>(8),
        "team": r.get::<Option<i64>, _>(9),
        "team_name": r.get::<Option<String>, _>(10),
        "time": r.get::<chrono::DateTime<chrono::Utc>, _>(11).to_rfc3339_opts(chrono::SecondsFormat::Micros, true),
        "creator": r.get::<Option<i64>, _>(12),
        "image_count": r.get::<i64, _>(13),
        "auxiliary_file_count": r.get::<i64, _>(14),
        "permissions": {
            "read": pm.read, "annotate": pm.annotate, "edit_set": pm.edit_set, "delete_set": pm.delete_set,
            "delete_images": pm.delete_images, "create_export": pm.create_export,
        },
    }))
    .into_response())
}
