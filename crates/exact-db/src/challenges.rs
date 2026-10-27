//! One-time WebAuthn challenges, bound to a purpose (and optionally a user) and a short lifetime.

use crate::internal;
use chrono::{Duration, Utc};
use exact_core::Result;
use sqlx::PgPool;

pub const TTL_SECONDS: i64 = 300;

pub async fn create(
    pool: &PgPool,
    state: &str,
    challenge: &str,
    purpose: &str,
    user_id: Option<i64>,
) -> Result<()> {
    sqlx::query("DELETE FROM exact_rust_challenge WHERE expires_at <= now()")
        .execute(pool)
        .await
        .map_err(internal)?;
    sqlx::query("INSERT INTO exact_rust_challenge (state, challenge, purpose, user_id, expires_at) VALUES ($1, $2, $3, $4, $5)")
        .bind(state)
        .bind(challenge)
        .bind(purpose)
        .bind(user_id)
        .bind(Utc::now() + Duration::seconds(TTL_SECONDS))
        .execute(pool)
        .await
        .map_err(internal)?;
    Ok(())
}

/// Consumes the challenge (single use). Returns (challenge, user_id) if it existed, matched the purpose and was fresh.
pub async fn take(
    pool: &PgPool,
    state: &str,
    purpose: &str,
) -> Result<Option<(String, Option<i64>)>> {
    sqlx::query_as("DELETE FROM exact_rust_challenge WHERE state = $1 AND purpose = $2 AND expires_at > now() RETURNING challenge, user_id")
        .bind(state)
        .bind(purpose)
        .fetch_optional(pool)
        .await
        .map_err(internal)
}
