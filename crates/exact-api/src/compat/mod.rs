//! `/api/v1` (and legacy) adapters kept for `exact-sync` and ML workers (see PLAN.md §2a).
//! They are thin: parse DRF-style query parameters, call the shared engine, shape DRF-style JSON.

pub mod computed;
pub mod engine;
pub mod legacy;
pub mod perms;
pub mod rest_writes;
pub mod specs;
pub mod vector;
pub mod writes;

use crate::{
    auth::{authenticate, require_model_perm},
    error::{with_allow, ApiError, ApiResult},
    page::{Flex, Page, Query},
    AppState,
};
use axum::{
    body::Bytes,
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
        .route(
            "/api/v1/annotations/annotations/count/",
            get(annotation_count),
        )
        .route(
            "/api/v1/annotations/annotations/multiple_delete/",
            axum::routing::delete(annotation_multiple_delete),
        )
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
    body: Bytes,
) -> Response {
    if method == Method::POST {
        if let Some(r) = rest_write(&s, &headers, &method, &group, &name, None, &body).await {
            return r;
        }
    }
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
    body: Bytes,
) -> Response {
    if method != Method::GET && method != Method::HEAD {
        if let Some(r) = rest_write(&s, &headers, &method, &group, &name, Some(&pk), &body).await {
            return r;
        }
    }
    respond(
        detail_impl(&s, &headers, &method, &uri, &group, &name, &pk).await,
        DETAIL_ALLOW,
    )
}

/// Writes that are implemented (annotations); `None` leaves the request to the generic handler.
async fn rest_write(
    s: &AppState,
    headers: &HeaderMap,
    method: &Method,
    group: &str,
    name: &str,
    pk: Option<&str>,
    body: &[u8],
) -> Option<Response> {
    let spec = specs::find(group, name)?;
    if !rest_writes::is_annotation(spec) {
        return None;
    }
    let allow = if pk.is_some() {
        DETAIL_ALLOW
    } else {
        LIST_ALLOW
    };
    let r = async {
        let p = require_model_perm(
            s,
            authenticate(s, headers, method).await?,
            method,
            spec.perm.0,
            spec.perm.1,
        )
        .await?;
        let id = match pk {
            None => return rest_writes::create(s, &p, body, allow).await,
            Some(pk) => pk
                .parse::<i64>()
                .map_err(|_| ApiError::not_found("Not found."))?,
        };
        // the object has to be visible to the caller (team scope), as in `get_object()`
        let (_, found) = engine::list(
            &ctx(s, &p, headers),
            spec,
            &[],
            &Flex::default(),
            1,
            0,
            Some(id),
        )
        .await?;
        if found.is_empty() {
            return Err(ApiError::not_found("Not found."));
        }
        match *method {
            Method::DELETE => rest_writes::delete(s, &p, id).await,
            Method::PUT => rest_writes::update(s, &p, id, body, false, allow).await,
            _ => rest_writes::update(s, &p, id, body, true, allow).await,
        }
    }
    .await;
    Some(match r {
        Ok(r) => r,
        Err(e) => with_allow(e.into_response(), allow),
    })
}

async fn annotation_count(State(s): State<AppState>, headers: HeaderMap, uri: Uri) -> Response {
    let r = async {
        let p = require_model_perm(
            &s,
            authenticate(&s, &headers, &Method::GET).await?,
            &Method::GET,
            "annotations",
            "annotation",
        )
        .await?;
        rest_writes::count(&s, &p, &headers, &query_pairs(&uri)).await
    }
    .await;
    r.unwrap_or_else(|e| with_allow(e.into_response(), "GET, HEAD, OPTIONS"))
}

async fn annotation_multiple_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    let r = async {
        let p = require_model_perm(
            &s,
            authenticate(&s, &headers, &Method::DELETE).await?,
            &Method::DELETE,
            "annotations",
            "annotation",
        )
        .await?;
        rest_writes::multiple_delete(&s, &p, &headers, &query_pairs(&uri)).await
    }
    .await;
    r.unwrap_or_else(|e| with_allow(e.into_response(), "DELETE, OPTIONS"))
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
