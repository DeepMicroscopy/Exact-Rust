//! Plugin job queue for workers: `POST /api/v2/plugin-jobs/claim`.
//!
//! In Django workers read the job list and then `PATCH attached_worker`, so two workers can take the same job. The claim
//! is one statement that selects the oldest free job and marks it, with `FOR UPDATE SKIP LOCKED`: every job goes to
//! exactly one worker, concurrent claims do not wait for each other.

use crate::{
    auth::{authenticate, require_model_perm},
    compat::{
        engine::{db_err, snake_keys, Ctx},
        specs,
    },
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::State,
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::Value;

/// `{"worker": "name", "plugin": 3}` (`plugin` optional). Answers the claimed job (200) or 204 when nothing is waiting.
/// Free means: no worker attached, not finished, no error, no result yet (as QueueRunner's `job.result is None`). Only jobs of images in the caller's teams are offered.
pub async fn claim_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::POST).await?,
        &Method::PATCH,
        "processing",
        "pluginjob",
    )
    .await?;
    let d: serde_json::Map<String, Value> = match serde_json::from_slice(&body) {
        Ok(Value::Object(m)) => m,
        _ if body.is_empty() => Default::default(),
        _ => {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "Expected a JSON object.",
            ))
        }
    };
    let worker = d
        .get("worker")
        .and_then(Value::as_str)
        .filter(|w| !w.is_empty() && w.chars().count() <= 200)
        .ok_or_else(|| {
            ApiError::detail(
                StatusCode::BAD_REQUEST,
                "worker: a name of 1 to 200 characters is required.",
            )
        })?
        .to_string();
    let plugin = d.get("plugin").and_then(Value::as_i64);
    crate::v2::jobs::seen(&worker, &["plugin"], &[]);
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost")
        .to_string();
    Ok(match claim_plugin(&s, &p, &host, &worker, plugin).await? {
        Some(job) => Json(job).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

/// Marks the oldest free plugin job of the caller's teams as taken by `worker`; the job as the API shows it, or none.
pub(crate) async fn claim_plugin(
    s: &AppState,
    p: &crate::auth::Principal,
    host: &str,
    worker: &str,
    plugin: Option<i64>,
) -> ApiResult<Option<Value>> {
    let viewer = p.viewer();
    let teams: Option<Vec<i64>> = viewer.token_teams.as_ref().map(|t| t.to_vec());
    let id: Option<i32> = sqlx::query_scalar(
        "UPDATE processing_pluginjob SET attached_worker = $1, updated_time = now() WHERE id = ( \
           SELECT q.id FROM processing_pluginjob q \
           WHERE (q.attached_worker IS NULL OR q.attached_worker = '') AND q.processing_complete < 100 \
             AND q.plugin_id IN (SELECT id FROM processing_plugin WHERE plugin_type = 1) AND q.error_message IS NULL AND ($2::int IS NULL OR q.plugin_id = $2) \
             AND NOT EXISTS (SELECT 1 FROM processing_pluginresult r WHERE r.job_id = q.id) \
             AND q.image_id IN (SELECT i.id FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
                 WHERE st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $3 \
                   AND ($4::bigint[] IS NULL OR team_id = ANY($4)))) \
           ORDER BY q.created_time, q.id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id",
    )
    .bind(worker)
    .bind(plugin.map(|v| v as i32))
    .bind(viewer.id)
    .bind(teams)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    let Some(id) = id else {
        return Ok(None);
    };
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: host.to_string(),
        v2: true,
    };
    let job = crate::compat::engine::serialize_ids(&ctx, specs::by_name("PluginJob"), &[id as i64])
        .await?
        .into_iter()
        .next()
        .map(snake_keys)
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    Ok(Some(job))
}
