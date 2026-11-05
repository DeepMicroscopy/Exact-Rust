//! Annotation writes. One domain layer (permissions, vector validation, transactions) behind the legacy JSON endpoints
//! that exact-sync and the old UI call (`annotations/api/annotation/{create,update,delete,verify,blurred_concealed}/`),
//! the REST resource and the v2 API.

use super::{
    engine::db_err,
    legacy::{body_json, login_write, not_found_msg, parse_error, serialize_annotations},
    perms::{perms, set_row, Perms},
    vector,
};
use crate::{
    auth::Principal,
    error::{ApiError, ApiResult},
    page::Query,
    AppState,
};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    Json,
};
use chrono::TimeZone;
use serde_json::{json, Map, Value};
use sqlx::{Postgres, Row, Transaction};

// ---------------------------------------------------------------------------------------------------------
// request value helpers (Python semantics of `request.data[...]`)
// ---------------------------------------------------------------------------------------------------------

/// `int(x)` of a JSON value; `None` where Python raises (`TypeError` / `ValueError`).
pub fn py_int(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(*b as i64),
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite())
                .map(|f| f.trunc() as i64)
        }),
        Value::String(s) => s.trim().replace('_', "").parse::<i64>().ok(),
        _ => None,
    }
}

/// `bool(x)`: Python truthiness (the string "false" is true).
pub fn py_bool(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(o) => !o.is_empty(),
    }
}

/// A value for a BooleanField column: JSON booleans as they are, numbers and the usual strings converted.
fn bool_field(v: Option<&Value>) -> bool {
    match v {
        Some(Value::String(s)) => matches!(s.to_lowercase().as_str(), "true" | "t" | "1" | "yes"),
        Some(other) => py_bool(other),
        None => false,
    }
}

fn text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// EXACT's `"%Y-%m-%dT%H:%M:%S.%f"` in server local time -> an instant.
pub(super) fn parse_local(s: &AppState, v: &Value) -> Option<chrono::DateTime<chrono::Utc>> {
    let t = v.as_str()?;
    let naive = chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    s.tz.from_local_datetime(&naive)
        .earliest()
        .map(|d| d.with_timezone(&chrono::Utc))
}

// ---------------------------------------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------------------------------------

pub struct TypeRow {
    pub id: i64,
    pub vector_type: i32,
    pub node_count: i32,
}

pub async fn type_row(s: &AppState, id: i64) -> ApiResult<Option<TypeRow>> {
    let r = sqlx::query(
        "SELECT id, vector_type, node_count FROM annotations_annotationtype WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(r.map(|r| TypeRow {
        id: r.get(0),
        vector_type: r.get(1),
        node_count: r.get(2),
    }))
}

pub struct ImageRow {
    pub id: i64,
    pub set_id: i64,
}

pub async fn image_row(s: &AppState, id: i64) -> ApiResult<Option<ImageRow>> {
    let r = sqlx::query("SELECT id, image_set_id FROM images_image WHERE id = $1")
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(r.map(|r| ImageRow {
        id: r.get(0),
        set_id: r.get(1),
    }))
}

pub struct AnnotationRow {
    pub id: i64,
    pub image_id: i64,
    pub set_id: i64,
    pub annotation_type_id: i64,
    pub vector_type: i32,
    pub deleted: bool,
}

pub async fn annotation_row(s: &AppState, id: i64) -> ApiResult<Option<AnnotationRow>> {
    let r = sqlx::query(
        "SELECT a.id, a.image_id, i.image_set_id, a.annotation_type_id, t.vector_type, a.deleted \
         FROM annotations_annotation a JOIN images_image i ON i.id = a.image_id \
         JOIN annotations_annotationtype t ON t.id = a.annotation_type_id WHERE a.id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(r.map(|r| AnnotationRow {
        id: r.get(0),
        image_id: r.get(1),
        set_id: r.get(2),
        annotation_type_id: r.get(3),
        vector_type: r.get(4),
        deleted: r.get(5),
    }))
}

