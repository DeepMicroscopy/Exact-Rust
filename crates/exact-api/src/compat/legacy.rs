//! Read-only legacy JSON endpoints that `exact-sync` and the old UI call (see PLAN.md §2a).
//! They are not DRF viewsets: each has its own permission logic (`ImageSet.has_perm('read', user)`, collaboration
//! types), reproduced here.

use super::engine::{db_err, serialize_ids, Ctx};
use super::specs;
use crate::{
    auth::{authenticate, require_user, AuthKind, Principal},
    error::{ApiError, ApiResult},
    page::{drf_datetime, Query},
    AppState,
};
use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use chrono::{DateTime, Utc};
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::collections::HashMap;

/// Django's `@api_view` adds an `Allow` header to every response of these endpoints.
macro_rules! allow {
    ($methods:literal) => {
        axum::middleware::map_response(|r: Response| async move {
            crate::error::with_allow(r, $methods)
        })
    };
}

fn write_routes() -> Router<AppState> {
    use super::writes as w;
    Router::new()
        .route(
            "/annotations/api/annotation/create/",
            axum::routing::post(w::create_annotation).layer(allow!("OPTIONS, POST")),
        )
        .route(
            "/annotations/api/annotation/update/",
            axum::routing::post(w::update_annotation).layer(allow!("OPTIONS, POST")),
        )
        .route(
            "/annotations/api/annotation/verify/",
            axum::routing::post(w::verify_annotation).layer(allow!("OPTIONS, POST")),
        )
        .route(
            "/annotations/api/annotation/blurred_concealed/",
            axum::routing::post(w::blurred_concealed).layer(allow!("OPTIONS, POST")),
        )
        .route(
            "/annotations/api/annotation/delete/",
            axum::routing::delete(w::delete_annotation).layer(allow!("OPTIONS, DELETE")),
        )
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/images/api/list_imagesets/",
            get(list_imagesets)
                .post(list_imagesets)
                .layer(allow!("OPTIONS, POST, GET")),
        )
        .route(
            "/images/api/imageset/load/",
            get(load_image_set).layer(allow!("OPTIONS, GET")),
        )
        .route(
            "/images/api/imageset/load",
            get(load_image_set).layer(allow!("OPTIONS, GET")),
        ) // exact-sync omits the slash (Django redirects)
        .route(
            "/annotations/api/annotation/load/",
            get(load_annotations).layer(allow!("OPTIONS, GET")),
        )
        .route(
            "/annotations/api/annotation/loadannotationtypes/",
            get(load_annotation_types).layer(allow!("OPTIONS, GET")),
        )
        .merge(write_routes())
        .route(
            "/users/api/team/filter/",
            get(filter_teams).layer(allow!("OPTIONS, GET")),
        )
}

pub(super) fn parse_error() -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, "Malformed request.")
}

pub(super) fn forbidden_set() -> ApiError {
    ApiError::detail(
        StatusCode::FORBIDDEN,
        "permission for reading this image set missing.",
    )
}

fn ctx<'a>(s: &'a AppState, p: &Principal, headers: &HeaderMap) -> Ctx<'a> {
    Ctx {
        s,
        viewer: p.viewer(),
        host: headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string(),
        v2: false,
    }
}

/// Authentication of a write endpoint: the method matters for CSRF (sessions) and read-only tokens.
pub(super) async fn login_write(
    s: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> ApiResult<Principal> {
    require_user(authenticate(s, headers, method).await?)
}

pub(super) fn not_found_msg(model: &str) -> ApiError {
    ApiError::not_found(format!("No {model} matches the given query."))
}

pub(super) fn rest_ctx<'a>(s: &'a AppState, p: &Principal, headers: &HeaderMap) -> Ctx<'a> {
    ctx(s, p, headers)
}

pub(super) async fn login(s: &AppState, headers: &HeaderMap) -> ApiResult<Principal> {
    require_user(authenticate(s, headers, &Method::GET).await?)
}

struct SetInfo {
    team_id: Option<i64>,
    creator_id: Option<i64>,
    public: bool,
    collaboration_type: i32,
}

