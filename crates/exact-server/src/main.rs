use anyhow::Context;
use exact_api::{router, AppState};
use exact_core::Config;
use tracing_subscriber::Layer;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer().with_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info,tower_http=info".into()),
            ),
        )
        // warnings and errors also go to the log the site admins read in the browser, whatever the console is set to show
        .with(ErrorLogLayer.with_filter(tracing_subscriber::filter::LevelFilter::WARN))
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

/// Feeds `exact_api::errorlog` with every WARN and ERROR event.
struct ErrorLogLayer;

#[derive(Default)]
struct Text {
    message: String,
    fields: Vec<String>,
}

impl tracing::field::Visit for Text {
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        if field.name() == "message" {
            self.message = format!("{value:?}");
        } else {
            self.fields.push(format!("{}={value:?}", field.name()));
        }
    }
}

impl<S: tracing::Subscriber> Layer<S> for ErrorLogLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _ctx: tracing_subscriber::layer::Context<'_, S>) {
        let mut t = Text::default();
        event.record(&mut t);
        let message = if t.fields.is_empty() {
            t.message
        } else {
            format!("{} {}", t.message, t.fields.join(" "))
        };
        let level = if *event.metadata().level() == tracing::Level::ERROR {
            "ERROR"
        } else {
            "WARN"
        };
        exact_api::errorlog::global().push(level, event.metadata().target(), message);
    }
}
