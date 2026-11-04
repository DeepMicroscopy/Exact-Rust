//! What an account does to itself (the Preferences page and the user menu):
//!
//! - `GET /api/v2/me/account` -> `{username, email, date_joined, last_login}`
//! - `PUT /api/v2/me/email` `{email}`: empty or a plausible address
//! - `POST /api/v2/me/password` `{current_password, new_password}`: the password rules of the invitations apply; every other session
//!   of the account ends, the current one stays
//! - `GET /api/v2/me/statistics`: annotations, images and verifications of the account, in total, per team and per day (last 30 days)
//!
//! Self-service, so read-only accounts may use it; somebody who impersonates an account may read but not change it.

use super::session_key;
use crate::{
    auth::{authenticate, authenticate_account, require_user, AuthKind, Principal},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    routing::{get, post, put},
    Json, Router,
};
use chrono::{DateTime, Utc};
use exact_auth::{
    hashers::{make_password, verify_password},
    policy::validate_password,
};
use serde::Deserialize;
use serde_json::{json, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/me/account", get(account))
        .route("/api/v2/me/email", put(set_email))
        .route("/api/v2/me/password", post(set_password))
        .route("/api/v2/me/statistics", get(statistics))
}

fn field(name: &str, msg: impl Into<String>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({ name: [msg.into()] }),
    }
}

/// Own account, not somebody else's seen through "impersonate".
async fn own(s: &AppState, headers: &HeaderMap, method: &Method) -> ApiResult<Principal> {
    let p = require_user(authenticate_account(s, headers, method).await?)?;
    if matches!(
        p.kind,
        AuthKind::Session {
            impersonator: Some(_),
            ..
        }
    ) {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Not available while impersonating.",
        ));
    }
    Ok(p)
}

async fn account(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate_account(&s, &headers, &Method::GET).await?)?;
    let (email, joined, last): (String, DateTime<Utc>, Option<DateTime<Utc>>) =
        sqlx::query_as("SELECT email, date_joined, last_login FROM users_user WHERE id = $1")
            .bind(p.user.id)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
    Ok(Json(json!({
        "username": p.user.username, "email": email,
        "date_joined": joined.to_rfc3339(), "last_login": last.map(|d| d.to_rfc3339()),
    })))
}

#[derive(Deserialize)]
struct EmailBody {
    email: String,
}

fn plausible(email: &str) -> bool {
    let Some((local, domain)) = email.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && domain.contains('.')
        && !domain.starts_with('.')
        && !domain.ends_with('.')
        && !email.chars().any(|c| c.is_whitespace() || c == ',')
        && !domain.contains('@')
}

async fn set_email(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<EmailBody>,
) -> ApiResult<Json<Value>> {
    let p = own(&s, &headers, &Method::PUT).await?;
    let email = b.email.trim();
    if email.len() > 254 || (!email.is_empty() && !plausible(email)) {
        return Err(field("email", "Enter a valid email address."));
    }
    sqlx::query("UPDATE users_user SET email = $2 WHERE id = $1")
        .bind(p.user.id)
        .bind(email)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(Json(json!({"email": email})))
}

#[derive(Deserialize)]
struct PasswordBody {
    current_password: String,
    new_password: String,
}

async fn set_password(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<PasswordBody>,
) -> ApiResult<StatusCode> {
    let p = own(&s, &headers, &Method::POST).await?;
    if !verify_password(&b.current_password, &p.user.password) {
        return Err(field("current_password", "The current password is wrong."));
    }
    let email: String = sqlx::query_scalar("SELECT email FROM users_user WHERE id = $1")
        .bind(p.user.id)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    let errs = validate_password(&b.new_password, &[&p.user.username, &email]);
    if !errs.is_empty() {
        return Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            body: json!({"new_password": errs}),
        });
    }
    sqlx::query("UPDATE users_user SET password = $2 WHERE id = $1")
        .bind(p.user.id)
        .bind(make_password(&b.new_password))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    // whoever else holds a session of the account (a lost laptop) is signed out; this browser stays signed in
    sqlx::query("DELETE FROM exact_rust_session WHERE user_id = $1 AND key <> $2")
        .bind(p.user.id)
        .bind(session_key(&headers).unwrap_or(""))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    tracing::info!(user = p.user.id, "password changed by the user");
    Ok(StatusCode::NO_CONTENT)
}

async fn statistics(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let uid = p.user.id;
    let one = |sql: &'static str| {
        let pool = s.pool.clone();
        async move {
            sqlx::query_scalar::<_, i64>(sql)
                .bind(uid)
                .fetch_one(&pool)
                .await
                .map_err(db_err)
        }
    };
    let annotations = one("SELECT count(*) FROM annotations_annotation WHERE user_id = $1 AND NOT deleted").await?;
    let images = one("SELECT count(*) FROM images_image WHERE creator_id = $1").await?;
    let verifications = one("SELECT count(*) FROM annotations_verification WHERE user_id = $1").await?;
    let teams: Vec<(i64, String, i64, i64)> = sqlx::query_as(
        "SELECT t.id, t.name,
                (SELECT count(*) FROM annotations_annotation a JOIN images_image i ON i.id = a.image_id
                  JOIN images_imageset st ON st.id = i.image_set_id
                  WHERE st.team_id = t.id AND a.user_id = $1 AND NOT a.deleted),
                (SELECT count(*) FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id
                  WHERE st.team_id = t.id AND i.creator_id = $1)
           FROM users_team t JOIN users_teammembership m ON m.team_id = t.id
          WHERE m.user_id = $1 ORDER BY t.name",
    )
    .bind(uid)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let days: Vec<(chrono::NaiveDate, i64)> = sqlx::query_as(
        "SELECT d::date, (SELECT count(*) FROM annotations_annotation a
                           WHERE a.user_id = $1 AND NOT a.deleted AND a.time::date = d::date)
           FROM generate_series(current_date - 29, current_date, interval '1 day') d ORDER BY 1",
    )
    .bind(uid)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(json!({
        "annotations": annotations, "images": images, "verifications": verifications,
        "teams": teams.iter().map(|(id, name, a, i)| json!({"id": id, "name": name, "annotations": a, "images": i})).collect::<Vec<_>>(),
        "per_day": days.iter().map(|(d, n)| json!({"day": d.to_string(), "annotations": n})).collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::plausible;

    #[test]
    fn addresses_need_a_name_an_at_and_a_dotted_domain() {
        assert!(plausible("a.b@hs-flensburg.de"));
        assert!(!plausible("nobody"));
        assert!(!plausible("@x.de"));
        assert!(!plausible("a@b"));
        assert!(!plausible("a b@c.de"));
        assert!(!plausible("a@b@c.de"));
    }
}
