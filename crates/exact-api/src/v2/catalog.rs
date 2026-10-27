//! Tags, products and annotation types: the legacy endpoints exact-sync and the old UI use
//! (`images/api/imageset/{tag,product}/{add,delete}/`, `administration/api/annotation_type/{create,delete}/`) and the v2
//! resources (`/api/v2/image-sets/{id}/tags`, `.../products/{pid}`, `/api/v2/annotation-types`, `/api/v2/products`).
//!
//! Annotation types and products are administration data: they need the Django model permissions
//! (`annotations.add_annotationtype`, `administration.change_product`, ...), the set relations need `edit_set`.

use crate::{
    auth::{authenticate, require_model_perm, require_user, Principal},
    cascade,
    compat::{
        engine::{self, db_err, snake_keys, Ctx},
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
    routing::{delete, post, put},
    Json, Router,
};
use serde_json::{json, Map, Value};

pub fn legacy_routes() -> Router<AppState> {
    Router::new()
        .route("/images/api/imageset/tag/add/", post(legacy_tag_add))
        .route(
            "/images/api/imageset/tag/delete/",
            delete(legacy_tag_delete),
        )
        .route(
            "/images/api/imageset/product/add/",
            post(legacy_product_add),
        )
        .route(
            "/images/api/imageset/product/delete/",
            delete(legacy_product_delete),
        )
        .route(
            "/administration/api/annotation_type/create/",
            post(legacy_type_create),
        )
        .route(
            "/administration/api/annotation_type/delete/",
            post(legacy_type_delete),
        )
}

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/image-sets/{id}/tags", post(tag_add_h))
        .route("/api/v2/image-sets/{id}/tags/{name}", delete(tag_delete_h))
        .route(
            "/api/v2/image-sets/{id}/products/{pid}",
            put(set_product_add_h).delete(set_product_delete_h),
        )
}

// ---------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------

pub(crate) fn field_err(field: &str, msg: &str) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({"detail": "Validation failed.", "errors": {field: [msg]}}),
    }
}

pub(crate) fn object(body: &[u8]) -> ApiResult<Map<String, Value>> {
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

pub(crate) fn int(v: Option<&Value>) -> Option<i64> {
    match v? {
        Value::Number(n) => n.as_i64(),
        Value::String(t) => t.trim().parse().ok(),
        Value::Object(m) => int(m.get("id")),
        _ => None,
    }
}

pub(crate) fn flag(v: Option<&Value>) -> Option<bool> {
    v.map(|v| match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(t) => matches!(t.as_str(), "true" | "True" | "1"),
        _ => false,
    })
}

fn host(headers: &HeaderMap) -> String {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost")
        .to_string()
}

/// Serialized like the REST resource: v1 shape (`legacy`) or v2 snake_case.
pub(crate) async fn serialized(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &str,
    id: i64,
    v2: bool,
) -> ApiResult<Value> {
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: host(headers),
        v2,
    };
    let v = engine::serialize_ids(&ctx, specs::by_name(spec), &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    Ok(if v2 { snake_keys(v) } else { v })
}

async fn editable_set(s: &AppState, p: &Principal, id: i64, what: &str) -> ApiResult<()> {
    let row = set_row(s, id)
        .await?
        .ok_or_else(|| ApiError::not_found("No ImageSet matches the given query."))?;
    let pm = perms(s, p, &row).await?;
    if !pm.read {
        return Err(ApiError::not_found("No ImageSet matches the given query."));
    }
    if !pm.edit_set {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            format!("permission for {what} this image set missing."),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------
// tags
// ---------------------------------------------------------------------------------------------------------

/// Django: lowercase, `, & = ?` removed, spaces to underscores.
fn clean_tag(raw: &str) -> String {
    raw.to_lowercase()
        .replace([',', '&', '=', '?'], "")
        .replace(' ', "_")
}

enum Added {
    Already,
    Added(i64),
}

async fn add_tag(s: &AppState, set: i64, name: &str) -> ApiResult<Added> {
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let has: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM images_settag_imagesets m JOIN images_settag t ON t.id = m.settag_id WHERE m.imageset_id = $1 AND t.name = $2)",
    )
    .bind(set)
    .bind(name)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    if has {
        return Ok(Added::Already);
    }
    let existing: Option<i64> =
        sqlx::query_scalar("SELECT id FROM images_settag WHERE name = $1 ORDER BY id LIMIT 1")
            .bind(name)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
    let tag = match existing {
        Some(t) => t,
        None => sqlx::query_scalar("INSERT INTO images_settag (name) VALUES ($1) RETURNING id")
            .bind(name)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_err)?,
    };
    sqlx::query("INSERT INTO images_settag_imagesets (settag_id, imageset_id) VALUES ($1, $2)")
        .bind(tag)
        .bind(set)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(Added::Added(tag))
}

