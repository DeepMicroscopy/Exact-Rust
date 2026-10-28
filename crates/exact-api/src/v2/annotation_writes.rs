//! `/api/v2` annotation writes, the API of the new viewer. Authority is the image set permission (`annotate`,
//! `edit_annotation`, `delete_annotation`, `verify`); the Django model permissions are not consulted.
//!
//! - `POST /api/v2/annotations`: create; an existing `unique_identifier` on the image answers 200 with that annotation
//!   (a client can retry safely); a global annotation (vector type 7) is created once per image/type (and user).
//! - `PATCH /api/v2/annotations/{id}`: partial update; `expected_last_edit_time` makes it conditional (409 with the
//!   current annotation when someone else edited meanwhile).
//! - `DELETE /api/v2/annotations/{id}`: soft delete (undo with `PATCH {"deleted": false}`), `?hard=true` removes the row.
//! - `POST /api/v2/annotations/{id}/verify`: `{"verified": true|false}`.
//!
//! Vectors are validated like the legacy endpoints do (`AnnotationType.validate_vector`).

use crate::{
    auth::{authenticate, require_user, Principal},
    compat::{
        engine::{self, db_err, snake_keys, Ctx},
        specs, vector,
        writes::{
            annotation_row, delete_annotations, image_row, insert_annotation, set_perms, type_row,
            verify, NewAnnotation,
        },
    },
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v2/annotations/{id}/verify", post(verify_h))
}

pub async fn create_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    let image =
        int_field(&d, "image")?.ok_or_else(|| field_err("image", "This field is required."))?;
    let type_id = int_field(&d, "annotation_type")?
        .ok_or_else(|| field_err("annotation_type", "This field is required."))?;
    let mut vec_value = d.get("vector").cloned().ok_or_else(|| {
        field_err(
            "vector",
            "This field is required (null means: not in image).",
        )
    })?;
    let img = image_row(&s, image)
        .await?
        .ok_or_else(|| field_err("image", "Image does not exist."))?;
    let atype = type_row(&s, type_id)
        .await?
        .ok_or_else(|| field_err("annotation_type", "Annotation type does not exist."))?;
    let perms = set_perms(&s, &p, img.set_id).await?;
    if !perms.read {
        return Err(field_err("image", "Image does not exist."));
    }
    if !perms.annotate {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for annotating in this image set missing.",
        ));
    }
    if !vector::validate(atype.vector_type, atype.node_count, &mut vec_value) {
        return Err(field_err(
            "vector",
            "The vector is not valid for this annotation type.",
        ));
    }
    let uid = match d.get("unique_identifier") {
        None | Some(Value::Null) => None,
        Some(v) => Some(
            v.as_str()
                .and_then(|t| uuid::Uuid::parse_str(t).ok())
                .ok_or_else(|| field_err("unique_identifier", "Must be a valid UUID."))?,
        ),
    };
    // a global annotation exists once per image and type (and user in competitive sets): it is switched on again, not duplicated
    let existing: Option<(i64, bool)> = if atype.vector_type == vector::GLOBAL {
        let competitive = sqlx::query_scalar::<_, i32>(
            "SELECT collaboration_type FROM images_imageset WHERE id = $1",
        )
        .bind(img.set_id)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?
            != 0;
        sqlx::query_as("SELECT id, deleted FROM annotations_annotation WHERE image_id = $1 AND annotation_type_id = $2 AND (NOT $3 OR user_id = $4) ORDER BY deleted, id LIMIT 1")
            .bind(image)
            .bind(type_id)
            .bind(competitive)
            .bind(p.user.id)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?
    } else if let Some(u) = uid {
        sqlx::query_as("SELECT id, false FROM annotations_annotation WHERE image_id = $1 AND unique_identifier = $2 ORDER BY id LIMIT 1")
            .bind(image)
            .bind(u)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?
    } else {
        None
    };
    if let Some((id, deleted)) = existing {
        if deleted {
            sqlx::query("UPDATE annotations_annotation SET deleted = false, last_editor_id = $2, last_edit_time = now() WHERE id = $1")
                .bind(id)
                .bind(p.user.id)
                .execute(&s.pool)
                .await
                .map_err(db_err)?;
        }
        return Ok((StatusCode::OK, Json(one(&s, &p, &headers, id).await?)).into_response());
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let id = insert_annotation(
        &mut tx,
        &NewAnnotation {
            image_id: image,
            annotation_type_id: type_id,
            vector: vec_value,
            user_id: p.user.id,
            last_editor_id: p.user.id,
            blurred: d.get("blurred").is_some_and(truthy),
            concealed: d.get("concealed").is_some_and(truthy),
            description: d
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            meta_data: d.get("meta_data").cloned().unwrap_or(Value::Null),
            unique_identifier: uid,
            deleted: false,
        },
    )
    .await?;
    verify(&mut tx, id, p.user.id, true).await?;
    tx.commit().await.map_err(db_err)?;
    Ok((StatusCode::CREATED, Json(one(&s, &p, &headers, id).await?)).into_response())
}

