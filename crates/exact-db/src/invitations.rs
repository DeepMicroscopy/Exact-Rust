//! Invite and password-reset links. There is no self-registration and no e-mail: an administrator creates a
//! link and hands it over; only the sha256 of the token is stored, the token itself is shown once.

use crate::internal;
use chrono::{DateTime, Utc};
use exact_core::{Error, Result};
use sqlx::PgPool;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Invitation {
    pub id: i64,
    pub purpose: String,
    pub email: String,
    pub user_id: Option<i64>,
    pub team_ids: Vec<i64>,
    pub note: String,
    pub created_by: Option<i64>,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub used_at: Option<DateTime<Utc>>,
    pub used_by: Option<i64>,
    pub revoked_at: Option<DateTime<Utc>>,
}

impl Invitation {
    pub fn status(&self) -> &'static str {
        if self.used_at.is_some() {
            "used"
        } else if self.revoked_at.is_some() {
            "revoked"
        } else if self.expires_at <= Utc::now() {
            "expired"
        } else {
            "pending"
        }
    }
}

const COLS: &str = "id, purpose, email, user_id, team_ids, note, created_by, created_at, expires_at, used_at, used_by, revoked_at";

#[allow(clippy::too_many_arguments)]
pub async fn create(
    pool: &PgPool,
    token_hash: &str,
    purpose: &str,
    email: &str,
    user_id: Option<i64>,
    team_ids: &[i64],
    note: &str,
    created_by: i64,
    expires_at: DateTime<Utc>,
) -> Result<Invitation> {
    sqlx::query_as(&format!(
        "INSERT INTO exact_rust_invitation (token_hash, purpose, email, user_id, team_ids, note, created_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING {COLS}"
    ))
    .bind(token_hash)
    .bind(purpose)
    .bind(email)
    .bind(user_id)
    .bind(team_ids)
    .bind(note)
    .bind(created_by)
    .bind(expires_at)
    .fetch_one(pool)
    .await
    .map_err(internal)
}

/// Only pending (unused, unrevoked, unexpired) invitations.
pub async fn pending_by_hash(pool: &PgPool, token_hash: &str) -> Result<Option<Invitation>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM exact_rust_invitation WHERE token_hash = $1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()"))
        .bind(token_hash)
        .fetch_optional(pool)
        .await
        .map_err(internal)
}

/// Pass `created_by = None` to list everything (site admins).
pub async fn list(pool: &PgPool, created_by: Option<i64>) -> Result<Vec<Invitation>> {
    sqlx::query_as(&format!("SELECT {COLS} FROM exact_rust_invitation WHERE ($1::bigint IS NULL OR created_by = $1) ORDER BY id DESC LIMIT 500"))
        .bind(created_by)
        .fetch_all(pool)
        .await
        .map_err(internal)
}

pub async fn get(pool: &PgPool, id: i64) -> Result<Option<Invitation>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM exact_rust_invitation WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(internal)
}

pub async fn revoke(pool: &PgPool, id: i64) -> Result<bool> {
    Ok(sqlx::query("UPDATE exact_rust_invitation SET revoked_at = now() WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL").bind(id).execute(pool).await.map_err(internal)?.rows_affected() > 0)
}

pub struct NewUser<'a> {
    pub username: &'a str,
    pub password_hash: &'a str,
    pub email: &'a str,
    pub first_name: &'a str,
    pub last_name: &'a str,
}

/// Redeems an invite in one transaction: creates the user (+ preferences row, like Django's post_save signal),
/// joins the invited teams and marks the invitation used. Returns the new user id.
pub async fn accept_invite(pool: &PgPool, token_hash: &str, u: &NewUser<'_>) -> Result<i64> {
    let mut tx = pool.begin().await.map_err(internal)?;
    let inv: Option<Invitation> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM exact_rust_invitation WHERE token_hash = $1 AND purpose = 'invite' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE"
    ))
    .bind(token_hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let Some(inv) = inv else {
        return Err(Error::Invalid(
            "This invitation is invalid, expired or already used.".into(),
        ));
    };
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO users_user (password, last_login, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined, points)
         VALUES ($1, NULL, false, $2, $3, $4, $5, false, true, now(), 0) RETURNING id",
    )
    .bind(u.password_hash)
    .bind(u.username)
    .bind(u.first_name)
    .bind(u.last_name)
    .bind(u.email)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(d) if d.is_unique_violation() => Error::Conflict("A user with that username already exists.".into()),
        other => internal(other),
    })?;
    sqlx::query("INSERT INTO users_userpreferences (user_id, frontend, is_site_admin) VALUES ($1, 2, false)").bind(id).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("INSERT INTO users_teammembership (team_id, user_id, is_admin) SELECT t.id, $2, false FROM users_team t WHERE t.id = ANY($1)")
        .bind(&inv.team_ids)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE exact_rust_invitation SET used_at = now(), used_by = $2 WHERE id = $1")
        .bind(inv.id)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(id)
}

/// Redeems a reset link: sets the new password hash, ends all sessions of that user. Returns the user id.
pub async fn accept_reset(pool: &PgPool, token_hash: &str, password_hash: &str) -> Result<i64> {
    let mut tx = pool.begin().await.map_err(internal)?;
    let inv: Option<Invitation> = sqlx::query_as(&format!(
        "SELECT {COLS} FROM exact_rust_invitation WHERE token_hash = $1 AND purpose = 'reset' AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE"
    ))
    .bind(token_hash)
    .fetch_optional(&mut *tx)
    .await
    .map_err(internal)?;
    let Some((inv, uid)) = inv.and_then(|i| i.user_id.map(|u| (i, u))) else {
        return Err(Error::Invalid(
            "This link is invalid, expired or already used.".into(),
        ));
    };
    sqlx::query("UPDATE users_user SET password = $2 WHERE id = $1")
        .bind(uid)
        .bind(password_hash)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("DELETE FROM exact_rust_session WHERE user_id = $1")
        .bind(uid)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    sqlx::query("UPDATE exact_rust_invitation SET used_at = now(), used_by = $2 WHERE id = $1")
        .bind(inv.id)
        .bind(uid)
        .execute(&mut *tx)
        .await
        .map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(uid)
}

pub async fn username_taken(pool: &PgPool, username: &str) -> Result<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users_user WHERE username = $1)")
        .bind(username)
        .fetch_one(pool)
        .await
        .map_err(internal)
}
