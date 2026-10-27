//! `/api/v2`: the clean API. Phase 2 provides session authentication for the new UI;
//! resources follow in Phase 3.

pub mod annotation_writes;
mod invitations;
pub mod passkeys;
pub mod resources;

use crate::{
    auth::{authenticate, require_user, AuthKind, CSRF_HEADER, SESSION_COOKIE},
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use exact_auth::{hashers::verify_password, tokens};
use exact_db::{sessions, users};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .merge(passkeys::routes())
        .merge(invitations::routes())
        .merge(resources::routes())
        .merge(annotation_writes::routes())
        .route("/api/v2/auth/login", post(login))
        .route("/api/v2/auth/stop-impersonating", post(stop_impersonating))
        .route("/api/v2/admin/users/{id}/impersonate", post(impersonate))
        .route("/api/v2/auth/logout", post(logout))
        .route("/api/v2/auth/me", get(me))
}

#[derive(Deserialize)]
struct Login {
    username: String,
    password: String,
}

fn cookie_header(s: &AppState, value: &str, max_age: i64) -> HeaderValue {
    let secure = if s.cookie_secure { "; Secure" } else { "" };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={value}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    ))
    .expect("ascii cookie")
}

pub(crate) fn user_json(u: &users::DbUser) -> Value {
    json!({"id": u.id, "username": u.username, "is_staff": u.is_staff, "is_superuser": u.is_superuser})
}

async fn login(State(s): State<AppState>, Json(body): Json<Login>) -> ApiResult<Response> {
    let bad = || ApiError::detail(StatusCode::UNAUTHORIZED, "Invalid username/password.");
    let user = users::user_by_username(&s.pool, &body.username).await?;
    let ok = user
        .as_ref()
        .is_some_and(|u| u.is_active && verify_password(&body.password, &u.password));
    if user.is_none() {
        let _ = verify_password(
            &body.password,
            "pbkdf2_sha256$600000$dummysaltdummysalt$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        ); // timing
    }
    let Some(user) = user.filter(|_| ok) else {
        return Err(bad());
    };
    let (key, csrf) = (tokens::random_token(40), tokens::random_token(40));
    sessions::create(
        &s.pool,
        &key,
        &csrf,
        user.id,
        None,
        chrono::Utc::now() + chrono::Duration::seconds(s.session_seconds),
    )
    .await?;
    users::touch_last_login(&s.pool, user.id).await?;
    let mut r = Json(json!({"user": user_json(&user), "csrf_token": csrf})).into_response();
    r.headers_mut().insert(
        header::SET_COOKIE,
        cookie_header(&s, &key, s.session_seconds),
    );
    Ok(r)
}

async fn logout(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    if let Some(key) = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| {
            c.split(';')
                .find_map(|kv| kv.trim().strip_prefix(&format!("{SESSION_COOKIE}=")))
        })
    {
        sessions::delete(&s.pool, key).await?;
    }
    let mut r = StatusCode::NO_CONTENT.into_response();
    r.headers_mut()
        .insert(header::SET_COOKIE, cookie_header(&s, "", 0));
    Ok(r)
}

async fn me(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let p = authenticate(&s, &headers, &Method::GET)
        .await?
        .ok_or_else(|| ApiError::detail(StatusCode::UNAUTHORIZED, "Not authenticated."))?;
    let mut v = user_json(&p.user);
    if let AuthKind::Session { csrf, impersonator } = &p.kind {
        v["csrf_token"] = json!(csrf);
        v["csrf_header"] = json!(CSRF_HEADER);
        v["impersonating_real_user_id"] = json!(impersonator);
    }
    Ok(Json(v))
}

/// Start a new session for `user`, replacing the current one (Django's `login()` flushes the session).
pub(crate) async fn switch_session(
    s: &AppState,
    old_key: Option<&str>,
    user: &users::DbUser,
    impersonator: Option<i64>,
) -> ApiResult<Response> {
    let (key, csrf) = (tokens::random_token(40), tokens::random_token(40));
    sessions::create(
        &s.pool,
        &key,
        &csrf,
        user.id,
        impersonator,
        chrono::Utc::now() + chrono::Duration::seconds(s.session_seconds),
    )
    .await?;
    if let Some(old) = old_key {
        sessions::delete(&s.pool, old).await?;
    }
    let mut r = Json(json!({"user": user_json(user), "csrf_token": csrf, "impersonating_real_user_id": impersonator})).into_response();
    r.headers_mut().insert(
        header::SET_COOKIE,
        cookie_header(s, &key, s.session_seconds),
    );
    Ok(r)
}

fn session_key(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|c| {
            c.split(';')
                .find_map(|kv| kv.trim().strip_prefix(&format!("{SESSION_COOKIE}=")))
        })
}

/// Same rules as Django's `user_impersonate_api`: site admins only, not yourself, no nesting,
/// and only superusers may impersonate superusers. Session authentication only.
async fn impersonate(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let AuthKind::Session { impersonator, .. } = &p.kind else {
        return Err(ApiError::auth_failed(
            "Impersonation requires an interactive session.",
        ));
    };
    if !users::is_site_admin(&s.pool, p.user.id).await? {
        return Err(ApiError::auth_failed("Site admin permission required."));
    }
    let target = users::user_by_id(&s.pool, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if target.id == p.user.id {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Cannot impersonate yourself.",
        ));
    }
    if impersonator.is_some() {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Already impersonating a user. Stop the current session first.",
        ));
    }
    if target.is_superuser && !p.user.is_superuser {
        return Err(ApiError::auth_failed(
            "Only superusers may impersonate superusers.",
        ));
    }
    tracing::warn!(
        real_user = p.user.id,
        target_user = target.id,
        "impersonation started"
    );
    switch_session(&s, session_key(&headers), &target, Some(p.user.id)).await
}

async fn stop_impersonating(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let AuthKind::Session {
        impersonator: Some(real),
        ..
    } = &p.kind
    else {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Not impersonating.",
        ));
    };
    let real_user = users::user_by_id(&s.pool, *real)
        .await?
        .filter(|u| u.is_active)
        .ok_or_else(|| ApiError::auth_failed("User inactive or deleted."))?;
    tracing::warn!(
        real_user = real_user.id,
        target_user = p.user.id,
        "impersonation stopped"
    );
    switch_session(&s, session_key(&headers), &real_user, None).await
}
