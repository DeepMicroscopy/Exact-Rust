//! Invite-only onboarding and password recovery without e-mail.
//!
//! There is **no self-registration**. A site admin (any team) or a team admin (their own teams) creates an
//! invitation and passes the one-time link to the person; the person opens it and chooses a username and
//! password. For forgotten passwords a site admin creates a one-time reset link the same way.

use super::switch_session;
use crate::{
    auth::{authenticate, require_user, Principal},
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::Response,
    routing::{delete, get, post},
    Json, Router,
};
use chrono::{Duration, Utc};
use exact_auth::{
    hashers::make_password,
    policy::validate_password,
    tokens::{hash_token, random_token},
};
use exact_db::{
    invitations::{self, Invitation, NewUser},
    users,
};
use serde::Deserialize;
use serde_json::{json, Value};

/// Django `ACCOUNT_ACTIVATION_DAYS`
const DEFAULT_DAYS: i64 = 7;
const MAX_DAYS: i64 = 30;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/invitations", post(create).get(list))
        .route("/api/v2/invitations/{id}", delete(revoke))
        .route("/api/v2/invitations/token/{token}", get(inspect))
        .route("/api/v2/invitations/token/{token}/accept", post(accept))
        .route("/api/v2/admin/users/{id}/reset-link", post(reset_link))
}

fn inv_json(i: &Invitation) -> Value {
    json!({"id": i.id, "purpose": i.purpose, "status": i.status(), "email": i.email, "user_id": i.user_id, "team_ids": i.team_ids,
           "note": i.note, "created_by": i.created_by, "created_at": i.created_at.to_rfc3339(), "expires_at": i.expires_at.to_rfc3339(),
           "used_at": i.used_at.map(|d| d.to_rfc3339()), "used_by": i.used_by})
}

async fn is_site_admin(s: &AppState, p: &Principal) -> ApiResult<bool> {
    Ok(users::is_site_admin(&s.pool, p.user.id).await?)
}

#[derive(Deserialize)]
struct CreateBody {
    #[serde(default)]
    email: String,
    #[serde(default)]
    team_ids: Vec<i64>,
    #[serde(default)]
    note: String,
    expires_in_days: Option<i64>,
}

fn expiry(days: Option<i64>) -> ApiResult<chrono::DateTime<Utc>> {
    let d = days.unwrap_or(DEFAULT_DAYS);
    if !(1..=MAX_DAYS).contains(&d) {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("expires_in_days must be between 1 and {MAX_DAYS}."),
        ));
    }
    Ok(Utc::now() + Duration::days(d))
}

fn with_token(i: &Invitation, token: &str) -> Value {
    let mut v = inv_json(i);
    v["token"] = json!(token); // shown exactly once
    v["path"] = json!(format!("/invite/{token}"));
    v
}

/// Site admins may invite into any team (or into none); team admins only into teams they administer.
async fn create(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<CreateBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let mut team_ids = b.team_ids.clone();
    team_ids.sort_unstable();
    team_ids.dedup();
    if !is_site_admin(&s, &p).await? {
        let admin_of = users::admin_team_ids(&s.pool, p.user.id).await?;
        if team_ids.is_empty() || !team_ids.iter().all(|t| admin_of.contains(t)) {
            return Err(ApiError::permission_denied());
        }
    }
    if users::count_teams(&s.pool, &team_ids).await? != team_ids.len() as i64 {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Unknown team in team_ids.",
        ));
    }
    let token = format!("inv_{}", random_token(40));
    let inv = invitations::create(
        &s.pool,
        &hash_token(&token),
        "invite",
        b.email.trim(),
        None,
        &team_ids,
        b.note.trim(),
        p.user.id,
        expiry(b.expires_in_days)?,
    )
    .await?;
    tracing::info!(by = p.user.id, invitation = inv.id, teams = ?team_ids, "invitation created");
    Ok((StatusCode::CREATED, Json(with_token(&inv, &token))))
}

#[derive(Deserialize, Default)]
struct ResetBody {
    expires_in_days: Option<i64>,
}