pub async fn patch_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PATCH).await?)?;
    let id = parse_id(&id)?;
    let d = object(&body)?;
    let ann = visible(&s, &p, id).await?;
    if !set_perms(&s, &p, ann.set_id).await?.edit_annotation {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for editing annotations in this image set missing.",
        ));
    }
    if let Some(v) = d.get("expected_last_edit_time") {
        let expected: DateTime<Utc> = v
            .as_str()
            .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
            .map(Into::into)
            .ok_or_else(|| field_err("expected_last_edit_time", "Use an RFC 3339 timestamp."))?;
        let current: DateTime<Utc> =
            sqlx::query_scalar("SELECT last_edit_time FROM annotations_annotation WHERE id = $1")
                .bind(id)
                .fetch_one(&s.pool)
                .await
                .map_err(db_err)?;
        if current.timestamp_micros() != expected.timestamp_micros() {
            return Ok((
                StatusCode::CONFLICT,
                Json(json!({"detail": "The annotation was modified in the meantime.", "current": one(&s, &p, &headers, id).await?})),
            )
                .into_response());
        }
    }
    let type_id = int_field(&d, "annotation_type")?.unwrap_or(ann.annotation_type_id);
    let atype = type_row(&s, type_id)
        .await?
        .ok_or_else(|| field_err("annotation_type", "Annotation type does not exist."))?;
    if type_id != ann.annotation_type_id && !vector::can_convert(ann.vector_type, atype.vector_type)
    {
        return Err(field_err(
            "annotation_type",
            "Annotations can only be changed to a type with the same vector type (or between bounding box and fixed size bounding box).",
        ));
    }
    let mut vec_value = d.get("vector").cloned();
    if let Some(v) = vec_value.as_mut() {
        if !vector::validate(atype.vector_type, atype.node_count, v) {
            return Err(field_err(
                "vector",
                "The vector is not valid for this annotation type.",
            ));
        }
    }
    let flag = |k: &str| d.get(k).map(truthy);
    let description = d
        .get("description")
        .map(|v| v.as_str().unwrap_or("").to_string());
    if description
        .as_ref()
        .is_some_and(|t| t.chars().count() > 1000)
    {
        return Err(field_err("description", "At most 1000 characters."));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    sqlx::query(
        "UPDATE annotations_annotation SET annotation_type_id = $2, \
           vector = CASE WHEN $3 THEN $4 ELSE vector END, meta_data = CASE WHEN $5 THEN $6 ELSE meta_data END, \
           description = COALESCE($7, description), deleted = COALESCE($8, deleted), \
           _blurred = COALESCE($9, _blurred), _concealed = COALESCE($10, _concealed), \
           last_editor_id = $11, last_edit_time = now() WHERE id = $1",
    )
    .bind(id)
    .bind(type_id)
    .bind(vec_value.is_some())
    .bind(vec_value.unwrap_or(Value::Null))
    .bind(d.contains_key("meta_data"))
    .bind(d.get("meta_data").cloned().unwrap_or(Value::Null))
    .bind(description)
    .bind(flag("deleted"))
    .bind(flag("blurred"))
    .bind(flag("concealed"))
    .bind(p.user.id)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    if d.contains_key("vector") {
        verify(&mut tx, id, p.user.id, true).await?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(Json(one(&s, &p, &headers, id).await?).into_response())
}

pub async fn delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let id = parse_id(&id)?;
    let ann = visible(&s, &p, id).await?;
    if !set_perms(&s, &p, ann.set_id).await?.delete_annotation {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for deleting annotations in this image set missing.",
        ));
    }
    let hard = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .any(|(k, v)| k == "hard" && matches!(v.as_ref(), "true" | "1"));
    if hard {
        let mut tx = s.pool.begin().await.map_err(db_err)?;
        if let Err(msg) = delete_annotations(&mut tx, &[id]).await? {
            return Err(ApiError::detail(StatusCode::CONFLICT, msg));
        }
        tx.commit().await.map_err(db_err)?;
    } else {
        sqlx::query("UPDATE annotations_annotation SET deleted = true, last_editor_id = $2, last_edit_time = now() WHERE id = $1")
            .bind(id)
            .bind(p.user.id)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn verify_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let id = parse_id(&id)?;
    let d = object(&body)?;
    let ann = visible(&s, &p, id).await?;
    if !set_perms(&s, &p, ann.set_id).await?.verify {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for verifying annotations in this image set missing.",
        ));
    }
    let verified = d.get("verified").map(truthy).unwrap_or(true);
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    verify(&mut tx, id, p.user.id, verified).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(Json(one(&s, &p, &headers, id).await?).into_response())
}

// ---------------------------------------------------------------------------------------------------------

/// The annotation, if the caller may read its image set (else 404, as a missing one).
async fn visible(
    s: &AppState,
    p: &Principal,
    id: i64,
) -> ApiResult<crate::compat::writes::AnnotationRow> {
    let ann = annotation_row(s, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if !set_perms(s, p, ann.set_id).await?.read {
        return Err(ApiError::not_found("Not found."));
    }
    Ok(ann)
}

/// v2 representation of one annotation (what `GET /api/v2/annotations/{id}` returns).
async fn one(s: &AppState, p: &Principal, headers: &HeaderMap, id: i64) -> ApiResult<Value> {
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
    let spec = specs::by_name("Annotation");
    engine::serialize_ids(&ctx, spec, &[id])
        .await?
        .into_iter()
        .next()
        .map(snake_keys)
        .ok_or_else(|| ApiError::not_found("Not found."))
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(t) => matches!(t.as_str(), "true" | "True" | "1"),
        _ => false,
    }
}

fn parse_id(id: &str) -> ApiResult<i64> {
    id.parse().map_err(|_| ApiError::not_found("Not found."))
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

fn int_field(d: &Map<String, Value>, key: &str) -> ApiResult<Option<i64>> {
    match d.get(key) {
        None => Ok(None),
        Some(Value::Number(n)) if n.is_i64() => Ok(n.as_i64()),
        Some(_) => Err(field_err(key, "Expected an integer id.")),
    }
}

fn field_err(field: &str, msg: &str) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({"detail": "Validation failed.", "errors": {field: [msg]}}),
    }
}
