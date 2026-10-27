//! `/api/v2` read endpoints over the shared resource engine: `GET /api/v2/{resource}` and `/{resource}/{id}`.
//!
//! Differences to v1 (PLAN.md §2a): keyset (cursor) pagination ordered by id, RFC 3339 UTC timestamps,
//! snake_case field names, no trailing slashes, processing data scoped to the viewer's teams.

use super::{annotation_writes, catalog, image_sets};
use crate::{
    auth::{authenticate, require_model_perm},
    compat::{
        engine::{flex_to_engine, list_v2, Ctx},
        specs,
    },
    error::{ApiError, ApiResult},
    page::{Flex, Query},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    routing::get,
    Json, Router,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde_json::{json, Value};

const MAX_LIMIT: i64 = 1000;
const DEFAULT_LIMIT: i64 = 50;

/// v2 resource name → engine spec.
pub const RESOURCES: &[(&str, &str)] = &[
    ("users", "User"),
    ("teams", "Team"),
    ("team-memberships", "TeamMembership"),
    ("images", "Image"),
    ("image-sets", "ImageSet"),
    ("set-tags", "SetTag"),
    ("set-versions", "SetVersion"),
    ("screening-modes", "ScreeningMode"),
    ("registrations", "ImageRegistration"),
    ("annotations", "Annotation"),
    ("annotation-versions", "AnnotationVersion"),
    ("annotation-types", "AnnotationType"),
    ("annotation-media-files", "AnnotationMediaFile"),
    ("verifications", "Verification"),
    ("action-logs", "LogImageAction"),
    ("products", "Product"),
    ("plugins", "Plugin"),
    ("plugin-jobs", "PluginJob"),
    ("plugin-results", "PluginResult"),
    ("plugin-result-entries", "PluginResultEntry"),
    ("plugin-result-annotations", "PluginResultAnnotation"),
    ("plugin-result-bitmaps", "PluginResultBitmap"),
];

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/annotations",
            get(annotations_list).post(annotation_writes::create_h),
        )
        .route(
            "/api/v2/annotations/{id}",
            get(annotations_detail)
                .patch(annotation_writes::patch_h)
                .delete(annotation_writes::delete_h),
        )
        .route(
            "/api/v2/image-sets",
            get(image_sets_list).post(image_sets::create_h),
        )
        .route(
            "/api/v2/image-sets/{id}",
            get(image_sets_detail)
                .patch(image_sets::patch_h)
                .delete(image_sets::delete_h),
        )
        .route(
            "/api/v2/images/{id}",
            get(images_detail).delete(image_sets::delete_image_h),
        )
        .route(
            "/api/v2/annotation-types",
            get(types_list).post(catalog::type_create_h),
        )
        .route(
            "/api/v2/annotation-types/{id}",
            get(types_detail)
                .patch(catalog::type_patch_h)
                .delete(catalog::type_delete_h),
        )
        .route(
            "/api/v2/products",
            get(products_list).post(catalog::product_create_h),
        )
        .route(
            "/api/v2/products/{id}",
            get(products_detail)
                .patch(catalog::product_patch_h)
                .delete(catalog::product_delete_h),
        )
        .route("/api/v2/{resource}", get(list_h))
        .route("/api/v2/{resource}/{id}", get(detail_h))
}

fn spec_of(resource: &str) -> ApiResult<&'static crate::compat::engine::Spec> {
    RESOURCES
        .iter()
        .find(|(n, _)| *n == resource)
        .map(|(_, s)| specs::by_name(s))
        .ok_or_else(|| ApiError::not_found("Unknown resource."))
}

fn encode_cursor(id: i64) -> String {
    URL_SAFE_NO_PAD.encode(format!("id:{id}"))
}

fn decode_cursor(c: &str) -> ApiResult<i64> {
    URL_SAFE_NO_PAD
        .decode(c)
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .and_then(|s| s.strip_prefix("id:").and_then(|n| n.parse().ok()))
        .ok_or_else(|| ApiError::detail(StatusCode::BAD_REQUEST, "Invalid cursor."))
}