/// Forgotten password: only site admins hand out reset links (like Django's admin-triggered reset).
async fn reset_link(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Option<Json<ResetBody>>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    if !is_site_admin(&s, &p).await? {
        return Err(ApiError::auth_failed("Site admin permission required."));
    }
    let target = users::user_by_id(&s.pool, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if target.is_superuser && !p.user.is_superuser {
        return Err(ApiError::auth_failed(
            "Only superusers may reset superuser passwords.",
        ));
    }
    let token = format!("rst_{}", random_token(40));
    let days = body.and_then(|b| b.0.expires_in_days).or(Some(1));
    let inv = invitations::create(
        &s.pool,
        &hash_token(&token),
        "reset",
        "",
        Some(target.id),
        &[],
        "",
        p.user.id,
        expiry(days)?,
    )
    .await?;
    tracing::warn!(
        by = p.user.id,
        target = target.id,
        invitation = inv.id,
        "password reset link created"
    );
    Ok((StatusCode::CREATED, Json(with_token(&inv, &token))))
}

async fn list(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let all = is_site_admin(&s, &p).await?;
    let rows = invitations::list(&s.pool, if all { None } else { Some(p.user.id) }).await?;
    Ok(Json(Value::Array(rows.iter().map(inv_json).collect())))
}

async fn revoke(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let inv = invitations::get(&s.pool, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if inv.created_by != Some(p.user.id) && !is_site_admin(&s, &p).await? {
        return Err(ApiError::not_found("Not found."));
    }
    invitations::revoke(&s.pool, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

fn invalid_link() -> ApiError {
    ApiError::not_found("This link is invalid, expired or already used.")
}

/// Public: what the accept page needs to render (no secrets, no user data beyond the invited teams).
async fn inspect(State(s): State<AppState>, Path(token): Path<String>) -> ApiResult<Json<Value>> {
    let inv = invitations::pending_by_hash(&s.pool, &hash_token(&token))
        .await?
        .ok_or_else(invalid_link)?;
    let teams = users::teams_by_ids(&s.pool, &inv.team_ids).await?;
    let username = match (inv.purpose.as_str(), inv.user_id) {
        ("reset", Some(uid)) => users::user_by_id(&s.pool, uid).await?.map(|u| u.username),
        _ => None,
    };
    Ok(Json(
        json!({"purpose": inv.purpose, "email": inv.email, "username": username, "expires_at": inv.expires_at.to_rfc3339(),
                   "teams": teams.iter().map(|t| json!({"id": t.id, "name": t.name})).collect::<Vec<_>>()}),
    ))
}

#[derive(Deserialize)]
struct AcceptBody {
    #[serde(default)]
    username: String,
    password: String,
    #[serde(default)]
    email: String,
    #[serde(default)]
    first_name: String,
    #[serde(default)]
    last_name: String,
}

/// Django's username rule: letters, digits and @/./+/-/_ only, at most 150 characters.
fn valid_username(u: &str) -> bool {
    !u.is_empty()
        && u.chars().count() <= 150
        && u.chars()
            .all(|c| c.is_alphanumeric() || "@.+-_".contains(c))
}

fn field_errors(field: &str, msgs: Vec<String>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({ field: msgs }),
    }
}

async fn accept(
    State(s): State<AppState>,
    Path(token): Path<String>,
    Json(b): Json<AcceptBody>,
) -> ApiResult<Response> {
    let hash = hash_token(&token);
    let inv = invitations::pending_by_hash(&s.pool, &hash)
        .await?
        .ok_or_else(invalid_link)?;
    if inv.purpose == "reset" {
        let uid = inv.user_id.ok_or_else(invalid_link)?;
        let user = users::user_by_id(&s.pool, uid)
            .await?
            .ok_or_else(invalid_link)?;
        let errs = validate_password(&b.password, &[&user.username]);
        if !errs.is_empty() {
            return Err(field_errors("password", errs));
        }
        let uid = invitations::accept_reset(&s.pool, &hash, &make_password(&b.password)).await?;
        tracing::warn!(user = uid, "password reset via link");
        let user = users::user_by_id(&s.pool, uid)
            .await?
            .ok_or_else(invalid_link)?;
        return if user.is_active {
            switch_session(&s, None, &user, None).await
        } else {
            Err(ApiError::auth_failed("User inactive or deleted."))
        };
    }
    let email = if b.email.trim().is_empty() {
        inv.email.clone()
    } else {
        b.email.trim().to_string()
    };
    if !valid_username(&b.username) {
        return Err(field_errors("username", vec!["Enter a valid username. This value may contain only letters, numbers, and @/./+/-/_ characters.".into()]));
    }
    let errs = validate_password(
        &b.password,
        &[&b.username, &email, &b.first_name, &b.last_name],
    );
    if !errs.is_empty() {
        return Err(field_errors("password", errs));
    }
    let id = invitations::accept_invite(
        &s.pool,
        &hash,
        &NewUser {
            username: &b.username,
            password_hash: &make_password(&b.password),
            email: &email,
            first_name: b.first_name.trim(),
            last_name: b.last_name.trim(),
        },
    )
    .await?;
    tracing::info!(user = id, invitation = inv.id, "invitation accepted");
    let user = users::user_by_id(&s.pool, id)
        .await?
        .ok_or_else(invalid_link)?;
    let mut r = switch_session(&s, None, &user, None).await?;
    *r.status_mut() = StatusCode::CREATED;
    Ok(r)
}
