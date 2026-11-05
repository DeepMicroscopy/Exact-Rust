//! Writes of `/api/v1/annotations/annotations/` (DRF `AnnotationViewSet`): create (single and list), update, partial
//! update, delete, `multiple_delete` and `count`. Validation errors have DRF's shape (`{"field": ["message"]}`).
//!
//! Deliberate differences to Django: the user needs the `annotate` / `edit_annotation` / `delete_annotation`
//! permission of the image set (Django checks only the model permission and, for existing objects, the team), a
//! missing `unique_identifier` simply creates the annotation (Django answers 500), annotations that have versions
//! answer 409 on deletion (Django 500), and unparsable times answer 400 (Django 500).

use super::{
    engine::{self, db_err},
    legacy::rest_ctx,
    specs,
    writes::{
        annotation_row, delete_annotations, insert_annotation, parse_local, set_last_edit_time,
        set_perms, NewAnnotation,
    },
};
use crate::{
    auth::Principal,
    error::{with_allow, ApiError, ApiResult},
    page::Flex,
    AppState,
};
use axum::{
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};
use sqlx::Row;

pub fn is_annotation(spec: &engine::Spec) -> bool {
    spec.name == "Annotation"
}

fn bad(errors: Map<String, Value>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: Value::Object(errors),
    }
}

fn kind(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// `PrimaryKeyRelatedField.to_internal_value`
async fn pk_field(s: &AppState, table: &str, v: &Value) -> Result<i64, String> {
    let incorrect = || format!("Incorrect type. Expected pk value, received {}.", kind(v));
    let id = match v {
        Value::Null => return Err("This field may not be null.".into()),
        Value::Number(n) if n.is_i64() => n.as_i64().unwrap_or(0),
        Value::String(t) => t.trim().parse::<i64>().map_err(|_| incorrect())?,
        _ => return Err(incorrect()),
    };
    let found: Option<i64> = sqlx::query_scalar(&format!("SELECT id FROM {table} WHERE id = $1"))
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(|e| e.to_string())?;
    found.ok_or_else(|| {
        let shown = match v {
            Value::String(t) => t.clone(),
            o => o.to_string(),
        };
        format!("Invalid pk \"{shown}\" - object does not exist.")
    })
}

fn boolean(v: &Value) -> Result<bool, String> {
    match v {
        Value::Bool(b) => Ok(*b),
        Value::Number(n) if n.as_i64() == Some(0) || n.as_i64() == Some(1) => {
            Ok(n.as_i64() == Some(1))
        }
        Value::String(t) => match t.as_str() {
            "t" | "T" | "y" | "Y" | "yes" | "Yes" | "YES" | "true" | "True" | "TRUE" | "on"
            | "On" | "ON" | "1" => Ok(true),
            "f" | "F" | "n" | "N" | "no" | "No" | "NO" | "false" | "False" | "FALSE" | "off"
            | "Off" | "OFF" | "0" => Ok(false),
            _ => Err("Must be a valid boolean.".into()),
        },
        Value::Null => Err("This field may not be null.".into()),
        _ => Err("Must be a valid boolean.".into()),
    }
}

#[derive(Default)]
struct Fields {
    annotation_type: Option<i64>,
    image: Option<i64>,
    user: Option<Option<i64>>,
    last_editor: Option<Option<i64>>,
    vector: Option<Value>,
    meta_data: Option<Value>,
    deleted: Option<bool>,
    description: Option<String>,
    unique_identifier: Option<uuid::Uuid>,
}

/// The writable fields of `AnnotationSerializer`; `image` and `annotation_type` are required unless `partial`.
async fn parse_fields(s: &AppState, d: &Map<String, Value>, partial: bool) -> ApiResult<Fields> {
    let mut f = Fields::default();
    let mut errors = Map::new();
    let mut err = |name: &str, m: String| {
        errors.insert(name.to_string(), json!([m]));
    };
    for (name, table) in [
        ("annotation_type", "annotations_annotationtype"),
        ("image", "images_image"),
    ] {
        match d.get(name) {
            Some(v) => match pk_field(s, table, v).await {
                Ok(id) if name == "image" => f.image = Some(id),
                Ok(id) => f.annotation_type = Some(id),
                Err(m) => err(name, m),
            },
            None if !partial => err(name, "This field is required.".into()),
            None => {}
        }
    }
    for (name, slot) in [("user", &mut f.user), ("last_editor", &mut f.last_editor)] {
        match d.get(name) {
            Some(Value::Null) => *slot = Some(None),
            Some(v) => match pk_field(s, "users_user", v).await {
                Ok(id) => *slot = Some(Some(id)),
                Err(m) => err(name, m),
            },
            None => {}
        }
    }
    if let Some(v) = d.get("vector") {
        f.vector = Some(v.clone());
    }
    if let Some(v) = d.get("meta_data") {
        f.meta_data = Some(v.clone());
    }
    if let Some(v) = d.get("deleted") {
        match boolean(v) {
            Ok(b) => f.deleted = Some(b),
            Err(m) => err("deleted", m),
        }
    }
    if let Some(v) = d.get("description") {
        match v {
            Value::String(t) if t.chars().count() > 1000 => err(
                "description",
                "Ensure this field has no more than 1000 characters.".into(),
            ),
            Value::String(t) => f.description = Some(t.clone()),
            Value::Null => err("description", "This field may not be null.".into()),
            o => f.description = Some(o.to_string()),
        }
    }
    if let Some(v) = d.get("unique_identifier") {
        match v.as_str().and_then(|t| uuid::Uuid::parse_str(t).ok()) {
            Some(u) => f.unique_identifier = Some(u),
            None => err("unique_identifier", "Must be a valid UUID.".into()),
        }
    }
    if errors.is_empty() {
        Ok(f)
    } else {
        Err(bad(errors))
    }
}

pub(super) fn body_value(body: &[u8]) -> ApiResult<Value> {
    if body.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_slice(body)
        .map_err(|e| ApiError::detail(StatusCode::BAD_REQUEST, format!("JSON parse error - {e}")))
}

pub(super) fn object(v: Value) -> ApiResult<Map<String, Value>> {
    match v {
        Value::Object(m) => Ok(m),
        other => {
            let mut e = Map::new();
            e.insert(
                "non_field_errors".into(),
                json!([format!(
                    "Invalid data. Expected a dictionary, but got {}.",
                    kind(&other)
                )]),
            );
            Err(bad(e))
        }
    }
}

fn time_field(
    s: &AppState,
    d: &Map<String, Value>,
    key: &str,
) -> ApiResult<Option<chrono::DateTime<chrono::Utc>>> {
    match d.get(key) {
        None => Ok(None),
        Some(v) => parse_local(s, v).map(Some).ok_or_else(|| {
            ApiError::validation(
                key,
                "Datetime has wrong format. Use this format instead: YYYY-MM-DDTHH:MM:SS.ffffff.",
            )
        }),
    }
}

/// The annotations as the DRF serializer of the viewset answers them (what `GET /api/v1/annotations/annotations/{id}/` shows): flat, the
/// related objects as ids. (The legacy `annotation/create` endpoints answer with the expanded shape; these do not.)
async fn serialize_many(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    ids: &[i64],
) -> ApiResult<Vec<Value>> {
    let spec = specs::find("annotations", "annotations").ok_or_else(ApiError::not_found_page)?;
    engine::serialize_ids(&rest_ctx(s, p, headers), spec, ids).await
}

async fn serialize_one(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    id: i64,
) -> ApiResult<Value> {
    Ok(serialize_many(s, p, headers, &[id])
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null))
}

