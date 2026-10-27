//! Passkeys, stored in the table of `django-passkeys` (`passkeys_userpasskey`) so enrolled keys keep working.

use crate::internal;
use chrono::{DateTime, Utc};
use exact_core::{Error, Result};
use sqlx::PgPool;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct Passkey {
    pub id: i32,
    pub name: String,
    pub enabled: bool,
    pub platform: String,
    pub added_on: DateTime<Utc>,
    pub last_used: Option<DateTime<Utc>>,
    pub credential_id: String,
    pub token: String,
    pub user_id: i64,
}

const COLS: &str =
    "id, name, enabled, platform, added_on, last_used, credential_id, token, user_id";

pub async fn by_credential_id(pool: &PgPool, credential_id: &str) -> Result<Option<Passkey>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM passkeys_userpasskey WHERE credential_id = $1"
    ))
    .bind(credential_id)
    .fetch_optional(pool)
    .await
    .map_err(internal)
}

pub async fn list_for_user(pool: &PgPool, user_id: i64) -> Result<Vec<Passkey>> {
    sqlx::query_as(&format!(
        "SELECT {COLS} FROM passkeys_userpasskey WHERE user_id = $1 ORDER BY id"
    ))
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(internal)
}

pub async fn insert(
    pool: &PgPool,
    user_id: i64,
    name: &str,
    platform: &str,
    credential_id: &str,
    token: &str,
) -> Result<()> {
    sqlx::query("INSERT INTO passkeys_userpasskey (user_id, name, enabled, platform, added_on, credential_id, token) VALUES ($1, $2, true, $3, now(), $4, $5)")
        .bind(user_id)
        .bind(name)
        .bind(platform)
        .bind(credential_id)
        .bind(token)
        .execute(pool)
        .await
        .map_err(|e| match e {
            sqlx::Error::Database(d) if d.is_unique_violation() => Error::Conflict("this passkey is already registered".into()),
            other => internal(other),
        })?;
    Ok(())
}

pub async fn touch(pool: &PgPool, id: i32) -> Result<()> {
    sqlx::query("UPDATE passkeys_userpasskey SET last_used = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(internal)?;
    Ok(())
}

pub async fn delete(pool: &PgPool, user_id: i64, id: i32) -> Result<bool> {
    Ok(
        sqlx::query("DELETE FROM passkeys_userpasskey WHERE id = $1 AND user_id = $2")
            .bind(id)
            .bind(user_id)
            .execute(pool)
            .await
            .map_err(internal)?
            .rows_affected()
            > 0,
    )
}

pub async fn update(
    pool: &PgPool,
    user_id: i64,
    id: i32,
    name: Option<&str>,
    enabled: Option<bool>,
) -> Result<bool> {
    Ok(sqlx::query("UPDATE passkeys_userpasskey SET name = COALESCE($3, name), enabled = COALESCE($4, enabled) WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .bind(name)
        .bind(enabled)
        .execute(pool)
        .await
        .map_err(internal)?
        .rows_affected()
        > 0)
}