pub async fn set_perms(s: &AppState, p: &Principal, set_id: i64) -> ApiResult<Perms> {
    match set_row(s, set_id).await? {
        Some(row) => perms(s, p, &row).await,
        None => Ok(Perms::default()),
    }
}

/// `Annotation.verify(user, verified)`: update the user's verification or create it.
pub async fn verify(
    tx: &mut Transaction<'_, Postgres>,
    annotation_id: i64,
    user_id: i64,
    verified: bool,
) -> ApiResult<()> {
    let n = sqlx::query("UPDATE annotations_verification SET verified = $3 WHERE annotation_id = $1 AND user_id = $2")
        .bind(annotation_id)
        .bind(user_id)
        .bind(verified)
        .execute(&mut **tx)
        .await
        .map_err(db_err)?
        .rows_affected();
    if n == 0 {
        sqlx::query("INSERT INTO annotations_verification (annotation_id, user_id, verified, time) VALUES ($1, $2, $3, now())")
            .bind(annotation_id)
            .bind(user_id)
            .bind(verified)
            .execute(&mut **tx)
            .await
            .map_err(db_err)?;
    }
    Ok(())
}

pub struct NewAnnotation {
    pub image_id: i64,
    pub annotation_type_id: i64,
    pub vector: Value,
    pub user_id: i64,
    pub last_editor_id: i64,
    pub blurred: bool,
    pub concealed: bool,
    pub description: String,
    pub meta_data: Value,
    pub unique_identifier: Option<uuid::Uuid>,
    pub deleted: bool,
}

/// Inserts the annotation; `time` and `last_edit_time` are now (`auto_now_add` / `auto_now`).
pub async fn insert_annotation(
    tx: &mut Transaction<'_, Postgres>,
    a: &NewAnnotation,
) -> ApiResult<i64> {
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO annotations_annotation (image_id, vector, _concealed, _blurred, time, annotation_type_id, user_id, \
         last_edit_time, last_editor_id, deleted, description, unique_identifier, meta_data) \
         VALUES ($1, $2, $3, $4, now(), $5, $6, now(), $7, $8, $9, $10, $11) RETURNING id",
    )
    .bind(a.image_id)
    .bind(&a.vector)
    .bind(a.concealed)
    .bind(a.blurred)
    .bind(a.annotation_type_id)
    .bind(a.user_id)
    .bind(a.last_editor_id)
    .bind(a.deleted)
    .bind(&a.description)
    // generated here: `gen_random_uuid()` is built into PostgreSQL only from 13 (production runs 12)
    .bind(a.unique_identifier.unwrap_or_else(uuid::Uuid::new_v4))
    .bind(&a.meta_data)
    .fetch_one(&mut **tx)
    .await
    .map_err(db_err)?;
    Ok(id)
}

pub async fn set_last_edit_time(
    s: &AppState,
    id: i64,
    t: chrono::DateTime<chrono::Utc>,
) -> ApiResult<()> {
    sqlx::query("UPDATE annotations_annotation SET last_edit_time = $2 WHERE id = $1")
        .bind(id)
        .bind(t)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

/// Deletes an annotation with the children Django cascades (verifications, media files, segmentation tiles).
/// Returns the counts per model label as `QuerySet.delete()` does. Annotations with versions are protected.
pub async fn delete_annotations(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[i64],
) -> ApiResult<Result<Map<String, Value>, String>> {
    if ids.is_empty() {
        return Ok(Ok(Map::new()));
    }
    let versions: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM annotations_annotationversion WHERE annotation_id = ANY($1)",
    )
    .bind(ids)
    .fetch_one(&mut **tx)
    .await
    .map_err(db_err)?;
    if versions > 0 {
        return Ok(Err(
            "The annotation is referenced by versions of an image set and cannot be deleted."
                .into(),
        ));
    }
    let mut counts = Map::new();
    let mut child = |label: &str, n: u64| {
        if n > 0 {
            counts.insert(label.to_string(), json!(n));
        }
    };
    let n = sqlx::query("DELETE FROM annotations_verification WHERE annotation_id = ANY($1)")
        .bind(ids)
        .execute(&mut **tx)
        .await
        .map_err(db_err)?
        .rows_affected();
    child("annotations.Verification", n);
    let n =
        sqlx::query("DELETE FROM annotations_annotationmediafile WHERE annotation_id = ANY($1)")
            .bind(ids)
            .execute(&mut **tx)
            .await
            .map_err(db_err)?
            .rows_affected();
    child("annotations.AnnotationMediaFile", n);
    let n = sqlx::query("DELETE FROM annotations_segmentationtile WHERE annotation_id = ANY($1)")
        .bind(ids)
        .execute(&mut **tx)
        .await
        .map_err(db_err)?
        .rows_affected();
    child("annotations.SegmentationTile", n);
    let n = sqlx::query("DELETE FROM annotations_annotation WHERE id = ANY($1)")
        .bind(ids)
        .execute(&mut **tx)
        .await
        .map_err(db_err)?
        .rows_affected();
    child("annotations.Annotation", n);
    Ok(Ok(counts))
}

