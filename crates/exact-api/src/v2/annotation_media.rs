//! Media files of annotations (images, video, audio attached to an annotation).
//!
//! - legacy `POST /annotations/api/annotation/mediafile/upload/{annotation}/{type}/` (exact-sync): multipart, any number
//!   of files; a file whose name the annotation has already is skipped, as in Django.
//! - `POST /api/v2/annotations/{id}/media-files`: multipart, optional field `media_file_type` (1 undefined, 2 image,
//!   3 video, 4 audio; default 2); answers 201 with the created media files.
//! - `DELETE /api/v2/annotation-media-files/{id}`: removes the row and the file.
//!
//! Both need `edit_annotation` in the image set of the annotation. Files are stored below
//! `MEDIA_ROOT/annotation/<year>/<month>/<day>/<hour>/<annotation id>/`.

use crate::{
    auth::{authenticate, require_user, Principal},
    compat::{
        engine::{self, db_err, snake_keys, Ctx},
        specs,
        writes::{annotation_row, set_perms},
    },
    error::{ApiError, ApiResult},
    media::{self, Upload},
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
use chrono::Timelike;
use serde_json::Value;

pub fn legacy_routes() -> Router<AppState> {
    Router::new().route(
        "/annotations/api/annotation/mediafile/upload/{annotation}/{kind}/",
        post(legacy_upload),
    )
}

pub fn v2_routes() -> Router<AppState> {
    Router::new().route("/api/v2/annotations/{id}/media-files", post(v2_upload))
}

async fn editable(s: &AppState, p: &Principal, annotation: i64) -> ApiResult<()> {
    let row = annotation_row(s, annotation)
        .await?
        .ok_or_else(|| ApiError::not_found("No Annotation matches the given query."))?;
    let pm = set_perms(s, p, row.set_id).await?;
    if !pm.read {
        return Err(ApiError::not_found(
            "No Annotation matches the given query.",
        ));
    }
    if !pm.edit_annotation {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for editing annotations in this image set missing.",
        ));
    }
    Ok(())
}

/// Stores the files and creates the rows; returns the ids of the new media files.
async fn attach(
    s: &AppState,
    annotation: i64,
    kind: i32,
    files: Vec<Upload>,
) -> ApiResult<Vec<i64>> {
    let now = chrono::Local::now();
    let dir = format!(
        "annotation/{}/{}/{}/{}/{annotation}",
        now.format("%Y"),
        now.format("%-m"),
        now.format("%-d"),
        now.hour()
    );
    let mut ids = vec![];
    for f in files {
        let name = f.filename.chars().take(255).collect::<String>();
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM annotations_annotationmediafile WHERE name = $1 AND annotation_id = $2)",
        )
        .bind(&name)
        .bind(annotation)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
        if exists {
            continue;
        }
        let rel = media::store(s, &dir, &f.filename, &f.data).await?;
        let id: Result<i64, _> = sqlx::query_scalar(
            "INSERT INTO annotations_annotationmediafile (name, file, media_file_type, annotation_id) VALUES ($1, $2, $3, $4) RETURNING id::bigint",
        )
        .bind(&name)
        .bind(&rel)
        .bind(kind)
        .bind(annotation)
        .fetch_one(&s.pool)
        .await;
        match id {
            Ok(id) => ids.push(id),
            Err(e) => {
                media::remove(s, &rel).await;
                return Err(db_err(e));
            }
        }
    }
    Ok(ids)
}

async fn serialized(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    ids: &[i64],
    v2: bool,
) -> ApiResult<Vec<Value>> {
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string(),
        v2,
    };
    let items = engine::serialize_ids(&ctx, specs::by_name("AnnotationMediaFile"), ids).await?;
    Ok(if v2 {
        items.into_iter().map(snake_keys).collect()
    } else {
        items
    })
}

async fn legacy_upload(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((annotation, kind)): Path<(i64, i64)>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    editable(&s, &p, annotation).await?;
    let payload = media::parse_body(&headers, &body).await?;
    if payload.files.is_empty() {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Must have files attached!",
        ));
    }
    let ids = attach(&s, annotation, kind as i32, payload.files).await?;
    Ok(Json(serialized(&s, &p, &headers, &ids, false).await?).into_response())
}

async fn v2_upload(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(annotation): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    editable(&s, &p, annotation).await?;
    let payload = media::parse_body(&headers, &body).await?;
    if payload.files.is_empty() {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Attach at least one file.",
        ));
    }
    let kind = match payload
        .fields
        .get("media_file_type")
        .and_then(Value::as_str)
    {
        None => 2,
        Some(t) => match t.parse::<i32>() {
            Ok(k @ 1..=4) => k,
            _ => {
                return Err(ApiError::detail(
                    StatusCode::BAD_REQUEST,
                    "media_file_type must be 1, 2, 3 or 4.",
                ))
            }
        },
    };
    let ids = attach(&s, annotation, kind, payload.files).await?;
    Ok((
        StatusCode::CREATED,
        Json(serialized(&s, &p, &headers, &ids, true).await?),
    )
        .into_response())
}

pub async fn delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let id: i64 = id.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let row: Option<(i64, Option<String>)> = sqlx::query_as(
        "SELECT annotation_id, file FROM annotations_annotationmediafile WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    let (annotation, file) = row.ok_or_else(|| ApiError::not_found("Not found."))?;
    editable(&s, &p, annotation).await?;
    sqlx::query("DELETE FROM annotations_annotationmediafile WHERE id = $1")
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    if let Some(f) = file {
        media::remove(&s, &f).await;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