fn out(status: StatusCode, v: Value, allow: &'static str) -> Response {
    with_allow((status, Json(v)).into_response(), allow)
}

fn forbidden(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::FORBIDDEN, msg)
}

async fn require_annotate(s: &AppState, p: &Principal, image_id: i64) -> ApiResult<()> {
    let set: Option<i64> =
        sqlx::query_scalar("SELECT image_set_id FROM images_image WHERE id = $1")
            .bind(image_id)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?;
    match set {
        Some(set) if set_perms(s, p, set).await?.annotate => Ok(()),
        _ => Err(forbidden(
            "permission for annotating in this image set missing.",
        )),
    }
}

pub async fn create(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    body: &[u8],
    allow: &'static str,
) -> ApiResult<Response> {
    match body_value(body)? {
        Value::Array(items) => create_many(s, p, headers, items, allow).await,
        other => create_one(s, p, headers, object(other)?, allow).await,
    }
}

/// List create: Django bulk-creates the objects without serializer validation; `time` and `last_edit_time` of the body
/// are overwritten by `auto_now_add` / `auto_now` there, so they are ignored here as well.
async fn create_many(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    items: Vec<Value>,
    allow: &'static str,
) -> ApiResult<Response> {
    let mut rows = Vec::with_capacity(items.len());
    for item in items {
        let d = object(item)?;
        let f = parse_fields(s, &d, false).await?;
        let image = f.image.unwrap_or_default();
        require_annotate(s, p, image).await?;
        rows.push(NewAnnotation {
            image_id: image,
            annotation_type_id: f.annotation_type.unwrap_or_default(),
            vector: f.vector.unwrap_or(Value::Null),
            user_id: f.user.flatten().unwrap_or(p.user.id),
            last_editor_id: f.last_editor.flatten().unwrap_or(p.user.id),
            blurred: false,
            concealed: false,
            description: f.description.unwrap_or_default(),
            meta_data: f.meta_data.unwrap_or(Value::Null),
            unique_identifier: f.unique_identifier,
            deleted: f.deleted.unwrap_or(false),
        });
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let mut created = Vec::with_capacity(rows.len());
    for r in &rows {
        created.push(insert_annotation(&mut tx, r).await?);
    }
    tx.commit().await.map_err(db_err)?;
    let list = serialize_many(s, p, headers, &created).await?;
    Ok(out(StatusCode::CREATED, Value::Array(list), allow))
}

async fn create_one(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    d: Map<String, Value>,
    allow: &'static str,
) -> ApiResult<Response> {
    let f = parse_fields(s, &d, false).await?;
    let image = f.image.unwrap_or_default();
    let atype = f.annotation_type.unwrap_or_default();
    let time = time_field(s, &d, "time")?;
    let last_edit = time_field(s, &d, "last_edit_time")?;
    require_annotate(s, p, image).await?;

    // an annotation with this unique identifier on the image is updated instead (keeps clients idempotent)
    if let Some(uid) = f.unique_identifier {
        let existing: Option<(i64, i64, i32)> = sqlx::query(
            "SELECT a.id, a.annotation_type_id, t.vector_type FROM annotations_annotation a \
             JOIN annotations_annotationtype t ON t.id = a.annotation_type_id \
             WHERE a.image_id = $1 AND a.unique_identifier = $2 ORDER BY a.id LIMIT 1",
        )
        .bind(image)
        .bind(uid)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .map(|r| (r.get(0), r.get(1), r.get(2)));
        if let Some((id, old_type, old_vt)) = existing {
            if old_type != atype {
                let new_vt: i32 = sqlx::query_scalar(
                    "SELECT vector_type FROM annotations_annotationtype WHERE id = $1",
                )
                .bind(atype)
                .fetch_one(&s.pool)
                .await
                .map_err(db_err)?;
                if !super::vector::can_convert(old_vt, new_vt) {
                    return Ok(out(
                        StatusCode::BAD_REQUEST,
                        json!({"annotation_type": "Annotation type change not allowed for this vector type."}),
                        allow,
                    ));
                }
            }
            sqlx::query(
                "UPDATE annotations_annotation SET vector = COALESCE($2, vector), annotation_type_id = $3, \
                 deleted = COALESCE($4, deleted), time = COALESCE($5, time), last_edit_time = COALESCE($6, now()) WHERE id = $1",
            )
            .bind(id)
            .bind(f.vector.as_ref().filter(|v| !v.is_null()))
            .bind(atype)
            .bind(f.deleted)
            .bind(time)
            .bind(last_edit)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
            return Ok(out(
                StatusCode::OK,
                serialize_one(s, p, headers, id).await?,
                allow,
            ));
        }
    }

    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let id = insert_annotation(
        &mut tx,
        &NewAnnotation {
            image_id: image,
            annotation_type_id: atype,
            vector: f.vector.unwrap_or(Value::Null),
            user_id: f.user.flatten().unwrap_or(p.user.id),
            last_editor_id: f.last_editor.flatten().unwrap_or(p.user.id),
            blurred: false,
            concealed: false,
            description: f.description.unwrap_or_default(),
            meta_data: f.meta_data.unwrap_or(Value::Null),
            unique_identifier: f.unique_identifier,
            deleted: f.deleted.unwrap_or(false),
        },
    )
    .await?;
    if let Some(t) = time {
        sqlx::query("UPDATE annotations_annotation SET time = $2 WHERE id = $1")
            .bind(id)
            .bind(t)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    if let Some(t) = last_edit {
        set_last_edit_time(s, id, t).await?;
    }
    Ok(out(
        StatusCode::CREATED,
        serialize_one(s, p, headers, id).await?,
        allow,
    ))
}

/// PUT (`partial` false) and PATCH of one annotation the caller may see. `last_editor` defaults to the caller; PUT also
/// applies `time` / `last_edit_time` from the body, PATCH does not (as in the view).
pub async fn update(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    id: i64,
    body: &[u8],
    partial: bool,
    allow: &'static str,
) -> ApiResult<Response> {
    let d = object(body_value(body)?)?;
    let row = annotation_row(s, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if !set_perms(s, p, row.set_id).await?.edit_annotation {
        return Err(forbidden(
            "permission for editing annotations in this image set missing.",
        ));
    }
    let f = parse_fields(s, &d, partial).await?;
    if let Some(new_type) = f.annotation_type.filter(|t| *t != row.annotation_type_id) {
        let new_vt: i32 =
            sqlx::query_scalar("SELECT vector_type FROM annotations_annotationtype WHERE id = $1")
                .bind(new_type)
                .fetch_one(&s.pool)
                .await
                .map_err(db_err)?;
        if !super::vector::can_convert(row.vector_type, new_vt) {
            return Err(ApiError::validation(
                "annotation_type",
                "Annotations can only be changed to an annotation type with the same vector type (or between bounding box and fixed size bounding box).",
            ));
        }
    }
    if let Some(img) = f.image {
        require_annotate(s, p, img).await?;
    }
    let (time, last_edit) = if partial {
        (None, None)
    } else {
        (
            time_field(s, &d, "time")?,
            time_field(s, &d, "last_edit_time")?,
        )
    };
    sqlx::query(
        "UPDATE annotations_annotation SET \
           annotation_type_id = COALESCE($2, annotation_type_id), image_id = COALESCE($3, image_id), \
           user_id = CASE WHEN $4 THEN $5 ELSE user_id END, last_editor_id = $6, \
           vector = CASE WHEN $7 THEN $8 ELSE vector END, meta_data = CASE WHEN $9 THEN $10 ELSE meta_data END, \
           deleted = COALESCE($11, deleted), description = COALESCE($12, description), \
           unique_identifier = COALESCE($13, unique_identifier), \
           time = COALESCE($14, time), last_edit_time = COALESCE($15, now()) WHERE id = $1",
    )
    .bind(id)
    .bind(f.annotation_type)
    .bind(f.image)
    .bind(f.user.is_some())
    .bind(f.user.flatten())
    .bind(f.last_editor.flatten().unwrap_or(p.user.id))
    .bind(f.vector.is_some())
    .bind(f.vector.clone().unwrap_or(Value::Null))
    .bind(f.meta_data.is_some())
    .bind(f.meta_data.clone().unwrap_or(Value::Null))
    .bind(f.deleted)
    .bind(f.description)
    .bind(f.unique_identifier)
    .bind(time)
    .bind(last_edit)
    .execute(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(out(
        StatusCode::OK,
        serialize_one(s, p, headers, id).await?,
        allow,
    ))
}

async fn delete_ids(s: &AppState, p: &Principal, ids: &[i64]) -> ApiResult<Map<String, Value>> {
    for id in ids {
        if let Some(row) = annotation_row(s, *id).await? {
            if !set_perms(s, p, row.set_id).await?.delete_annotation {
                return Err(forbidden(
                    "permission for deleting annotations in this image set missing.",
                ));
            }
        }
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    match delete_annotations(&mut tx, ids).await? {
        Ok(counts) => {
            tx.commit().await.map_err(db_err)?;
            Ok(counts)
        }
        Err(msg) => Err(ApiError::detail(StatusCode::CONFLICT, msg)),
    }
}

pub async fn delete(s: &AppState, p: &Principal, id: i64) -> ApiResult<Response> {
    delete_ids(s, p, &[id]).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `DELETE .../multiple_delete/?id__in=1,2,3`: removes the visible ones among the ids, answers the per-model counts.
pub async fn multiple_delete(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    pairs: &[(String, String)],
) -> ApiResult<Response> {
    const ALLOW: &str = "DELETE, OPTIONS";
    let Some(raw) = pairs
        .iter()
        .find(|(k, _)| k == "id__in")
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
    else {
        return Ok(out(
            StatusCode::NOT_FOUND,
            json!("The syntax is: id__in=1,2,3,4"),
            ALLOW,
        ));
    };
    let mut asked = vec![];
    for part in raw.replace(['[', ']'], "").split(',') {
        asked.push(part.trim().parse::<i64>().map_err(|_| {
            ApiError::detail(
                StatusCode::BAD_REQUEST,
                format!("invalid literal for int() with base 10: '{}'", part.trim()),
            )
        })?);
    }
    let spec = specs::find("annotations", "annotations").ok_or_else(ApiError::not_found_page)?;
    let ctx = rest_ctx(s, p, headers);
    let filter = vec![(
        "id__in".to_string(),
        asked
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(","),
    )];
    let (_, visible) = engine::list(
        &ctx,
        spec,
        &filter,
        &Flex::default(),
        asked.len().max(1) as i64,
        0,
        None,
    )
    .await?;
    let ids: Vec<i64> = visible.iter().filter_map(|v| v["id"].as_i64()).collect();
    let counts = delete_ids(s, p, &ids).await?;
    Ok(out(StatusCode::OK, Value::Object(counts), ALLOW))
}

/// `GET .../count/`: the number of annotations the filters select among the visible ones.
pub async fn count(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    pairs: &[(String, String)],
) -> ApiResult<Response> {
    let spec = specs::find("annotations", "annotations").ok_or_else(ApiError::not_found_page)?;
    let (n, _) = engine::list(
        &rest_ctx(s, p, headers),
        spec,
        pairs,
        &Flex::default(),
        1,
        0,
        None,
    )
    .await?;
    Ok(out(
        StatusCode::OK,
        json!({"count": n}),
        "GET, HEAD, OPTIONS",
    ))
}