/// Removes the tag from the set; a tag without sets disappears (except `test`). `None`: the set does not have it.
async fn remove_tag(s: &AppState, set: i64, tag: i64, name: &str) -> ApiResult<bool> {
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let n = sqlx::query(
        "DELETE FROM images_settag_imagesets WHERE settag_id = $1 AND imageset_id = $2",
    )
    .bind(tag)
    .bind(set)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?
    .rows_affected();
    if n == 0 {
        return Ok(false);
    }
    let left: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM images_settag_imagesets WHERE settag_id = $1)",
    )
    .bind(tag)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    if !left && name != "test" {
        sqlx::query("DELETE FROM images_settag WHERE id = $1")
            .bind(tag)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(true)
}

async fn tag_id(s: &AppState, name: &str) -> ApiResult<Option<i64>> {
    sqlx::query_scalar("SELECT id FROM images_settag WHERE name = $1 ORDER BY id LIMIT 1")
        .bind(name)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)
}

async fn legacy_tag_add(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    let set = int(d.get("image_set_id")).ok_or_else(parse_error)?;
    let name = clean_tag(&d.get("tag_name").map(text_of).ok_or_else(parse_error)?);
    editable_set(&s, &p, set, "tagging").await?;
    match add_tag(&s, set, &name).await? {
        Added::Already => Ok(Json(json!({"detail": "imageset has the tag already."})).into_response()),
        Added::Added(tag) => Ok((
            StatusCode::CREATED,
            Json(json!({"detail": "tagged the imageset.", "tag": serialized(&s, &p, &headers, "SetTag", tag, false).await?})),
        )
            .into_response()),
    }
}

async fn legacy_tag_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let d = object(&body)?;
    let set = int(d.get("image_set_id")).ok_or_else(parse_error)?;
    let name = d
        .get("tag_name")
        .map(text_of)
        .ok_or_else(parse_error)?
        .to_lowercase();
    let tag = tag_id(&s, &name)
        .await?
        .ok_or_else(|| ApiError::not_found("No SetTag matches the given query."))?;
    editable_set(&s, &p, set, "tagging").await?;
    let shown = serialized(&s, &p, &headers, "SetTag", tag, false).await?;
    if !remove_tag(&s, set, tag, &name).await? {
        return Ok(Json(json!({"detail": "tag not in imageset tags"})).into_response());
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({"detail": "removed the tag.", "tag": shown})),
    )
        .into_response())
}

async fn tag_add_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    let name = clean_tag(
        &d.get("name")
            .map(text_of)
            .ok_or_else(|| field_err("name", "This field is required."))?,
    );
    if name.is_empty() || name.chars().count() > 100 {
        return Err(field_err(
            "name",
            "A tag of 1 to 100 characters is required.",
        ));
    }
    editable_set(&s, &p, id, "tagging").await?;
    let (status, tag) = match add_tag(&s, id, &name).await? {
        Added::Already => (
            StatusCode::OK,
            tag_id(&s, &name)
                .await?
                .ok_or_else(|| ApiError::not_found("Not found."))?,
        ),
        Added::Added(t) => (StatusCode::CREATED, t),
    };
    Ok((
        status,
        Json(serialized(&s, &p, &headers, "SetTag", tag, true).await?),
    )
        .into_response())
}

async fn tag_delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((id, name)): Path<(i64, String)>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    editable_set(&s, &p, id, "tagging").await?;
    let name = name.to_lowercase();
    let tag = tag_id(&s, &name)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if !remove_tag(&s, id, tag, &name).await? {
        return Err(ApiError::not_found("The image set does not have this tag."));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

fn text_of(v: &Value) -> String {
    match v {
        Value::String(t) => t.clone(),
        o => o.to_string(),
    }
}

fn parse_error() -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, "Malformed request.")
}

// ---------------------------------------------------------------------------------------------------------
// products of a set
// ---------------------------------------------------------------------------------------------------------

async fn product_exists(s: &AppState, id: i64) -> ApiResult<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM administration_product WHERE id = $1)")
        .bind(id)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)
}