// ---------------------------------------------------------------------------------------------------------
// legacy JSON endpoints
// ---------------------------------------------------------------------------------------------------------

fn forbidden(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::FORBIDDEN, msg)
}

fn bad_request(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
}

pub(super) fn required_int(d: &Map<String, Value>, key: &str) -> ApiResult<i64> {
    d.get(key).and_then(py_int).ok_or_else(parse_error)
}

/// `annotations/api/annotation/create/`
pub async fn create_annotation(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = login_write(&s, &headers, &Method::POST).await?;
    let d = body_json(&body);
    let image_id = required_int(&d, "image_id")?;
    let type_id = required_int(&d, "annotation_type_id")?;
    let mut vec_value = d.get("vector").cloned().ok_or_else(parse_error)?;
    let tempid = d.get("tempid").cloned().unwrap_or(Value::Bool(false));

    let image = image_row(&s, image_id)
        .await?
        .ok_or_else(|| not_found_msg("Image"))?;
    let atype = type_row(&s, type_id)
        .await?
        .ok_or_else(|| not_found_msg("AnnotationType"))?;
    if !set_perms(&s, &p, image.set_id).await?.annotate {
        return Err(forbidden(
            "permission for annotating in this image set missing.",
        ));
    }
    if !vector::validate(atype.vector_type, atype.node_count, &mut vec_value) {
        return Err(bad_request("the vector is not valid"));
    }
    let uid = match d.get("unique_identifier") {
        Some(v) => Some(
            v.as_str()
                .and_then(|t| uuid::Uuid::parse_str(t).ok())
                .ok_or_else(|| bad_request("unique_identifier is not a valid UUID."))?,
        ),
        None => None,
    };

    // one global annotation per type and image (per user in competitive sets)
    let collaborative = set_row(&s, image.set_id)
        .await?
        .is_none_or(|r| r.collaboration_type == 0);
    let mut existing: Option<(i64, bool)> = None;
    if atype.vector_type == vector::GLOBAL {
        let row = if collaborative {
            sqlx::query("SELECT id, deleted FROM annotations_annotation WHERE image_id = $1 AND annotation_type_id = $2 ORDER BY id LIMIT 1").bind(image.id).bind(atype.id).fetch_optional(&s.pool).await
        } else {
            sqlx::query("SELECT id, deleted FROM annotations_annotation WHERE image_id = $1 AND annotation_type_id = $2 AND user_id = $3 ORDER BY id LIMIT 1").bind(image.id).bind(atype.id).bind(p.user.id).fetch_optional(&s.pool).await
        }
        .map_err(db_err)?;
        existing = row.map(|r| (r.get(0), r.get(1)));
    }

    let id = match existing {
        None => {
            let mut tx = s.pool.begin().await.map_err(db_err)?;
            let id = insert_annotation(
                &mut tx,
                &NewAnnotation {
                    image_id: image.id,
                    annotation_type_id: atype.id,
                    vector: vec_value,
                    user_id: p.user.id,
                    last_editor_id: p.user.id,
                    blurred: bool_field(d.get("blurred")),
                    concealed: bool_field(d.get("concealed")),
                    description: text(d.get("description")),
                    meta_data: d.get("meta_data").cloned().unwrap_or(Value::Null),
                    unique_identifier: uid,
                    deleted: false,
                },
            )
            .await?;
            verify(&mut tx, id, p.user.id, true).await?; // the creator verifies automatically
            tx.commit().await.map_err(db_err)?;
            if let Some(t) = d.get("last_edit_time").and_then(|v| parse_local(&s, v)) {
                set_last_edit_time(&s, id, t).await?; // SlideRunner sync keeps its own edit time
            }
            id
        }
        Some((id, deleted)) => {
            if deleted {
                // reactivate a deleted annotation
                sqlx::query("UPDATE annotations_annotation SET deleted = false, last_edit_time = now() WHERE id = $1").bind(id).execute(&s.pool).await.map_err(db_err)?;
            }
            id
        }
    };
    let ann = serialize_annotations(&s, &[id])
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    Ok((
        StatusCode::CREATED,
        Json(json!({"annotations": ann, "tempid": tempid})),
    )
        .into_response())
}

