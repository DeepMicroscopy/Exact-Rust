//! One queue for everything that is computed by workers: `GET /api/v2/jobs` lists registration jobs and plugin
//! (image analysis) jobs together, `POST /api/v2/jobs/claim` hands a worker the oldest waiting job of the kinds it can do,
//! `POST /api/v2/jobs/{kind}/{id}/restart` and `DELETE /api/v2/jobs/{kind}/{id}` manage them.
//!
//! Both kinds are rows of Django's `processing_pluginjob` (shared with EXACT): the kind is the type of the job's plugin
//! (1 image analysis, 2 registration). This is the common face: the same status words (`queued`, `running`, `done`,
//! `failed`), the same claim, the same list. Their specific endpoints (`/api/v2/plugin-jobs/claim`,
//! `/api/v2/registration-jobs/...`) stay for the workers written against them.

use crate::{
    auth::{authenticate, require_user, Principal},
    cascade,
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    v2::{processing, registration},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use exact_db::users;
use serde_json::{json, Map, Value};
use sqlx::Row;

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/jobs", get(list_h))
        .route("/api/v2/jobs/claim", post(claim_h))
        .route("/api/v2/jobs/{kind}/{id}", delete(remove_h))
        .route("/api/v2/jobs/{kind}/{id}/restart", post(restart_h))
}

const KINDS: [&str; 2] = ["registration", "plugin"];

/// Workers that asked for work lately: name -> (kinds, when). Process-local; it tells the screens whether anybody is
/// listening for the jobs that wait (an idle worker leaves no trace in the tables).
type Seen = std::sync::Mutex<
    std::collections::HashMap<String, (Vec<String>, Vec<i64>, std::time::Instant)>,
>;
static SEEN: std::sync::OnceLock<Seen> = std::sync::OnceLock::new();

/// Remembers a worker's poll (any claim endpoint calls this, also when there was nothing to do): the kinds of jobs it
/// does and the plugins it serves.
pub(crate) fn seen(worker: &str, kinds: &[&str], plugins: &[i64]) {
    let map = SEEN.get_or_init(Default::default);
    if let Ok(mut m) = map.lock() {
        m.insert(
            worker.to_string(),
            (
                kinds.iter().map(|k| k.to_string()).collect(),
                plugins.to_vec(),
                std::time::Instant::now(),
            ),
        );
        m.retain(|_, (_, _, t)| t.elapsed().as_secs() < 3600);
    }
}