/// `false` if the set had the product already.
async fn add_product(s: &AppState, set: i64, product: i64) -> ApiResult<bool> {
    let n = sqlx::query(
        "INSERT INTO administration_product_imagesets (product_id, imageset_id) \
         SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM administration_product_imagesets WHERE product_id = $1 AND imageset_id = $2)",
    )
    .bind(product)
    .bind(set)
    .execute(&s.pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(n > 0)
}

async fn remove_product(s: &AppState, set: i64, product: i64) -> ApiResult<bool> {
    let n = sqlx::query(
        "DELETE FROM administration_product_imagesets WHERE product_id = $1 AND imageset_id = $2",
    )
    .bind(product)
    .bind(set)
    .execute(&s.pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    Ok(n > 0)
}

async fn legacy_product_add(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    let set = int(d.get("image_set_id")).ok_or_else(parse_error)?;
    let product = int(d.get("product_id")).ok_or_else(parse_error)?;
    editable_set(&s, &p, set, "adding a product to").await?;
    if !product_exists(&s, product).await? {
        return Err(ApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "Server error.",
        ));
    }
    if !add_product(&s, set, product).await? {
        return Ok(Json(json!({"detail": "imageset has the product already."})).into_response());
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({"detail": "added a product to the imageset.", "product": serialized(&s, &p, &headers, "Product", product, false).await?})),
    )
        .into_response())
}

async fn legacy_product_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let d = object(&body)?;
    let set = int(d.get("image_set_id")).ok_or_else(parse_error)?;
    let product = int(d.get("product_id")).ok_or_else(parse_error)?;
    if !product_exists(&s, product).await? {
        return Err(ApiError::not_found("No Product matches the given query."));
    }
    editable_set(&s, &p, set, "removing products for").await?;
    let shown = serialized(&s, &p, &headers, "Product", product, false).await?;
    if !remove_product(&s, set, product).await? {
        return Ok(Json(json!({"detail": "product not in imageset tags"})).into_response());
    }
    Ok((
        StatusCode::CREATED,
        Json(json!({"detail": "removed the product.", "product": shown})),
    )
        .into_response())
}

