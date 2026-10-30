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
use sqlx::{
    postgres::{PgConnectOptions, PgPoolOptions},
    ConnectOptions,
};
use std::time::Duration;

pub async fn connect(cfg: &Config) -> Result<PgPool> {
    let mut options: PgConnectOptions = cfg
        .database_url()
        .parse()
        .map_err(|e| Error::Internal(format!("database settings are not usable: {e}")))?;
    if let Some(ms) = cfg.slow_sql_ms {
        // `EXACT_SLOW_SQL_MS`: the statements that take longer than this are logged with their text, to find what is slow on real data
        options = options.log_slow_statements(log::LevelFilter::Warn, Duration::from_millis(ms));
    }
    PgPoolOptions::new()
        .max_connections(10)
        .acquire_timeout(Duration::from_secs(cfg.db_connect_timeout_secs))
        .connect_with(options)
        .await
        .map_err(|e| Error::Internal(format!("database connection failed: {e}")))
}

pub(crate) fn internal(e: sqlx::Error) -> Error {
    Error::Internal(e.to_string())
}
