//! The "what's new" greeting for people who have not been on this server before.
//!
//! `GET /api/v2/welcome` -> `{"show": bool, "notice": string | null}`: `show` is true until the user has dismissed the greeting once
//! (`exact_rust_user_flags.welcomed_at`); `notice` is the line the administrator put in `EXACT_WELCOME_NOTICE` (e.g. that this is a beta on
//! a copy of the production data). `POST /api/v2/welcome/seen` records the dismissal (204). An administrator who impersonates somebody neither
//! sees the greeting nor dismisses it for them. Dismissing is account self-service, so read-only accounts may do it.

use crate::{
    auth::{authenticate, authenticate_account, require_user, AuthKind},
    compat::engine::db_err,
    error::ApiResult,
    AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::json;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/welcome", get(welcome))
        .route("/api/v2/welcome/seen", post(seen))
}

fn impersonating(kind: &AuthKind) -> bool {
    matches!(
        kind,
        AuthKind::Session {
            impersonator: Some(_),
            ..
        }
    )
}

async fn welcome(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let welcomed: bool = sqlx::query_scalar(
        "SELECT COALESCE((SELECT welcomed_at IS NOT NULL FROM exact_rust_user_flags WHERE user_id = $1), false)",
    )
    .bind(p.user.id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(
        Json(json!({"show": !welcomed && !impersonating(&p.kind), "notice": s.welcome_notice}))
            .into_response(),
    )
}

async fn seen(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate_account(&s, &headers, &Method::POST).await?)?;
    if !impersonating(&p.kind) {
        sqlx::query(
            "INSERT INTO exact_rust_user_flags (user_id, read_only, welcomed_at) VALUES ($1, false, now())
             ON CONFLICT (user_id) DO UPDATE SET welcomed_at = COALESCE(exact_rust_user_flags.welcomed_at, now())",
        )
        .bind(p.user.id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}
