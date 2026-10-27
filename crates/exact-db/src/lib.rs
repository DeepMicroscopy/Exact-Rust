//! Database access. The Rust server runs against the *existing Django schema* (no migrations of
//! its own until cutover); `schema` verifies that the live schema is what we were built for.

pub mod challenges;
pub mod invitations;
pub mod passkeys;
pub mod registration;
pub mod schema;
pub mod sessions;
pub mod users;

pub use sqlx::PgPool;

use exact_core::{Config, Error, Result};
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;

pub async fn connect(cfg: &Config) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(cfg.db_connect_timeout_secs))
        .connect(&cfg.database_url())
        .await
        .map_err(|e| Error::Internal(format!("database connection failed: {e}")))
}

pub(crate) fn internal(e: sqlx::Error) -> Error {
    Error::Internal(e.to_string())
}
