//! The warnings and errors of the server, for site admins (see `errorlog.rs`):
//!
//! - `GET /api/v2/admin/log?level=warn|error&q=&limit=` -> `{"items": [{id, first, last, count, level, target, message}] (newest first),
//!   "total": matching, "capacity", "since": when the server started (a restart empties the log)}`
//! - `DELETE /api/v2/admin/log` empties it

use crate::{
    auth::{authenticate, require_user},
    error::{ApiError, ApiResult},
    errorlog::{global, CAPACITY},
    AppState,
};
use axum::{
    extract::{Query, State},
    http::{HeaderMap, Method, StatusCode},
    routing::get,
    Json, Router,
};
use exact_db::users;
use serde::Deserialize;
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v2/admin/log", get(read).delete(clear))
}

async fn site_admin(s: &AppState, headers: &HeaderMap, method: &Method) -> ApiResult<()> {
    let p = require_user(authenticate(s, headers, method).await?)?;
    if users::is_site_admin(&s.pool, p.user.id).await? {
        Ok(())
    } else {
        Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Site admin permission required.",
        ))
    }
}

#[derive(Deserialize)]
struct Params {
    level: Option<String>,
    q: Option<String>,
    limit: Option<usize>,
}

async fn read(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(p): Query<Params>,
) -> ApiResult<Json<Value>> {
    site_admin(&s, &headers, &Method::GET).await?;
    let log = global();
    let (items, total) = log.list(
        p.level.as_deref() == Some("error"),
        p.q.as_deref().unwrap_or(""),
        p.limit.unwrap_or(500).clamp(1, CAPACITY),
    );
    Ok(Json(json!({
        "items": items.iter().map(|e| json!({"id": e.id, "first": e.first.to_rfc3339(), "last": e.last.to_rfc3339(), "count": e.count,
            "level": e.level, "target": e.target, "message": e.message})).collect::<Vec<_>>(),
        "total": total, "capacity": CAPACITY, "since": log.started().to_rfc3339(),
    })))
}

async fn clear(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<StatusCode> {
    site_admin(&s, &headers, &Method::DELETE).await?;
    global().clear();
    Ok(StatusCode::NO_CONTENT)
}