async fn set_info(s: &AppState, id: i64) -> ApiResult<SetInfo> {
    let r = sqlx::query(
        "SELECT team_id, creator_id, public, collaboration_type FROM images_imageset WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    let r = r.ok_or_else(|| ApiError::not_found("No ImageSet matches the given query."))?;
    Ok(SetInfo {
        team_id: r.get(0),
        creator_id: r.get(1),
        public: r.get(2),
        collaboration_type: r.get(3),
    })
}

/// `ImageSet.has_perm('read', user)`
async fn can_read(s: &AppState, p: &Principal, info: &SetInfo) -> ApiResult<bool> {
    if let (Some(team), AuthKind::Token(scope)) = (info.team_id, &p.kind) {
        if scope.team_ids.as_ref().is_some_and(|t| !t.contains(&team)) {
            return Ok(false); // token restricted to other teams: no permissions at all
        }
    }
    if let Some(team) = info.team_id {
        let member: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users_teammembership WHERE team_id = $1 AND user_id = $2)").bind(team).bind(p.user.id).fetch_one(&s.pool).await.map_err(db_err)?;
        if member || info.creator_id == Some(p.user.id) {
            return Ok(true);
        }
    }
    Ok(info.public)
}

pub async fn can_read_set(s: &AppState, p: &Principal, set_id: i64) -> ApiResult<bool> {
    let info = set_info(s, set_id).await?;
    can_read(s, p, &info).await
}

fn at_json(r: &sqlx::postgres::PgRow, off: usize) -> Value {
    json!({"id": r.get::<i64, _>(off), "closed": r.get::<bool, _>(off + 1), "name": r.get::<String, _>(off + 2), "vector_type": r.get::<i32, _>(off + 3),
           "color_code": r.get::<String, _>(off + 4), "multi_frame": r.get::<bool, _>(off + 5), "area_hit_test": r.get::<bool, _>(off + 6)})
}

const AT_COLS: &str = "id, closed, name, vector_type, color_code, multi_frame, area_hit_test";

