//! One-time repair of images whose file is damaged (see `exact_wsi::repair`): `POST /api/v2/images/{id}/repair`
//! rebuilds the file in a background job, the original stays next to it as a backup, `.../repair/restore` undoes it.
//! The image keeps its id, name, file name and annotations; only the file content changes.

use crate::{
    auth::{authenticate, require_model_perm},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    slides::viewer_image,
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc, Mutex,
    },
};

/// Live progress of running repairs, in 1/10000 (image id -> value); the database holds the durable state.
#[derive(Clone, Default)]
pub struct Progress(Arc<Mutex<HashMap<i64, Arc<AtomicU32>>>>);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/images/{pk}/repair", get(status).post(start))
        .route("/api/v2/images/{pk}/repair/restore", post(restore))
}

/// A repair interrupted by a restart can never finish: mark it failed.
pub async fn startup(pool: &sqlx::PgPool) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE exact_rust_image_repair SET status = 'failed', message = 'interrupted by a server restart', finished_at = now() WHERE status = 'running'")
        .execute(pool)
        .await?;
    Ok(())
}

fn row_json(r: &sqlx::postgres::PgRow, live: Option<f32>) -> Value {
    let status: String = r.get("status");
    let progress: f32 = r.get("progress");
    let backup: String = r.get("backup_file");
    json!({
        "status": status,
        "progress": if status == "running" { live.unwrap_or(progress) } else { progress },
        "message": r.get::<String, _>("message"),
        "backup_file": std::path::Path::new(&backup).file_name().map(|n| n.to_string_lossy().into_owned()),
        "levels": r.get::<Option<i32>, _>("levels"),
        "started_at": r.get::<chrono::DateTime<chrono::Utc>, _>("started_at").to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        "finished_at": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>("finished_at").map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
    })
}

async fn latest(s: &AppState, image_id: i64) -> ApiResult<Option<sqlx::postgres::PgRow>> {
    sqlx::query(
        "SELECT * FROM exact_rust_image_repair WHERE image_id = $1 ORDER BY id DESC LIMIT 1",
    )
    .bind(image_id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)
}

async fn status(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
) -> ApiResult<Json<Value>> {
    let img = viewer_image(&s, &headers, &pk).await?;
    let live = s.repairs.0.lock().ok().and_then(|m| {
        m.get(&img.id)
            .map(|p| p.load(Ordering::Relaxed) as f32 / 10_000.0)
    });
    Ok(Json(match latest(&s, img.id).await? {
        Some(r) => row_json(&r, live),
        None => json!({"status": "none"}),
    }))
}

async fn start(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::PUT).await?,
        &Method::PUT,
        "images",
        "image",
    )
    .await?;
    let img = viewer_image(&s, &headers, &pk).await?;
    let path = img.path(&s, 1, 1).to_string_lossy().into_owned();

    // only files with a detected defect are repaired
    let st = s.slides.clone();
    let p2 = path.clone();
    let issues = tokio::task::spawn_blocking(move || st.open_slide(&p2).map(|sl| sl.issues()))
        .await
        .map_err(|e| ApiError::from(exact_core::Error::Internal(e.to_string())))?
        .map_err(|e| {
            ApiError::detail(
                StatusCode::BAD_REQUEST,
                format!("The slide cannot be read: {e}"),
            )
        })?;
    if !issues.iter().any(|i| i == "damaged_pyramid") {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "This image has nothing to repair.",
        ));
    }

    let id: i64 = sqlx::query_scalar("INSERT INTO exact_rust_image_repair (image_id, status, started_by) VALUES ($1, 'running', $2) ON CONFLICT DO NOTHING RETURNING id")
        .bind(img.id)
        .bind(p.user.id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::detail(StatusCode::CONFLICT, "A repair of this image is already running."))?;

    let progress = Arc::new(AtomicU32::new(0));
    if let Ok(mut m) = s.repairs.0.lock() {
        m.insert(img.id, progress.clone());
    }
    let (state, image_id) = (s.clone(), img.id);
    tokio::task::spawn_blocking(move || {
        let report = exact_wsi::repair::repair_in_place(&path, &|v| {
            progress.store((v * 10_000.0) as u32, Ordering::Relaxed)
        });
        let handle = tokio::runtime::Handle::current();
        let _ = handle.block_on(async {
            match &report {
                Ok(r) => {
                    state.slides.forget(&path);
                    sqlx::query("UPDATE exact_rust_image_repair SET status = 'done', progress = 1, backup_file = $2, levels = $3, finished_at = now() WHERE id = $1")
                        .bind(id)
                        .bind(r.backup.to_string_lossy().into_owned())
                        .bind(r.levels as i32)
                        .execute(&state.pool)
                        .await
                }
                Err(e) => {
                    tracing::error!("repair of image {image_id} failed: {e}");
                    sqlx::query("UPDATE exact_rust_image_repair SET status = 'failed', message = $2, finished_at = now() WHERE id = $1")
                        .bind(id)
                        .bind(e.to_string())
                        .execute(&state.pool)
                        .await
                }
            }
        });
        if let Ok(mut m) = state.repairs.0.lock() {
            m.remove(&image_id);
        }
    });
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({"status": "running", "progress": 0.0})),
    ))
}

async fn restore(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(pk): Path<String>,
) -> ApiResult<Json<Value>> {
    require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::PUT).await?,
        &Method::PUT,
        "images",
        "image",
    )
    .await?;
    let img = viewer_image(&s, &headers, &pk).await?;
    let row = latest(&s, img.id)
        .await?
        .filter(|r| r.get::<String, _>("status") == "done")
        .ok_or_else(|| {
            ApiError::detail(StatusCode::CONFLICT, "There is no finished repair to undo.")
        })?;
    let (rid, backup): (i64, String) = (row.get("id"), row.get("backup_file"));
    let path = img.path(&s, 1, 1).to_string_lossy().into_owned();
    let p2 = path.clone();
    tokio::task::spawn_blocking(move || exact_wsi::repair::restore_backup(&p2, &backup))
        .await
        .map_err(|e| ApiError::from(exact_core::Error::Internal(e.to_string())))?
        .map_err(|e| ApiError::detail(StatusCode::CONFLICT, e.to_string()))?;
    s.slides.forget(&path);
    sqlx::query(
        "UPDATE exact_rust_image_repair SET status = 'restored', finished_at = now() WHERE id = $1",
    )
    .bind(rid)
    .execute(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(json!({"status": "restored"})))
}
