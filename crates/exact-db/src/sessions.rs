//! Server-side sessions for the browser UI. Lives in our own additive table (`exact_rust_session`) so
//! Django can keep running against the same database during the transition.

use crate::internal;
use chrono::{DateTime, Utc};
use exact_core::Result;
use sqlx::PgPool;

pub const MIGRATIONS: [&str; 10] = [
    include_str!("../migrations/0001_sessions.sql"),
    include_str!("../migrations/0002_session_impersonation.sql"),
    include_str!("../migrations/0003_challenges_invitations.sql"),
    include_str!("../migrations/0004_image_repairs.sql"),
    include_str!("../migrations/0005_pyramid_registration.sql"),
    include_str!("../migrations/0006_registration_jobs.sql"),
    include_str!("../migrations/0007_registration_plugins.sql"),
    include_str!("../migrations/0008_registration_jobs_in_pluginjob.sql"),
    include_str!("../migrations/0009_user_read_only.sql"),
    include_str!("../migrations/0010_user_welcomed.sql"),
];

/// Whether the tables that every request needs exist: the account flags (`exact_rust_user_flags` with `welcomed_at`, read by each
/// authentication) and the sessions. When not, `exact-cli migrate` has not been run for this version.
pub async fn schema_ready(pool: &PgPool) -> Result<bool> {
    sqlx::query_scalar(
        "SELECT to_regclass('exact_rust_session') IS NOT NULL AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'exact_rust_user_flags' AND column_name = 'welcomed_at')",
    )
    .fetch_one(pool)
    .await
    .map_err(internal)
}

pub async fn migrate(pool: &PgPool) -> Result<()> {
    for m in MIGRATIONS {
        sqlx::raw_sql(m).execute(pool).await.map_err(internal)?;
    }
    Ok(())
}

pub async fn create(
    pool: &PgPool,
    key: &str,
    csrf: &str,
    user_id: i64,
    impersonator_id: Option<i64>,
    expires_at: DateTime<Utc>,
) -> Result<()> {
    sqlx::query("INSERT INTO exact_rust_session (key, csrf, user_id, impersonator_id, expires_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(key)
        .bind(csrf)
        .bind(user_id)
        .bind(impersonator_id)
        .bind(expires_at)
        .execute(pool)
        .await
        .map_err(internal)?;
    Ok(())
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SessionRow {
    pub user_id: i64,
    pub csrf: String,
    pub impersonator_id: Option<i64>,
}

/// A valid, unexpired session.
pub async fn lookup(pool: &PgPool, key: &str) -> Result<Option<SessionRow>> {
    sqlx::query_as("SELECT user_id, csrf, impersonator_id FROM exact_rust_session WHERE key = $1 AND expires_at > now()")
        .bind(key)
        .fetch_optional(pool)
        .await
        .map_err(internal)
}

pub async fn delete(pool: &PgPool, key: &str) -> Result<()> {
    sqlx::query("DELETE FROM exact_rust_session WHERE key = $1")
        .bind(key)
        .execute(pool)
        .await
        .map_err(internal)?;
    Ok(())
}

pub async fn purge_expired(pool: &PgPool) -> Result<u64> {
    Ok(
        sqlx::query("DELETE FROM exact_rust_session WHERE expires_at <= now()")
            .execute(pool)
            .await
            .map_err(internal)?
            .rows_affected(),
    )
}
