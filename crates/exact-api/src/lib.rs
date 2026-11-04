//! HTTP layer. `/api/v2` is the real API; the v1/legacy compat adapters (for `exact-sync`) live in
//! `compat` and are added in Phase 3+.

use axum::{extract::State, http::StatusCode, routing::get, Json, Router};
use chrono_tz::Tz;
use serde_json::{json, Value};
use sqlx::PgPool;
use tower_http::{
    compression::{
        predicate::{DefaultPredicate, NotForContentType, Predicate},
        CompressionLayer,
    },
    trace::TraceLayer,
};

pub mod auth;
pub mod cascade;
pub mod compat;
pub mod error;
pub mod errorlog;
pub mod health;
pub mod media;
pub mod page;
pub mod repair;
pub mod slides;
pub mod upload;
pub mod v2;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    /// Zone of naive datetimes in API output (Django `TIME_ZONE`, `USE_TZ = False`).
    pub tz: Tz,
    pub cookie_secure: bool,
    pub session_seconds: i64,
    pub fido_rp_id: String,
    pub fido_rp_name: String,
    pub auth_cache: auth::AuthCache,
    pub slides: slides::SlideState,
    pub static_dir: Option<std::path::PathBuf>,
    pub repairs: repair::Progress,
    /// `SQL_DATABASE`: part of the image set folder names (`<db>_<team>_<set>`), as in Django.
    pub db_name: String,
    /// `MEDIA_ROOT`: uploaded files of file fields, served at `/media/`.
    pub media_root: std::path::PathBuf,
    /// A line for the top of the first-login greeting (`EXACT_WELCOME_NOTICE`).
    pub welcome_notice: Option<String>,
    /// Who used the UI or a token lately (the system health shows the active users).
    pub activity: health::Activity,
}

impl AppState {
    pub fn new(pool: PgPool, cfg: &exact_core::Config) -> exact_core::Result<Self> {
        let tz = cfg.time_zone.parse().map_err(|_| {
            exact_core::Error::Config(format!("unknown TIME_ZONE {}", cfg.time_zone))
        })?;
        Ok(Self {
            pool,
            tz,
            cookie_secure: cfg.cookie_secure,
            session_seconds: cfg.session_seconds,
            fido_rp_id: cfg.fido_rp_id.clone(),
            fido_rp_name: cfg.fido_rp_name.clone(),
            auth_cache: auth::AuthCache::new(cfg.auth_cache_seconds),
            slides: slides::SlideState::new(cfg.image_path.clone(), cfg.cache_dir.clone()),
            static_dir: cfg.static_dir.clone(),
            repairs: Default::default(),
            db_name: cfg.db_name.clone(),
            media_root: cfg.media_root.clone(),
            welcome_notice: cfg.welcome_notice.clone(),
            activity: Default::default(),
        })
    }
}

pub fn router(state: AppState) -> Router {
    let static_dir = state.static_dir.clone();
    let media_root = state.media_root.clone();
    let r = Router::new()
        .route("/health", get(health))
        .route("/api/version", get(version))
        // exact-sync calls this on connect; Django answers 200 with the server time (no auth needed).
        .route("/timesync/", get(timesync))
        .merge(compat::routes())
        .merge(slides::routes())
        .merge(repair::routes())
        .merge(upload::routes())
        .merge(v2::image_sets::legacy_routes())
        .merge(v2::catalog::legacy_routes())
        .merge(v2::annotation_media::legacy_routes())
        .merge(v2::segmentation::legacy_routes())
        .merge(v2::move_image::legacy_routes())
        .merge(v2::crop::legacy_routes())
        .merge(v2::registration::legacy_routes())
        .merge(v2::routes())
        // request bodies with files (bitmaps, media files) are larger than axum's default 2 MB
        .layer(axum::extract::DefaultBodyLimit::max(1 << 30))
        .with_state(state);
    // uploaded files (file fields); public like Django's `/media/`
    let r = r.nest_service("/media", tower_http::services::ServeDir::new(media_root));
    // the single-page app: static files, every other path falls back to index.html (client-side routing)
    let r = match static_dir {
        Some(dir) => {
            use tower_http::services::{ServeDir, ServeFile};
            r.fallback_service(ServeDir::new(&dir).fallback(ServeFile::new(dir.join("index.html"))))
        }
        None => r,
    };
    // downloads (application/zip) stay uncompressed so that clients see Content-Length
    r.layer(CompressionLayer::new().compress_when(
        DefaultPredicate::new().and(NotForContentType::const_new("application/zip")),
    ))
    .layer(TraceLayer::new_for_http())
}

async fn health(State(s): State<AppState>) -> (StatusCode, Json<Value>) {
    match sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&s.pool)
        .await
    {
        Ok(_) => (
            StatusCode::OK,
            Json(json!({"status": "ok", "database": "up"})),
        ),
        Err(e) => {
            tracing::error!("health check failed: {e}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                Json(json!({"status": "degraded", "database": "down"})),
            )
        }
    }
}

async fn version() -> Json<Value> {
    Json(json!({"server": "exact-rust", "version": env!("CARGO_PKG_VERSION"), "api": ["v2"]}))
}

async fn timesync() -> axum::response::Response {
    use axum::response::IntoResponse;
    error::with_allow(timesync_body().await.into_response(), "OPTIONS, GET")
}

async fn timesync_body() -> Json<Value> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    Json(json!({"unixtime": now}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn app() -> Router {
        // lazy pool: never connects unless a handler needs the DB
        router(AppState {
            pool: PgPool::connect_lazy("postgres://x:x@127.0.0.1:1/x").unwrap(),
            tz: chrono_tz::Europe::Berlin,
            cookie_secure: false,
            session_seconds: 60,
            fido_rp_id: "localhost".into(),
            fido_rp_name: "EXACT".into(),
            auth_cache: auth::AuthCache::new(0),
            slides: slides::SlideState::new("./images".into(), "./cache".into()),
            static_dir: None,
            repairs: Default::default(),
            db_name: "exact".into(),
            media_root: "./media".into(),
            welcome_notice: None,
            activity: Default::default(),
        })
    }

    async fn get(path: &str) -> (StatusCode, Value) {
        let r = app()
            .oneshot(Request::get(path).body(Body::empty()).unwrap())
            .await
            .unwrap();
        let st = r.status();
        let b = r.into_body().collect().await.unwrap().to_bytes();
        (st, serde_json::from_slice(&b).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn timesync_matches_django_shape() {
        let (st, v) = get("/timesync/").await;
        assert_eq!(st, StatusCode::OK);
        assert!(v["unixtime"].as_f64().unwrap() > 1.7e9);
    }

    #[tokio::test]
    async fn version_lists_v2() {
        let (st, v) = get("/api/version").await;
        assert_eq!(st, StatusCode::OK);
        assert_eq!(v["api"][0], "v2");
    }
}
