//! Personal access tokens (`Authorization: Bearer pat_<prefix>.<secret>`), the credential of scripts and exact-sync. They live in Django's
//! `users_personalaccesstoken` table (only the sha256 of the token is stored, so the secret is shown once, when it is made), and
//! authenticating with them is in `auth.rs`. This is their management:
//!
//! - `GET /api/v2/me/tokens`: the caller's tokens, newest first: `id, name, prefix, created_at, last_used_at, expires_at, revoked_at,
//!   read_only, teams` (team ids; empty = all teams of the account), `scopes` (null = not limited, else what the token may do besides
//!   looking: `jobs`, `annotate`, `images`, see `scope.rs`), `active`.
//! - `POST /api/v2/me/tokens` `{name, expires_in_days?, read_only?, teams?, scopes?}` -> 201 with the same fields and `token`, the only time the
//!   secret is ever returned. `teams` must be teams the account belongs to.
//! - `DELETE /api/v2/me/tokens/{id}`: revokes an active token (204: it stops working at once); deleting one that is already revoked or has
//!   expired removes the row.
//! - `GET /api/v2/admin/tokens?user={id}` and `DELETE /api/v2/admin/tokens/{id}`: site administrators list and revoke the tokens of any
//!   account (they never see a secret).
//!
//! A token cannot make tokens: managing them needs the password or a sign-in session, and not an impersonation (an administrator who
//! impersonates somebody must not be able to mint a lasting credential in their name).

use crate::{
    auth::{authenticate_account, require_user, AuthKind, Principal},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    routing::{delete, get},
    Json, Router,
};
use chrono::{DateTime, Duration, Utc};
use exact_auth::tokens::{generate_pat, hash_token};
use crate::scope::SCOPES;
use exact_db::users;
use serde::Deserialize;
use serde_json::{json, Value};
use sqlx::FromRow;
use std::collections::HashMap;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/me/tokens", get(list_own).post(create))
        .route("/api/v2/me/tokens/{id}", delete(revoke_own))
        .route("/api/v2/admin/tokens", get(list_admin))
        .route("/api/v2/admin/tokens/{id}", delete(revoke_admin))
}

#[derive(FromRow)]
struct Row {
    id: i64,
    name: String,
    prefix: String,
    created_at: DateTime<Utc>,
    last_used_at: Option<DateTime<Utc>>,
    expires_at: Option<DateTime<Utc>>,
    revoked_at: Option<DateTime<Utc>>,
    read_only: bool,
    user_id: i64,
}

const COLUMNS: &str =
    "id, name, prefix, created_at, last_used_at, expires_at, revoked_at, read_only, user_id";

fn bad(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
}

async fn json_of(s: &AppState, rows: Vec<Row>, with_user: bool) -> ApiResult<Vec<Value>> {
    let ids: Vec<i64> = rows.iter().map(|r| r.id).collect();
    let pairs: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT personalaccesstoken_id, team_id FROM users_personalaccesstoken_teams
         WHERE personalaccesstoken_id = ANY($1) ORDER BY team_id",
    )
    .bind(&ids)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let mut teams: HashMap<i64, Vec<i64>> = HashMap::new();
    for (t, team) in pairs {
        teams.entry(t).or_default().push(team);
    }
    let names: HashMap<i64, String> = if with_user {
        let users: Vec<i64> = rows.iter().map(|r| r.user_id).collect();
        sqlx::query_as::<_, (i64, String)>("SELECT id, username FROM users_user WHERE id = ANY($1)")
            .bind(&users)
            .fetch_all(&s.pool)
            .await
            .map_err(db_err)?
            .into_iter()
            .collect()
    } else {
        HashMap::new()
    };
    let scopes: HashMap<i64, Vec<String>> =
        sqlx::query_as::<_, (i64, Vec<String>)>("SELECT token_id, scopes FROM exact_rust_token_scope WHERE token_id = ANY($1)")
            .bind(&ids)
            .fetch_all(&s.pool)
            .await
            .map_err(db_err)?
            .into_iter()
            .collect();
    let now = Utc::now();
    Ok(rows
        .into_iter()
        .map(|r| {
            let active = r.revoked_at.is_none() && r.expires_at.is_none_or(|e| e > now);
            let mut v = json!({
                "id": r.id, "name": r.name, "prefix": r.prefix, "created_at": r.created_at.to_rfc3339(),
                "last_used_at": r.last_used_at.map(|d| d.to_rfc3339()), "expires_at": r.expires_at.map(|d| d.to_rfc3339()),
                "revoked_at": r.revoked_at.map(|d| d.to_rfc3339()), "read_only": r.read_only,
                "teams": teams.remove(&r.id).unwrap_or_default(), "scopes": scopes.get(&r.id), "active": active,
            });
            if with_user {
                v["user"] = json!(r.user_id);
                v["username"] = json!(names.get(&r.user_id));
            }
            v
        })
        .collect())
}

/// Managing tokens needs a sign-in (session) or the password (Basic), never a token and never an impersonation.
async fn account(s: &AppState, headers: &HeaderMap, method: &Method) -> ApiResult<Principal> {
    let p = require_user(authenticate_account(s, headers, method).await?)?;
    match &p.kind {
        AuthKind::Token(_) => Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "A token cannot manage tokens: sign in or use your password.",
        )),
        AuthKind::Session {
            impersonator: Some(_),
            ..
        } => Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Tokens cannot be managed while impersonating.",
        )),
        _ => Ok(p),
    }
}