/// `serialize_imageset` of `images/serializers.py`
pub(crate) async fn serialize_imagesets(s: &AppState, ids: &[i64]) -> ApiResult<Vec<Value>> {
    let sets = sqlx::query("SELECT s.id, s.name, s.location, s.description, s.team_id, t.name, s.main_annotation_type_id FROM images_imageset s LEFT JOIN users_team t ON t.id = s.team_id WHERE s.id = ANY($1)")
        .bind(ids)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    let imgs = sqlx::query("SELECT image_set_id, id, name, height, width, mpp, \"objectivePower\", image_type FROM images_image WHERE image_set_id = ANY($1) ORDER BY id").bind(ids).fetch_all(&s.pool).await.map_err(db_err)?;
    let mut images: HashMap<i64, Vec<Value>> = HashMap::new();
    for r in imgs {
        images.entry(r.get(0)).or_default().push(json!({"id": r.get::<i64, _>(1), "name": r.get::<String, _>(2), "height": r.get::<i32, _>(3), "width": r.get::<i32, _>(4),
            "mpp": r.get::<f64, _>(5), "objectivePower": r.get::<f64, _>(6), "image_type": r.get::<i32, _>(7)}));
    }
    let prods = sqlx::query("SELECT ap.imageset_id, p.id, p.name FROM administration_product_imagesets ap JOIN administration_product p ON p.id = ap.product_id WHERE ap.imageset_id = ANY($1) ORDER BY p.id").bind(ids).fetch_all(&s.pool).await.map_err(db_err)?;
    let pids: Vec<i64> = prods.iter().map(|r| r.get::<i64, _>(1)).collect();
    let ats = sqlx::query(&format!("SELECT product_id, {AT_COLS} FROM annotations_annotationtype WHERE product_id = ANY($1) ORDER BY id")).bind(&pids).fetch_all(&s.pool).await.map_err(db_err)?;
    let mut at_by_product: HashMap<i64, Vec<Value>> = HashMap::new();
    for r in &ats {
        at_by_product
            .entry(r.get(0))
            .or_default()
            .push(at_json(r, 1));
    }
    let mut products: HashMap<i64, Vec<Value>> = HashMap::new();
    for r in prods {
        let pid: i64 = r.get(1);
        products.entry(r.get(0)).or_default().push(json!({"name": r.get::<String, _>(2), "id": pid, "annotation_types": at_by_product.get(&pid).cloned().unwrap_or_default()}));
    }
    let tags = sqlx::query("SELECT si.imageset_id, t.id, t.name FROM images_settag_imagesets si JOIN images_settag t ON t.id = si.settag_id WHERE si.imageset_id = ANY($1) ORDER BY t.id").bind(ids).fetch_all(&s.pool).await.map_err(db_err)?;
    let mut tag_map: HashMap<i64, Vec<Value>> = HashMap::new();
    for r in tags {
        tag_map
            .entry(r.get(0))
            .or_default()
            .push(json!({"name": r.get::<String, _>(2), "id": r.get::<i64, _>(1)}));
    }
    let main_ids: Vec<i64> = sets
        .iter()
        .filter_map(|r| r.get::<Option<i64>, _>(6))
        .collect();
    let mains = sqlx::query(&format!(
        "SELECT {AT_COLS} FROM annotations_annotationtype WHERE id = ANY($1)"
    ))
    .bind(&main_ids)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let main_map: HashMap<i64, Value> = mains
        .iter()
        .map(|r| (r.get::<i64, _>(0), at_json(r, 0)))
        .collect();
    let mut by_id: HashMap<i64, Value> = HashMap::new();
    for r in sets {
        let id: i64 = r.get(0);
        let team = r
            .get::<Option<i64>, _>(4)
            .map(|t| json!({"id": t, "name": r.get::<Option<String>, _>(5)}))
            .unwrap_or(Value::Null);
        by_id.insert(id, json!({
            "id": id, "name": r.get::<String, _>(1), "location": r.get::<Option<String>, _>(2), "description": r.get::<Option<String>, _>(3),
            "team": team, "images": images.remove(&id).unwrap_or_default(), "products": products.remove(&id).unwrap_or_default(),
            "tags": tag_map.remove(&id).unwrap_or_default(),
            "main_annotation_type": r.get::<Option<i64>, _>(6).and_then(|m| main_map.get(&m).cloned()).unwrap_or(Value::Null),
        }));
    }
    Ok(ids.iter().filter_map(|i| by_id.remove(i)).collect())
}

pub(super) fn body_json(body: &Bytes) -> Map<String, Value> {
    serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|v| {
            if let Value::Object(m) = v {
                Some(m)
            } else {
                None
            }
        })
        .unwrap_or_default()
}