/// `annotations/api/annotation/update/`
pub async fn update_annotation(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = login_write(&s, &headers, &Method::POST).await?;
    let d = body_json(&body);
    let annotation_id = required_int(&d, "annotation_id")?;
    let image_id = required_int(&d, "image_id")?;
    let type_id = required_int(&d, "annotation_type_id")?;
    let mut vec_value = d.get("vector").cloned().ok_or_else(parse_error)?;
    let deleted = d.get("deleted").is_some_and(py_bool);

    let ann = annotation_row(&s, annotation_id)
        .await?
        .ok_or_else(|| not_found_msg("Annotation"))?;
    let atype = type_row(&s, type_id)
        .await?
        .ok_or_else(|| not_found_msg("AnnotationType"))?;
    if ann.image_id != image_id {
        return Err(bad_request(
            "the image id does not match the annotation id.",
        ));
    }
    if !set_perms(&s, &p, ann.set_id).await?.edit_annotation {
        return Err(forbidden(
            "permission for updating annotations in this image set missing.",
        ));
    }
    if !vector::validate(atype.vector_type, atype.node_count, &mut vec_value) {
        return Err(bad_request("the vector is not valid"));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    sqlx::query(
        "UPDATE annotations_annotation SET annotation_type_id = $2, vector = $3, _concealed = $4, _blurred = $5, \
         last_editor_id = $6, deleted = $7, description = $8, meta_data = $9, last_edit_time = now() WHERE id = $1",
    )
    .bind(annotation_id)
    .bind(atype.id)
    .bind(&vec_value)
    .bind(bool_field(d.get("concealed")))
    .bind(bool_field(d.get("blurred")))
    .bind(p.user.id)
    .bind(deleted)
    .bind(text(d.get("description")))
    .bind(d.get("meta_data").cloned().unwrap_or(Value::Null))
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    verify(&mut tx, annotation_id, p.user.id, true).await?;
    tx.commit().await.map_err(db_err)?;
    if let Some(t) = d.get("last_edit_time").and_then(|v| parse_local(&s, v)) {
        set_last_edit_time(&s, annotation_id, t).await?;
    }
    let out = serialize_annotations(&s, &[annotation_id])
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    Ok(Json(json!({"annotations": out})).into_response())
}

/// `annotations/api/annotation/delete/` (DELETE with `annotation_id`, `keep_deleted_element`)
pub async fn delete_annotation(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let p = login_write(&s, &headers, &Method::DELETE).await?;
    let q = Query::parse(uri.query());
    let annotation_id: i64 = q
        .get("annotation_id")
        .and_then(|v| v.parse().ok())
        .ok_or_else(parse_error)?;
    let keep = q.get("keep_deleted_element").is_some_and(|v| !v.is_empty()); // Python bool(str)
    let ann = annotation_row(&s, annotation_id)
        .await?
        .ok_or_else(|| not_found_msg("Annotation"))?;
    if !set_perms(&s, &p, ann.set_id).await?.delete_annotation {
        return Err(forbidden(
            "permission for deleting annotations in this image set missing.",
        ));
    }
    let ctx = super::legacy::rest_ctx(&s, &p, &headers);
    let spec = super::specs::by_name("Annotation");
    let row: Value =
        sqlx::query_scalar("SELECT to_jsonb(t) FROM annotations_annotation t WHERE id = $1")
            .bind(annotation_id)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
    let row = match row {
        Value::Object(m) => m,
        _ => return Err(not_found_msg("Annotation")),
    };
    if keep {
        sqlx::query("UPDATE annotations_annotation SET last_editor_id = $2, deleted = true, last_edit_time = now() WHERE id = $1").bind(annotation_id).bind(p.user.id).execute(&s.pool).await.map_err(db_err)?;
        let fresh: Value =
            sqlx::query_scalar("SELECT to_jsonb(t) FROM annotations_annotation t WHERE id = $1")
                .bind(annotation_id)
                .fetch_one(&s.pool)
                .await
                .map_err(db_err)?;
        let Value::Object(fresh) = fresh else {
            return Err(not_found_msg("Annotation"));
        };
        let out = super::engine::serialize(&ctx, spec, vec![fresh], None).await?;
        return Ok(Json(json!({"annotations": out.into_iter().next()})).into_response());
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    match delete_annotations(&mut tx, &[annotation_id]).await? {
        Ok(_) => tx.commit().await.map_err(db_err)?,
        Err(msg) => return Err(ApiError::detail(StatusCode::CONFLICT, msg)),
    }
    // serialized after the delete from the row read before: the relations and per-user flags are gone, like in Django
    let out = super::engine::serialize(&ctx, spec, vec![row], None).await?;
    Ok(Json(json!({"annotations": out.into_iter().next()})).into_response())
}

/// `annotations/api/annotation/verify/`
pub async fn verify_annotation(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = login_write(&s, &headers, &Method::POST).await?;
    let d = body_json(&body);
    let annotation_id = required_int(&d, "annotation_id")?;
    let state = match d.get("state").and_then(Value::as_str) {
        Some("accept") => true,
        Some("reject") => false,
        _ => return Err(parse_error()),
    };
    let ann = annotation_row(&s, annotation_id)
        .await?
        .ok_or_else(|| not_found_msg("Annotation"))?;
    if !set_perms(&s, &p, ann.set_id).await?.verify {
        return Err(forbidden(
            "permission for verifying annotations in this image set missing.",
        ));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    verify(&mut tx, annotation_id, p.user.id, state).await?;
    tx.commit().await.map_err(db_err)?;
    let out = serialize_annotations(&s, &[annotation_id])
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    // Django asks the database right after verifying, so the "already verified" message is the one that is always shown
    let detail = if state {
        "the user already verified this annotation and verified it now"
    } else {
        "the user already verified this annotation and rejected it now"
    };
    Ok(Json(json!({"annotation": out, "detail": detail})).into_response())
}

/// `annotations/api/annotation/blurred_concealed/`
pub async fn blurred_concealed(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = login_write(&s, &headers, &Method::POST).await?;
    let d = body_json(&body);
    let annotation_id = required_int(&d, "annotation_id")?;
    let blurred = d.get("blurred").ok_or_else(parse_error)?;
    let concealed = d.get("concealed").ok_or_else(parse_error)?;
    let ann = annotation_row(&s, annotation_id)
        .await?
        .ok_or_else(|| not_found_msg("Annotation"))?;
    if !set_perms(&s, &p, ann.set_id).await?.edit_annotation {
        return Err(forbidden(
            "permission for verifying annotations in this image set missing.",
        ));
    }
    sqlx::query("UPDATE annotations_annotation SET _concealed = $2, _blurred = $3, last_edit_time = now() WHERE id = $1").bind(annotation_id).bind(bool_field(Some(concealed))).bind(bool_field(Some(blurred))).execute(&s.pool).await.map_err(db_err)?;
    Ok(Json(json!({"detail": "you updated the last annotation"})).into_response())
}
