use anyhow::Context;
use exact_api::{router, AppState};
use exact_core::Config;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,tower_http=info".into()),
        )
        .init();
    let cfg = Config::from_env()?;
    let pool = exact_db::connect(&cfg).await?;
    if !exact_db::sessions::schema_ready(&pool).await? {
        anyhow::bail!(
            "the database {} has not been migrated for this version: run `exact-cli migrate --confirm-db {}` (after every update of the binary) and start again",
            cfg.db_name,
            cfg.db_name
        );
    }
    exact_api::repair::startup(&pool).await.ok(); // table may not exist before `exact-cli migrate`
    let listener = tokio::net::TcpListener::bind(&cfg.listen)
        .await
        .with_context(|| format!("binding {}", cfg.listen))?;
    tracing::info!(listen = %cfg.listen, db = %cfg.db_name, "exact-server starting");
    axum::serve(listener, router(AppState::new(pool, &cfg)?))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}