/// `GET|POST /images/api/list_imagesets/`: filters come from the request *body* (DRF `request.data`).
async fn list_imagesets(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Json<Value>> {
    let p = login(&s, &headers).await?;
    let d = body_json(&body);
    let mut q = sqlx::QueryBuilder::new("SELECT s.id FROM images_imageset s WHERE s.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = ");
    q.push_bind(p.user.id).push(")");
    if let Some(id) = d.get("id").and_then(Value::as_i64).filter(|i| *i > 0) {
        q.push(" AND s.id = ").push_bind(id);
    }
    if let Some(t) = d
        .get("team")
        .and_then(|t| t.get("id"))
        .and_then(Value::as_i64)
    {
        q.push(" AND s.team_id = ").push_bind(t);
    }
    if let Some(n) = d.get("name").and_then(Value::as_str) {
        q.push(" AND s.name LIKE ")
            .push_bind(format!(
                "%{}%",
                n.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            ))
            .push(" ESCAPE '\\'");
    }
    if let Some(n) = d.get("description").and_then(Value::as_str) {
        q.push(" AND s.description LIKE ")
            .push_bind(format!(
                "%{}%",
                n.replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_")
            ))
            .push(" ESCAPE '\\'");
    }
    if let Some(b) = d.get("public").and_then(Value::as_bool) {
        q.push(" AND s.public = ").push_bind(b);
    }
    q.push(" ORDER BY s.priority DESC, s.time DESC, s.id DESC");
    let ids: Vec<i64> = q
        .build_query_scalar()
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(Json(Value::Array(serialize_imagesets(&s, &ids).await?)))
}

async fn load_image_set(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Json<Value>> {
    let p = login(&s, &headers).await?;
    let q = Query::parse(uri.query());
    let set_id: i64 = q
        .get("image_set_id")
        .and_then(|v| v.parse().ok())
        .ok_or_else(parse_error)?;
    let info = set_info(&s, set_id).await?;
    if !can_read(&s, &p, &info).await? {
        return Err(forbidden_set());
    }
    let mut set = serialize_imagesets(&s, &[set_id])
        .await?
        .pop()
        .unwrap_or(Value::Null);
    let filter = q.get("filter_annotation_type_id");
    let active_ann = "annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id WHERE a.image_id = i.id AND NOT a.deleted AND at.active";
    let base = "SELECT i.id FROM images_image i WHERE i.image_set_id = $1";
    let sql = match filter {
        Some(f) if !f.is_empty() && f.chars().all(|c| c.is_ascii_digit()) => format!("{base} AND EXISTS (SELECT 1 FROM {active_ann} AND at.id = {f}) ORDER BY i.name, i.id"),
        Some("Unverified") => unverified_sql(info.collaboration_type, p.user.id),
        Some("Verified") => verified_sql(info.collaboration_type, p.user.id),
        Some("NoAnnotations") => format!("{base} AND NOT EXISTS (SELECT 1 FROM annotations_annotation a WHERE a.image_id = i.id) ORDER BY i.name, i.id"),
        Some("ComputerGenerated") => format!("{base} AND i.image_type = 1 ORDER BY i.name, i.id"),
        _ => format!("{base} ORDER BY i.name, i.id"),
    };
    let ids: Vec<i64> = sqlx::query_scalar(&sql)
        .bind(set_id)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    set["images"] = Value::Array(serialize_ids(&ctx(&s, &p, &headers), &specs::IMAGE, &ids).await?);
    Ok(Json(json!({"image_set": set})))
}

fn verified_sql(collab: i32, user: i64) -> String {
    let live = "annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id";
    match collab {
        1 => format!(
            "SELECT i.id FROM images_image i WHERE i.image_set_id = $1 AND EXISTS (SELECT 1 FROM {live} JOIN annotations_verification v ON v.annotation_id = a.id WHERE a.image_id = i.id AND at.active AND NOT a.deleted AND v.verified AND a.user_id = {user})
             AND NOT EXISTS (SELECT 1 FROM {live} JOIN annotations_verification v ON v.annotation_id = a.id WHERE a.image_id = i.id AND at.active AND NOT a.deleted AND NOT v.verified AND a.user_id = {user}) ORDER BY i.name, i.id"
        ),
        _ => format!("SELECT i.id FROM images_image i WHERE i.image_set_id = $1 AND EXISTS (SELECT 1 FROM {live} JOIN annotations_verification v ON v.annotation_id = a.id WHERE a.image_id = i.id AND at.active AND NOT a.deleted AND v.verified) ORDER BY i.name, i.id"),
    }
}

fn unverified_sql(collab: i32, user: i64) -> String {
    let live = "annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id";
    if collab == 1 {
        format!(
            "SELECT i.id FROM images_image i WHERE i.image_set_id = $1 AND (
               EXISTS (SELECT 1 FROM {live} LEFT JOIN annotations_verification v ON v.annotation_id = a.id WHERE a.image_id = i.id AND at.active AND NOT a.deleted AND a.user_id = {user} AND (v.id IS NULL OR NOT v.verified))
               OR NOT EXISTS (SELECT 1 FROM annotations_annotation a WHERE a.image_id = i.id AND a.user_id = {user})) ORDER BY i.name, i.id"
        )
    } else {
        format!(
            "SELECT i.id FROM images_image i WHERE i.image_set_id = $1 AND (
               EXISTS (SELECT 1 FROM {live} LEFT JOIN annotations_verification v ON v.annotation_id = a.id WHERE a.image_id = i.id AND at.active AND NOT a.deleted AND (v.id IS NULL OR NOT v.verified))
               OR NOT EXISTS (SELECT 1 FROM annotations_annotation a WHERE a.image_id = i.id)) ORDER BY i.name, i.id"
        )
    }
}