async fn set_product_add_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((id, pid)): Path<(i64, i64)>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PUT).await?)?;
    editable_set(&s, &p, id, "editing").await?;
    if !product_exists(&s, pid).await? {
        return Err(ApiError::not_found("Product does not exist."));
    }
    add_product(&s, id, pid).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn set_product_delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((id, pid)): Path<(i64, i64)>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    editable_set(&s, &p, id, "editing").await?;
    if !remove_product(&s, id, pid).await? {
        return Err(ApiError::not_found(
            "The image set does not have this product.",
        ));
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------------------------------------
// annotation types
// ---------------------------------------------------------------------------------------------------------

struct TypeFields {
    name: Option<String>,
    active: Option<bool>,
    node_count: Option<i32>,
    vector_type: Option<i32>,
    color_code: Option<String>,
    sort_order: Option<i32>,
    enable_blurred: Option<bool>,
    enable_concealed: Option<bool>,
    default_width: Option<f64>,
    default_height: Option<f64>,
    size_unit: Option<String>,
    product: Option<Option<i64>>,
    closed: Option<bool>,
    area_hit_test: Option<bool>,
    multi_frame: Option<bool>,
}

fn float(v: Option<&Value>) -> Result<Option<f64>, ()> {
    match v {
        None => Ok(None),
        Some(Value::Number(n)) => n.as_f64().map(Some).ok_or(()),
        Some(Value::String(t)) => t.trim().parse().map(Some).map_err(|_| ()),
        Some(_) => Err(()),
    }
}

fn type_fields(d: &Map<String, Value>) -> ApiResult<TypeFields> {
    let name = match d.get("name") {
        None => None,
        Some(Value::String(t)) if !t.trim().is_empty() && t.chars().count() <= 50 => {
            Some(t.clone())
        }
        Some(_) => {
            return Err(field_err(
                "name",
                "A name of 1 to 50 characters is required.",
            ))
        }
    };
    let vector_type = match d.get("vector_type") {
        None => None,
        Some(v) => match int(Some(v)) {
            Some(t @ 1..=8) => Some(t as i32),
            _ => return Err(field_err("vector_type", "Must be one of 1 to 8.")),
        },
    };
    let size_unit = match d.get("size_unit") {
        None => None,
        Some(Value::String(t)) if ["px", "mm", "um"].contains(&t.as_str()) => Some(t.clone()),
        Some(_) => return Err(field_err("size_unit", "Must be px, mm or um.")),
    };
    let color_code = match d.get("color_code") {
        None => None,
        Some(Value::String(t)) if t.chars().count() <= 10 => Some(t.clone()),
        Some(_) => return Err(field_err("color_code", "A color like #ff0000 is required.")),
    };
    let w = float(d.get("default_width"))
        .map_err(|_| field_err("default_width", "A number is required."))?;
    let h = float(d.get("default_height"))
        .map_err(|_| field_err("default_height", "A number is required."))?;
    Ok(TypeFields {
        name,
        active: flag(d.get("active")),
        node_count: int(d.get("node_count")).map(|v| v as i32),
        vector_type,
        color_code,
        sort_order: int(d.get("sort_order")).map(|v| v as i32),
        enable_blurred: flag(d.get("enable_blurred")),
        enable_concealed: flag(d.get("enable_concealed")),
        default_width: w,
        default_height: h,
        size_unit,
        product: d
            .get("product")
            .or_else(|| d.get("product_id"))
            .map(|v| int(Some(v))),
        closed: flag(d.get("closed")),
        area_hit_test: flag(d.get("area_hit_test")),
        multi_frame: flag(d.get("multi_frame")),
    })
}

async fn check_product(s: &AppState, f: &TypeFields) -> ApiResult<()> {
    if let Some(Some(id)) = f.product {
        if !product_exists(s, id).await? {
            return Err(field_err("product", "Product does not exist."));
        }
    }
    Ok(())
}

async fn insert_type(s: &AppState, f: TypeFields) -> ApiResult<i64> {
    sqlx::query_scalar(
        "INSERT INTO annotations_annotationtype (name, active, node_count, vector_type, enable_blurred, enable_concealed, \
         color_code, default_height, default_width, sort_order, closed, product_id, area_hit_test, multi_frame, size_unit) \
         VALUES ($1, COALESCE($2, true), COALESCE($3, 0), COALESCE($4, 1), COALESCE($5, false), COALESCE($6, false), \
         COALESCE($7, '#000000'), COALESCE($8, 50), COALESCE($9, 50), COALESCE($10, 0), COALESCE($11, true), $12, \
         COALESCE($13, true), COALESCE($14, false), COALESCE($15, 'px')) RETURNING id",
    )
    .bind(f.name)
    .bind(f.active)
    .bind(f.node_count)
    .bind(f.vector_type)
    .bind(f.enable_blurred)
    .bind(f.enable_concealed)
    .bind(f.color_code)
    .bind(f.default_height)
    .bind(f.default_width)
    .bind(f.sort_order)
    .bind(f.closed)
    .bind(f.product.flatten())
    .bind(f.area_hit_test)
    .bind(f.multi_frame)
    .bind(f.size_unit)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)
}

/// Rows that protect an annotation type from deletion (`on_delete=PROTECT`).
async fn type_usage(s: &AppState, id: i64) -> ApiResult<i64> {
    sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM annotations_annotation WHERE annotation_type_id = $1) \
              + (SELECT count(*) FROM annotations_annotationversion WHERE annotation_type_id = $1) \
              + (SELECT count(*) FROM processing_pluginresultannotation WHERE annotation_type_id = $1)",
    )
    .bind(id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)
}

async fn delete_type(s: &AppState, id: i64) -> ApiResult<()> {
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    cascade::delete_rows(&mut tx, "annotations_annotationtype", &[id]).await?;
    tx.commit().await.map_err(db_err)
}

/// exact-sync: `{"name", "vector_type", "product_id", ...}`; answers `{"annotationType": {...}}`.
async fn legacy_type_create(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::POST).await?,
        &Method::POST,
        "annotations",
        "annotationtype",
    )
    .await?;
    let d = object(&body)?;
    let mut f = type_fields(&d)?;
    if f.name.is_none() {
        return Err(parse_error());
    }
    // Django reads `sort_order` from `enable_concealed` (a long-standing typo); the field is not taken from the body
    f.sort_order = int(d.get("enable_concealed")).or(Some(0)).map(|v| v as i32);
    f.enable_concealed = None;
    if f.product.is_none() {
        f.product = Some(Some(1));
    }
    check_product(&s, &f).await?;
    let id = insert_type(&s, f).await?;
    let t = serialized(&s, &p, &headers, "AnnotationType", id, false).await?;
    let pick = |k: &str| t.get(k).cloned().unwrap_or(Value::Null);
    Ok((
        StatusCode::CREATED,
        Json(json!({"annotationType": {
            "id": pick("id"), "closed": pick("closed"), "name": pick("name"), "vector_type": pick("vector_type"),
            "color_code": pick("color_code"), "multi_frame": pick("multi_frame"), "area_hit_test": pick("area_hit_test"),
        }})),
    )
        .into_response())
}