async fn prepare<'a>(
    s: &'a AppState,
    headers: &HeaderMap,
    uri: &Uri,
    resource: &str,
) -> ApiResult<(
    Ctx<'a>,
    &'static crate::compat::engine::Spec,
    Query,
    Flex,
    Vec<(String, String)>,
)> {
    let spec = spec_of(resource)?;
    let p = require_model_perm(
        s,
        authenticate(s, headers, &Method::GET).await?,
        &Method::GET,
        spec.perm.0,
        spec.perm.1,
    )
    .await?;
    let q = Query::parse(uri.query());
    let mut flex = Flex::from_query(&q);
    flex_to_engine(spec, &mut flex);
    let reserved = ["limit", "cursor", "count", "expand", "fields", "omit"];
    let pairs = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .filter(|(k, _)| !reserved.contains(&k.as_str()))
        .collect();
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
    Ok((ctx, spec, q, flex, pairs))
}

async fn list_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(resource): Path<String>,
) -> ApiResult<Json<Value>> {
    let (ctx, spec, q, flex, pairs) = prepare(&s, &headers, &uri, &resource).await?;
    let limit = match q.get("limit") {
        None => DEFAULT_LIMIT,
        Some(v) => v
            .parse::<i64>()
            .ok()
            .filter(|l| (1..=MAX_LIMIT).contains(l))
            .ok_or_else(|| {
                ApiError::detail(
                    StatusCode::BAD_REQUEST,
                    format!("limit must be between 1 and {MAX_LIMIT}."),
                )
            })?,
    };
    let after = q.get("cursor").map(decode_cursor).transpose()?;
    let want_count = q.boolean("count").unwrap_or(false);
    let (count, more, items) =
        list_v2(&ctx, spec, &pairs, &flex, limit, after, None, want_count).await?;
    let next = more
        .then(|| {
            items
                .last()
                .and_then(|i| i.get("id"))
                .and_then(Value::as_i64)
        })
        .flatten()
        .map(encode_cursor);
    let mut out = json!({"items": items, "next_cursor": next});
    if let Some(c) = count {
        out["count"] = json!(c);
    }
    Ok(Json(out))
}

async fn detail_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path((resource, id)): Path<(String, String)>,
) -> ApiResult<Json<Value>> {
    let (ctx, spec, _q, flex, pairs) = prepare(&s, &headers, &uri, &resource).await?;
    let id: i64 = id.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let (_, _, mut items) = list_v2(&ctx, spec, &pairs, &flex, 1, None, Some(id), false).await?;
    items
        .pop()
        .map(Json)
        .ok_or_else(|| ApiError::not_found("Not found."))
}

async fn annotations_list(
    s: State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Json<Value>> {
    list_h(s, headers, uri, Path("annotations".into())).await
}

async fn annotations_detail(
    s: State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    detail_h(s, headers, uri, Path(("annotations".into(), id))).await
}

async fn image_sets_list(
    s: State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Json<Value>> {
    list_h(s, headers, uri, Path("image-sets".into())).await
}

async fn image_sets_detail(
    s: State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    detail_h(s, headers, uri, Path(("image-sets".into(), id))).await
}

async fn images_detail(
    s: State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    detail_h(s, headers, uri, Path(("images".into(), id))).await
}

async fn types_list(s: State<AppState>, headers: HeaderMap, uri: Uri) -> ApiResult<Json<Value>> {
    list_h(s, headers, uri, Path("annotation-types".into())).await
}

async fn types_detail(
    s: State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    detail_h(s, headers, uri, Path(("annotation-types".into(), id))).await
}

async fn products_list(s: State<AppState>, headers: HeaderMap, uri: Uri) -> ApiResult<Json<Value>> {
    list_h(s, headers, uri, Path("products".into())).await
}

async fn products_detail(
    s: State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    detail_h(s, headers, uri, Path(("products".into(), id))).await
}