fn dt(v: Option<DateTime<Utc>>, s: &AppState) -> Value {
    drf_datetime(v, s.tz)
}

/// `GET /annotations/api/annotation/load/` (deprecated in Django, still used by exact-sync)
async fn load_annotations(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Json<Value>> {
    let p = login(&s, &headers).await?;
    let q = Query::parse(uri.query());
    let image_id: i64 = q
        .get("image_id")
        .and_then(|v| v.parse().ok())
        .ok_or_else(parse_error)?;
    let int = |k: &str| -> ApiResult<Option<i64>> {
        q.get(k)
            .map(|v| v.parse().map_err(|_| parse_error()))
            .transpose()
    };
    let (since, min_x, max_x, min_y, max_y, vtype) = (
        int("since")?,
        int("min_x")?,
        int("max_x")?,
        int("min_y")?,
        int("max_y")?,
        int("vector_type")?,
    );
    let include_deleted = q.get("include_deleted").is_some_and(|v| !v.is_empty()); // Python bool(str)
    let set_id: i64 = sqlx::query_scalar("SELECT image_set_id FROM images_image WHERE id = $1")
        .bind(image_id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    let info = set_info(&s, set_id).await?;
    if !can_read(&s, &p, &info).await? {
        return Err(forbidden_set());
    }
    let mut qb = sqlx::QueryBuilder::new("SELECT a.id FROM annotations_annotation a JOIN annotations_annotationtype at ON at.id = a.annotation_type_id WHERE a.image_id = ");
    qb.push_bind(image_id).push(" AND at.active");
    if info.collaboration_type == 1 {
        qb.push(" AND a.user_id = ").push_bind(p.user.id);
    }
    if !include_deleted {
        qb.push(" AND NOT a.deleted");
    }
    if let Some(v) = vtype {
        qb.push(" AND at.vector_type = ").push_bind(v);
    }
    if let Some(t) = since {
        qb.push(" AND a.last_edit_time >= to_timestamp(")
            .push_bind(t)
            .push(") AND NOT COALESCE((SELECT username = ")
            .push_bind(p.user.username.clone())
            .push(" FROM users_user WHERE id = a.last_editor_id), false)");
    }
    if let (Some(x), Some(y)) = (min_x, min_y) {
        qb.push(" AND (a.vector -> 'x1') >= to_jsonb(")
            .push_bind(x)
            .push("::bigint) AND (a.vector -> 'y1') >= to_jsonb(")
            .push_bind(y)
            .push("::bigint)");
    }
    if let (Some(x), Some(y)) = (max_x, max_y) {
        qb.push(" AND (a.vector -> 'x1') < to_jsonb(")
            .push_bind(x)
            .push("::bigint) AND (a.vector -> 'y1') < to_jsonb(")
            .push_bind(y)
            .push("::bigint)");
    }
    qb.push(" ORDER BY a.id");
    let ids: Vec<i64> = qb
        .build_query_scalar()
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(Json(
        json!({"annotations": serialize_annotations(&s, &ids).await?}),
    ))
}

/// `serialize_annotation` of `annotations/serializers.py`
pub(super) async fn serialize_annotations(s: &AppState, ids: &[i64]) -> ApiResult<Vec<Value>> {
    let rows = sqlx::query(
        "SELECT a.id, a.vector, a.last_edit_time, a.deleted, a.description, a.unique_identifier::text, a.meta_data, a.annotation_type_id, a.image_id, i.name,
                a.last_editor_id, le.username, a.user_id, u.username
           FROM annotations_annotation a JOIN images_image i ON i.id = a.image_id LEFT JOIN users_user le ON le.id = a.last_editor_id LEFT JOIN users_user u ON u.id = a.user_id
          WHERE a.id = ANY($1) ORDER BY a.id",
    )
    .bind(ids)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let tids: Vec<i64> = rows.iter().map(|r| r.get::<i64, _>(7)).collect();
    let ats = sqlx::query(&format!(
        "SELECT {AT_COLS} FROM annotations_annotationtype WHERE id = ANY($1)"
    ))
    .bind(&tids)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let at_map: HashMap<i64, Value> = ats
        .iter()
        .map(|r| (r.get::<i64, _>(0), at_json(r, 0)))
        .collect();
    let media = sqlx::query("SELECT annotation_id, id, name, file, media_file_type FROM annotations_annotationmediafile WHERE annotation_id = ANY($1) ORDER BY id").bind(ids).fetch_all(&s.pool).await.map_err(db_err)?;
    let mut media_map: HashMap<i64, Vec<Value>> = HashMap::new();
    for r in media {
        let file: Option<String> = r.get(3);
        media_map.entry(r.get(0)).or_default().push(json!({"name": r.get::<String, _>(2), "id": r.get::<i64, _>(1), "file": file.map(|f| format!("/media/{f}")), "media_file_type": r.get::<i32, _>(4)}));
    }
    let verified: Vec<i64> = sqlx::query_scalar("SELECT DISTINCT annotation_id FROM annotations_verification WHERE verified AND annotation_id = ANY($1)").bind(ids).fetch_all(&s.pool).await.map_err(db_err)?;
    Ok(rows
        .iter()
        .map(|r| {
            let id: i64 = r.get(0);
            let (editor_id, editor_name): (Option<i64>, Option<String>) = (r.get(10), r.get(11));
            let (first_id, first_name): (Option<i64>, Option<String>) = (r.get(12), r.get(13));
            json!({
                "id": id, "vector": r.get::<Option<Value>, _>(1), "last_edit_time": dt(r.get(2), s), "deleted": r.get::<bool, _>(3),
                "description": r.get::<String, _>(4), "unique_identifier": r.get::<String, _>(5),
                "annotation_type": at_map.get(&r.get::<i64, _>(7)).cloned().unwrap_or(Value::Null),
                "media_files": media_map.get(&id).cloned().unwrap_or_default(),
                "image": {"id": r.get::<i64, _>(8), "name": r.get::<String, _>(9)},
                "last_editor": {"id": editor_id.or(first_id), "name": editor_name.or(first_name.clone())},
                "first_editor": {"id": first_id, "name": first_name},
                "is_verified": verified.contains(&id),
                "meta_data": r.get::<Option<Value>, _>(6),
            })
        })
        .collect())
}

/// `GET /annotations/api/annotation/loadannotationtypes/`. Without `imageset_id` this returns the active
/// annotation types of *all* teams, as in Django.
async fn load_annotation_types(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Json<Value>> {
    let p = login(&s, &headers).await?;
    let q = Query::parse(uri.query());
    let ids: Vec<i64> = if let Some(raw) = q.get("imageset_id") {
        let set_id: i64 = raw
            .parse()
            .map_err(|_| ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, "Server error."))?;
        let info = set_info(&s, set_id).await?;
        let ids = sqlx::query_scalar(
            "SELECT t.id FROM annotations_annotationtype t WHERE t.active AND t.product_id IN (SELECT product_id FROM administration_product_imagesets WHERE imageset_id = $1) ORDER BY t.sort_order, t.id",
        )
        .bind(set_id)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
        if !can_read(&s, &p, &info).await? {
            return Err(forbidden_set());
        }
        ids
    } else {
        sqlx::query_scalar(
            "SELECT id FROM annotations_annotationtype WHERE active ORDER BY sort_order, id",
        )
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?
    };
    let types = serialize_ids(&ctx(&s, &p, &headers), &specs::ANNOTATION_TYPE, &ids).await?;
    Ok(Json(json!({"annotation_types": types})))
}

/// `GET /users/api/team/filter/`: Django reads its filters from the request body, which GET requests do not have,
/// so effectively this lists the user's teams (plain membership, not narrowed by token scope).
async fn filter_teams(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = login(&s, &headers).await?;
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT team_id FROM users_teammembership WHERE user_id = $1 ORDER BY team_id",
    )
    .bind(p.user.id)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(Value::Array(
        serialize_ids(&ctx(&s, &p, &headers), &specs::TEAM, &ids).await?,
    ))
    .into_response())
}
