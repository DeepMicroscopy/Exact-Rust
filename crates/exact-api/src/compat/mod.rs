//! `/api/v1` (and legacy) adapters kept for `exact-sync` and ML workers (see PLAN.md §2a).
//! They are thin: parse DRF-style query parameters, call the shared engine, shape DRF-style JSON.

pub mod computed;
pub mod engine;
pub mod legacy;
pub mod specs;

use crate::{
    auth::{authenticate, require_model_perm},
    error::{with_allow, ApiError, ApiResult},
    page::{Flex, Page, Query},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, Method, Uri},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use engine::Ctx;
use serde_json::Value;

const LIST_ALLOW: &str = "GET, POST, HEAD, OPTIONS";
const DETAIL_ALLOW: &str = "GET, PUT, PATCH, DELETE, HEAD, OPTIONS";

pub fn routes() -> Router<AppState> {
    Router::new()
        .merge(legacy::routes())
        .route("/api/v1/{group}/{name}/", get(list_h).post(list_h))
        .route(
            "/api/v1/{group}/{name}/{pk}/",
            get(detail_h).put(detail_h).patch(detail_h).delete(detail_h),
        )
}

fn respond(r: ApiResult<Value>, allow: &'static str) -> Response {
    match r {
        Ok(v) => with_allow(Json(v).into_response(), allow),
        // Django's routing 404 page carries no Allow header
        Err(e) if e.is_page() => e.into_response(),
        Err(e) => with_allow(e.into_response(), allow),
    }
}

async fn list_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    method: Method,
    uri: Uri,
    Path((group, name)): Path<(String, String)>,
) -> Response {
    respond(
        list_impl(&s, &headers, &method, &uri, &group, &name).await,
        LIST_ALLOW,
    )
}

async fn detail_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    method: Method,
    uri: Uri,
    Path((group, name, pk)): Path<(String, String, String)>,
) -> Response {
    respond(
        detail_impl(&s, &headers, &method, &uri, &group, &name, &pk).await,
        DETAIL_ALLOW,
    )
}

fn ctx<'a>(s: &'a AppState, p: &crate::auth::Principal, headers: &HeaderMap) -> Ctx<'a> {
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

fn query_pairs(uri: &Uri) -> Vec<(String, String)> {
    form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .collect()
}

async fn list_impl(
    s: &AppState,
    headers: &HeaderMap,
    method: &Method,
    uri: &Uri,
    group: &str,
    name: &str,
) -> ApiResult<Value> {
    let spec = specs::find(group, name).ok_or_else(ApiError::not_found_page)?;
    let p = require_model_perm(
        s,
        authenticate(s, headers, method).await?,
        method,
        spec.perm.0,
        spec.perm.1,
    )
    .await?;
    if *method == Method::POST {
        return Err(ApiError::not_implemented("creating objects"));
    }
    let q = Query::parse(uri.query());
    let page = Page::from_query(&q);
    let flex = Flex::from_query(&q);
    let (count, results) = engine::list(
        &ctx(s, &p, headers),
        spec,
        &query_pairs(uri),
        &flex,
        page.limit,
        page.offset,
        None,
    )
    .await?;
    Ok(page.envelope(&q, headers, uri.path(), count, results))
}

async fn detail_impl(
    s: &AppState,
    headers: &HeaderMap,
    method: &Method,
    uri: &Uri,
    group: &str,
    name: &str,
    pk: &str,
) -> ApiResult<Value> {
    let spec = specs::find(group, name).ok_or_else(ApiError::not_found_page)?;
    let p = require_model_perm(
        s,
        authenticate(s, headers, method).await?,
        method,
        spec.perm.0,
        spec.perm.1,
    )
    .await?;
    let id: i64 = pk.parse().map_err(|_| ApiError::not_found("Not found."))?;
    let q = Query::parse(uri.query());
    let flex = Flex::from_query(&q);
    let (_, mut results) = engine::list(
        &ctx(s, &p, headers),
        spec,
        &query_pairs(uri),
        &flex,
        1,
        0,
        Some(id),
    )
    .await?;
    let obj = results
        .pop()
        .ok_or_else(|| ApiError::not_found(format!("No {} matches the given query.", spec.name)))?;
    if *method != Method::GET && *method != Method::HEAD {
        return Err(ApiError::not_implemented("updating or deleting objects"));
    }
    Ok(obj)
}