/// The workers that asked for work in the last 90 seconds, most recent first.
pub(crate) fn workers_seen() -> Vec<Value> {
    let mut out: Vec<(u64, Value)> = SEEN
        .get()
        .and_then(|m| m.lock().ok())
        .map(|m| {
            m.iter()
                .filter(|(_, (_, _, t))| t.elapsed().as_secs() < 90)
                .map(|(name, (kinds, plugins, t))| {
                    (
                        t.elapsed().as_secs(),
                        json!({"name": name, "kinds": kinds, "plugins": plugins, "seen_seconds_ago": t.elapsed().as_secs()}),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_by_key(|(t, _)| *t);
    out.into_iter().map(|(_, v)| v).collect()
}

fn bad(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
}

pub(crate) fn plugin_job_status_sql() -> &'static str {
    "CASE WHEN q.error_message IS NOT NULL THEN 'failed' \
          WHEN EXISTS (SELECT 1 FROM processing_pluginresult r WHERE r.job_id = q.id) OR q.processing_complete >= 100 THEN 'done' \
          WHEN q.attached_worker IS NOT NULL AND q.attached_worker <> '' THEN 'running' ELSE 'queued' END"
}

/// Jobs of the caller's teams, newest first. `?kind=registration|plugin`, `?status=queued|running|done|failed`,
/// `?image=` (the image of the job, or the target of a registration), `?limit=` (default 100, at most 500).
async fn list_h(State(s): State<AppState>, headers: HeaderMap, uri: Uri) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let q: std::collections::HashMap<String, String> =
        form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    if q.get("kind").is_some_and(|k| !KINDS.contains(&k.as_str())) {
        return Err(bad("kind must be registration or plugin."));
    }
    let limit = q
        .get("limit")
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(100)
        .clamp(1, 500);
    let v = p.viewer();
    let visible = "IN (SELECT i.id FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $4 AND ($5::bigint[] IS NULL OR team_id = ANY($5))))";
    let sql = format!(
        "SELECT * FROM ( \
           SELECT CASE pl.plugin_type WHEN 2 THEN 'registration' ELSE 'plugin' END AS kind, q.id::bigint AS id, ({status}) AS status, \
                  q.image_id::bigint AS image, \
                  COALESCE((SELECT array_agg(ji.image_id::bigint ORDER BY ji.position) FROM processing_pluginjobimage ji WHERE ji.job_id = q.id), ARRAY[q.image_id::bigint]) AS images, \
                  q.plugin_id::bigint AS plugin, pl.name::text AS plugin_name, \
                  CASE WHEN pl.plugin_type = 2 THEN NULL ELSE (q.processing_complete / 100.0)::float8 END AS progress, \
                  NULLIF(q.attached_worker, '')::text AS worker, q.error_message::text AS error, q.creator_id::bigint AS creator, \
                  q.created_time AS created, \
                  CASE WHEN pl.plugin_type = 2 AND q.attached_worker IS NOT NULL AND q.attached_worker <> '' AND q.error_message IS NULL \
                            AND q.processing_complete < 100 THEN q.updated_time END AS started, \
                  CASE WHEN pl.plugin_type = 2 THEN CASE WHEN q.error_message IS NOT NULL OR q.processing_complete >= 100 THEN q.updated_time END \
                       ELSE (SELECT r.completed_time FROM processing_pluginresult r WHERE r.job_id = q.id LIMIT 1) END AS finished, \
                  CASE WHEN pl.plugin_type = 2 THEN (SELECT r.id::bigint FROM images_imageregistration r WHERE r.source_image_id = q.image_id \
                            AND r.target_image_id = (SELECT ji.image_id FROM processing_pluginjobimage ji WHERE ji.job_id = q.id AND ji.position = 1) LIMIT 1) \
                       ELSE (SELECT r.id::bigint FROM processing_pluginresult r WHERE r.job_id = q.id LIMIT 1) END AS result \
           FROM processing_pluginjob q JOIN processing_plugin pl ON pl.id = q.plugin_id WHERE q.image_id {visible} \
         ) u \
         WHERE ($1::text IS NULL OR u.kind = $1) AND ($2::text IS NULL OR u.status = $2) \
           AND ($3::bigint IS NULL OR $3 = ANY(u.images)) \
         ORDER BY u.created DESC NULLS LAST, u.id DESC LIMIT {limit}",
        status = plugin_job_status_sql(),
    );
    let rows = sqlx::query(&sql)
        .bind(q.get("kind"))
        .bind(q.get("status"))
        .bind(q.get("image").and_then(|v| v.parse::<i64>().ok()))
        .bind(v.id)
        .bind(v.token_teams)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    let t = |r: &sqlx::postgres::PgRow, i: usize| {
        r.get::<Option<chrono::DateTime<chrono::Utc>>, _>(i)
            .map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Micros, true))
    };
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "kind": r.get::<String, _>(0), "id": r.get::<i64, _>(1), "status": r.get::<String, _>(2),
                "image": r.get::<i64, _>(3), "images": r.get::<Vec<i64>, _>(4),
                "plugin": r.get::<Option<i64>, _>(5), "plugin_name": r.get::<Option<String>, _>(6),
                "progress": r.get::<Option<f64>, _>(7), "worker": r.get::<Option<String>, _>(8),
                "error": r.get::<Option<String>, _>(9), "creator": r.get::<Option<i64>, _>(10),
                "created_at": t(r, 11), "started_at": t(r, 12), "finished_at": t(r, 13),
                "result": if r.get::<String, _>(2) == "done" || r.get::<String, _>(0) == "plugin" { r.get::<Option<i64>, _>(14) } else { None },
            })
        })
        .collect();
    Ok(Json(json!({"items": items, "workers": workers_seen()})).into_response())
}

fn object(body: &[u8]) -> ApiResult<Map<String, Value>> {
    if body.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(bad("Expected a JSON object.")),
    }
}