async fn list_own(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let p = account(&s, &headers, &Method::GET).await?;
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM users_personalaccesstoken WHERE user_id = $1 ORDER BY created_at DESC, id DESC"
    ))
    .bind(p.user.id)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(Value::Array(json_of(&s, rows, false).await?)))
}

#[derive(Deserialize)]
struct NewToken {
    name: String,
    /// Days until it expires; none = never.
    expires_in_days: Option<i64>,
    #[serde(default)]
    read_only: bool,
    /// Team ids to restrict it to; none or empty = all teams of the account.
    #[serde(default)]
    teams: Vec<i64>,
    /// What the token may do besides looking (`jobs`, `annotate`, `images`); none: not limited. Not together with `read_only`.
    scopes: Option<Vec<String>>,
}

async fn create(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<NewToken>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = account(&s, &headers, &Method::POST).await?;
    let name = b.name.trim();
    if name.is_empty() || name.chars().count() > 100 {
        return Err(bad("Give the token a name of up to 100 characters."));
    }
    let expires = match b.expires_in_days {
        None => None,
        Some(d) if (1..=3650).contains(&d) => Some(Utc::now() + Duration::days(d)),
        Some(_) => return Err(bad("expires_in_days is a whole number from 1 to 3650.")),
    };
    let scopes = match b.scopes {
        None => None,
        Some(_) if b.read_only => {
            return Err(bad("A read-only token cannot have scopes: it may only look."))
        }
        Some(mut v) => {
            v.sort();
            v.dedup();
            if v.is_empty() || v.iter().any(|x| !SCOPES.contains(&x.as_str())) {
                return Err(bad("scopes are some of jobs, annotate, images (for a token that only looks, use read_only)."));
            }
            Some(v)
        }
    };
    let mut teams = b.teams;
    teams.sort_unstable();
    teams.dedup();
    if !teams.is_empty() {
        let mine: Vec<i64> = sqlx::query_scalar(
            "SELECT team_id FROM users_teammembership WHERE user_id = $1 AND team_id = ANY($2)",
        )
        .bind(p.user.id)
        .bind(&teams)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
        if mine.len() != teams.len() {
            return Err(bad("A token can only be restricted to teams you belong to."));
        }
    }
    let (token, prefix) = generate_pat();
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let row: Row = sqlx::query_as(&format!(
        "INSERT INTO users_personalaccesstoken (name, prefix, token_hash, created_at, expires_at, read_only, user_id)
         VALUES ($1, $2, $3, now(), $4, $5, $6) RETURNING {COLUMNS}"
    ))
    .bind(name)
    .bind(&prefix)
    .bind(hash_token(&token))
    .bind(expires)
    .bind(b.read_only)
    .bind(p.user.id)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    for t in &teams {
        sqlx::query("INSERT INTO users_personalaccesstoken_teams (personalaccesstoken_id, team_id) VALUES ($1, $2)")
            .bind(row.id)
            .bind(t)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    if let Some(sc) = &scopes {
        sqlx::query("INSERT INTO exact_rust_token_scope (token_id, scopes) VALUES ($1, $2)")
            .bind(row.id)
            .bind(sc)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    let mut v = json_of(&s, vec![row], false).await?.remove(0);
    v["token"] = json!(token);
    Ok((StatusCode::CREATED, Json(v)))
}

/// Revokes an active token, removes one that is already inactive. `owner` limits it to one account's tokens.
async fn revoke(s: &AppState, id: i64, owner: Option<i64>) -> ApiResult<StatusCode> {
    let row: Option<Row> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM users_personalaccesstoken WHERE id = $1 AND ($2::bigint IS NULL OR user_id = $2)"
    ))
    .bind(id)
    .bind(owner)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    let Some(row) = row else {
        return Err(ApiError::not_found("Not found."));
    };
    let active = row.revoked_at.is_none() && row.expires_at.is_none_or(|e| e > Utc::now());
    if active {
        sqlx::query("UPDATE users_personalaccesstoken SET revoked_at = now() WHERE id = $1")
            .bind(id)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
    } else {
        sqlx::query("DELETE FROM users_personalaccesstoken_teams WHERE personalaccesstoken_id = $1")
            .bind(id)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
        sqlx::query("DELETE FROM users_personalaccesstoken WHERE id = $1")
            .bind(id)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn revoke_own(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    let p = account(&s, &headers, &Method::DELETE).await?;
    revoke(&s, id, Some(p.user.id)).await
}

async fn site_admin(s: &AppState, headers: &HeaderMap, method: &Method) -> ApiResult<()> {
    let p = require_user(authenticate_account(s, headers, method).await?)?;
    if matches!(p.kind, AuthKind::Token(_)) || !users::is_site_admin(&s.pool, p.user.id).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Site admin permission required.",
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
struct ByUser {
    user: Option<i64>,
}

async fn list_admin(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<ByUser>,
) -> ApiResult<Json<Value>> {
    site_admin(&s, &headers, &Method::GET).await?;
    let rows: Vec<Row> = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM users_personalaccesstoken WHERE ($1::bigint IS NULL OR user_id = $1)
         ORDER BY created_at DESC, id DESC LIMIT 1000"
    ))
    .bind(q.user)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(Value::Array(json_of(&s, rows, true).await?)))
}

async fn revoke_admin(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<StatusCode> {
    site_admin(&s, &headers, &Method::DELETE).await?;
    revoke(&s, id, None).await
}