/// `POST {"annotation_type_id"}`: superuser only, and only if no annotation uses the type.
async fn legacy_type_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    let id = int(d.get("annotation_type_id")).ok_or_else(parse_error)?;
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM annotations_annotationtype WHERE id = $1)",
    )
    .bind(id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if !exists {
        return Err(ApiError::not_found(
            "No AnnotationType matches the given query.",
        ));
    }
    let used: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM annotations_annotation WHERE annotation_type_id = $1",
    )
    .bind(id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if used > 0 {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            format!("Annotation type is being used. Currently {used} annotations with this type."),
        ));
    }
    if !p.user.is_superuser {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for deleting the annotation type is missing.",
        ));
    }
    if type_usage(&s, id).await? > 0 {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "Annotation type is referenced by versions or results.",
        ));
    }
    delete_type(&s, id).await?;
    Ok(Json(json!({"detail": "OK"})).into_response())
}

pub async fn type_create_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::POST).await?,
        &Method::POST,
        "annotations",
        "annotationtype",
    )
    .await?;
    let f = type_fields(&object(&body)?)?;
    if f.name.is_none() {
        return Err(field_err("name", "This field is required."));
    }
    check_product(&s, &f).await?;
    let id = insert_type(&s, f).await?;
    Ok((
        StatusCode::CREATED,
        Json(serialized(&s, &p, &headers, "AnnotationType", id, true).await?),
    )
        .into_response())
}

pub async fn type_patch_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::PATCH).await?,
        &Method::PATCH,
        "annotations",
        "annotationtype",
    )
    .await?;
    let f = type_fields(&object(&body)?)?;
    check_product(&s, &f).await?;
    let n = sqlx::query(
        "UPDATE annotations_annotationtype SET name = COALESCE($2, name), active = COALESCE($3, active), \
         node_count = COALESCE($4, node_count), enable_blurred = COALESCE($5, enable_blurred), \
         enable_concealed = COALESCE($6, enable_concealed), color_code = COALESCE($7, color_code), \
         default_height = COALESCE($8, default_height), default_width = COALESCE($9, default_width), \
         sort_order = COALESCE($10, sort_order), closed = COALESCE($11, closed), \
         product_id = CASE WHEN $12 THEN $13 ELSE product_id END, area_hit_test = COALESCE($14, area_hit_test), \
         multi_frame = COALESCE($15, multi_frame), size_unit = COALESCE($16, size_unit) WHERE id = $1",
    )
    .bind(id)
    .bind(f.name)
    .bind(f.active)
    .bind(f.node_count)
    .bind(f.enable_blurred)
    .bind(f.enable_concealed)
    .bind(f.color_code)
    .bind(f.default_height)
    .bind(f.default_width)
    .bind(f.sort_order)
    .bind(f.closed)
    .bind(f.product.is_some())
    .bind(f.product.flatten())
    .bind(f.area_hit_test)
    .bind(f.multi_frame)
    .bind(f.size_unit)
    .execute(&s.pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    if n == 0 {
        return Err(ApiError::not_found("Not found."));
    }
    // the vector type of a type in use cannot change: annotations hold vectors of that shape
    if f.vector_type.is_some() && type_usage(&s, id).await? == 0 {
        sqlx::query("UPDATE annotations_annotationtype SET vector_type = $2 WHERE id = $1")
            .bind(id)
            .bind(f.vector_type)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
    } else if f.vector_type.is_some() {
        return Err(field_err(
            "vector_type",
            "The vector type of a type that is in use cannot be changed.",
        ));
    }
    Ok(Json(serialized(&s, &p, &headers, "AnnotationType", id, true).await?).into_response())
}