/// `{"worker": "name", "kinds": ["registration", "plugin"], "plugin": 3}`: `kinds` (default: all) are the kinds the worker
/// can do, `plugin` limits plugin jobs to one plugin. The oldest waiting job of those kinds is marked as taken. Answers
/// `{"kind", "job"}` with the job as the kind's own claim shows it, or 204. A kind the account may not work on is skipped.
async fn claim_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    let worker = d
        .get("worker")
        .and_then(Value::as_str)
        .filter(|w| !w.is_empty() && w.chars().count() <= 200)
        .ok_or_else(|| bad("worker: a name of 1 to 200 characters is required."))?
        .to_string();
    let kinds: Vec<String> = match d.get("kinds") {
        None => KINDS.iter().map(|k| k.to_string()).collect(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|k| k.as_str().map(String::from))
            .collect(),
        Some(_) => return Err(bad("kinds must be a list.")),
    };
    if let Some(k) = kinds.iter().find(|k| !KINDS.contains(&k.as_str())) {
        return Err(bad(&format!("Unknown kind {k}.")));
    }
    let plugins: Option<Vec<i64>> = match d.get("plugins") {
        None => None,
        Some(Value::Array(a)) => Some(a.iter().filter_map(Value::as_i64).collect()),
        Some(_) => return Err(bad("plugins must be a list of plugin ids.")),
    };
    seen(
        &worker,
        &kinds.iter().map(String::as_str).collect::<Vec<_>>(),
        plugins.as_deref().unwrap_or(&[]),
    );
    let plugin = d.get("plugin").and_then(Value::as_i64);
    let mut allowed = Vec::new();
    for k in &kinds {
        let (app, codename) = match k.as_str() {
            "registration" => ("images", "change_imageregistration"),
            _ => ("processing", "change_pluginjob"),
        };
        if users::has_perm(&s.pool, &p.user, app, codename).await? {
            allowed.push(k.as_str());
        }
    }
    if allowed.is_empty() {
        return Err(ApiError::permission_denied());
    }
    // the kind with the oldest waiting job goes first, so that no kind starves the other
    let mut order: Vec<(chrono::DateTime<chrono::Utc>, &str)> = Vec::new();
    for k in allowed {
        let oldest: Option<chrono::DateTime<chrono::Utc>> = match k {
            "registration" => sqlx::query_scalar(
                "SELECT min(q.created_time) FROM processing_pluginjob q JOIN processing_plugin pl ON pl.id = q.plugin_id AND pl.plugin_type = 2 \
                 WHERE q.error_message IS NULL AND q.processing_complete < 100 \
                   AND (q.attached_worker IS NULL OR q.attached_worker = '' OR q.updated_time < now() - interval '30 minutes') \
                   AND ($1::bigint[] IS NULL OR q.plugin_id = ANY($1)) \
                   AND EXISTS (SELECT 1 FROM processing_pluginjobimage t WHERE t.job_id = q.id AND t.position = 1)",
            )
            .bind(plugins.as_deref())
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?,
            _ => sqlx::query_scalar(
                "SELECT min(q.created_time) FROM processing_pluginjob q JOIN processing_plugin pl ON pl.id = q.plugin_id AND pl.plugin_type = 1 \
                 WHERE (q.attached_worker IS NULL OR q.attached_worker = '') \
                 AND q.processing_complete < 100 AND q.error_message IS NULL AND ($1::int IS NULL OR q.plugin_id = $1) \
                 AND NOT EXISTS (SELECT 1 FROM processing_pluginresult r WHERE r.job_id = q.id)",
            )
            .bind(plugin.map(|v| v as i32))
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?,
        };
        if let Some(t) = oldest {
            order.push((t, k));
        }
    }
    order.sort();
    let host = headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost")
        .to_string();
    for (_, k) in order {
        let job = match k {
            "registration" => registration::claim_one(&s, &worker, plugins.as_deref()).await?,
            _ => processing::claim_plugin(&s, &p, &host, &worker, plugin).await?,
        };
        if let Some(job) = job {
            return Ok(Json(json!({"kind": k, "job": job})).into_response());
        }
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// The job as far as the caller may touch it: (is the creator or may work on the kind, status).
async fn actionable(s: &AppState, p: &Principal, kind: &str, id: i64) -> ApiResult<String> {
    let (plugin_type, perm): (i16, (&str, &str)) = match kind {
        "registration" => (2, ("images", "change_imageregistration")),
        "plugin" => (1, ("processing", "change_pluginjob")),
        _ => return Err(ApiError::not_found("Not found.")),
    };
    let sql = format!(
        "SELECT ({}), q.creator_id::bigint, q.image_id::bigint FROM processing_pluginjob q \
         JOIN processing_plugin pl ON pl.id = q.plugin_id AND pl.plugin_type = {plugin_type} WHERE q.id::bigint = $1",
        plugin_job_status_sql()
    );
    let r = sqlx::query(&sql)
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
    let r = r.ok_or_else(|| ApiError::not_found("Not found."))?;
    let (status, creator, image): (String, Option<i64>, i64) = (r.get(0), r.get(1), r.get(2));
    let visible: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE i.id = $1 AND st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $2))",
    )
    .bind(image)
    .bind(p.user.id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if !visible {
        return Err(ApiError::not_found("Not found."));
    }
    if creator != Some(p.user.id) && !users::has_perm(&s.pool, &p.user, perm.0, perm.1).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Only the creator of a job or a user who may change jobs can do this.",
        ));
    }
    Ok(status)
}

/// Removes a job: a waiting or running one is cancelled (a worker that still reports on it is told the job is gone), a
/// finished one disappears from the list. Plugin jobs take their results with them, as in EXACT.
async fn remove_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, i64)>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    actionable(&s, &p, &kind, id).await?;
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let results: Vec<i64> = sqlx::query_scalar(
        "SELECT id::bigint FROM processing_pluginresult WHERE job_id::bigint = $1",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    if !results.is_empty() {
        cascade::delete_rows(&mut tx, "processing_pluginresult", &results).await?;
    }
    cascade::delete_rows(&mut tx, "processing_pluginjob", &[id]).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Queues a failed job again (a plugin job also loses its partial results).
async fn restart_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((kind, id)): Path<(String, i64)>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let status = actionable(&s, &p, &kind, id).await?;
    if status != "failed" {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "Only a failed job can be restarted.",
        ));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let results: Vec<i64> = sqlx::query_scalar(
        "SELECT id::bigint FROM processing_pluginresult WHERE job_id::bigint = $1",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await
    .map_err(db_err)?;
    if !results.is_empty() {
        cascade::delete_rows(&mut tx, "processing_pluginresult", &results).await?;
    }
    sqlx::query(
        "UPDATE processing_pluginjob SET processing_complete = 0, error_message = NULL, error_detail = NULL, \
         attached_worker = NULL, created_time = now(), updated_time = now() WHERE id::bigint = $1",
    )
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}