pub async fn type_delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::DELETE).await?,
        &Method::DELETE,
        "annotations",
        "annotationtype",
    )
    .await?;
    let used = type_usage(&s, id).await?;
    if used > 0 {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            format!("The annotation type is used by {used} annotations, versions or results."),
        ));
    }
    let exists: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM annotations_annotationtype WHERE id = $1)",
    )
    .bind(id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if !exists {
        return Err(ApiError::not_found("Not found."));
    }
    delete_type(&s, id).await?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------------------------------------
// products
// ---------------------------------------------------------------------------------------------------------

pub async fn product_create_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::POST).await?,
        &Method::POST,
        "administration",
        "product",
    )
    .await?;
    let d = object(&body)?;
    let name = match d.get("name") {
        Some(Value::String(t)) if !t.trim().is_empty() && t.chars().count() <= 100 => t.clone(),
        Some(_) => {
            return Err(field_err(
                "name",
                "A name of 1 to 100 characters is required.",
            ))
        }
        None => return Err(field_err("name", "This field is required.")),
    };
    let team = int(d.get("team"));
    if let Some(t) = team {
        let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users_team WHERE id = $1)")
            .bind(t)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
        if !ok {
            return Err(field_err("team", "Team does not exist."));
        }
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM administration_product WHERE name = $1 AND team_id IS NOT DISTINCT FROM $2)",
    )
    .bind(&name)
    .bind(team)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if taken {
        return Err(field_err(
            "name",
            "A product with this name exists in the team.",
        ));
    }
    let description = d
        .get("description")
        .and_then(Value::as_str)
        .map(String::from);
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO administration_product (name, description, time, creator_id, team_id) VALUES ($1, $2, now(), $3, $4) RETURNING id",
    )
    .bind(&name)
    .bind(description)
    .bind(p.user.id)
    .bind(team)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    // `copy_product`: the annotation types of another product are copied
    if let Some(src) = int(d.get("copy_product")).filter(|v| *v > 0) {
        sqlx::query(
            "INSERT INTO annotations_annotationtype (name, active, node_count, vector_type, enable_blurred, enable_concealed, \
             color_code, default_height, default_width, sort_order, closed, product_id, area_hit_test, multi_frame, size_unit) \
             SELECT name, active, node_count, vector_type, enable_blurred, enable_concealed, color_code, default_height, \
             default_width, sort_order, closed, $2, area_hit_test, multi_frame, size_unit \
             FROM annotations_annotationtype WHERE product_id = $1 ORDER BY id",
        )
        .bind(src)
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    }
    Ok((
        StatusCode::CREATED,
        Json(serialized(&s, &p, &headers, "Product", id, true).await?),
    )
        .into_response())
}

pub async fn product_patch_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::PATCH).await?,
        &Method::PATCH,
        "administration",
        "product",
    )
    .await?;
    let d = object(&body)?;
    let name = match d.get("name") {
        None => None,
        Some(Value::String(t)) if !t.trim().is_empty() && t.chars().count() <= 100 => {
            Some(t.clone())
        }
        Some(_) => {
            return Err(field_err(
                "name",
                "A name of 1 to 100 characters is required.",
            ))
        }
    };
    let team = d.get("team").map(|v| int(Some(v)));
    if let Some(n) = &name {
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM administration_product o JOIN administration_product me ON me.id = $3 \
             WHERE o.name = $1 AND o.id <> $3 AND o.team_id IS NOT DISTINCT FROM CASE WHEN $2 THEN $4 ELSE me.team_id END)",
        )
        .bind(n)
        .bind(team.is_some())
        .bind(id)
        .bind(team.flatten())
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
        if taken {
            return Err(field_err(
                "name",
                "A product with this name exists in the team.",
            ));
        }
    }
    let description = d.get("description").map(|v| v.as_str().map(String::from));
    let n = sqlx::query(
        "UPDATE administration_product SET name = COALESCE($2, name), \
         description = CASE WHEN $3 THEN $4 ELSE description END, team_id = CASE WHEN $5 THEN $6 ELSE team_id END WHERE id = $1",
    )
    .bind(id)
    .bind(name)
    .bind(description.is_some())
    .bind(description.flatten())
    .bind(team.is_some())
    .bind(team.flatten())
    .execute(&s.pool)
    .await
    .map_err(db_err)?
    .rows_affected();
    if n == 0 {
        return Err(ApiError::not_found("Not found."));
    }
    Ok(Json(serialized(&s, &p, &headers, "Product", id, true).await?).into_response())
}

pub async fn product_delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::DELETE).await?,
        &Method::DELETE,
        "administration",
        "product",
    )
    .await?;
    if !product_exists(&s, id).await? {
        return Err(ApiError::not_found("Not found."));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    cascade::delete_rows(&mut tx, "administration_product", &[id]).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
