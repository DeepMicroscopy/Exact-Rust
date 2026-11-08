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
use serde_json::{json, Value};
use sqlx::Row;

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
    crate::v2::jobs::seen(
        &worker,
        &["plugin"],
        &plugin.into_iter().collect::<Vec<_>>(),
    );
    crate::v2::jobs::touch_plugins(&s.pool, &plugin.into_iter().collect::<Vec<_>>()).await;
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
    let mut job = job;
    // what a worker on the server needs to read the image and to say what it found: the file and the annotation types
    // (of the products of the image's set) a detection can be stored as
    let row = sqlx::query(
        "SELECT st.path, i.filename, st.id::bigint FROM processing_pluginjob q JOIN images_image i ON i.id = q.image_id \
         JOIN images_imageset st ON st.id = i.image_set_id WHERE q.id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    if let (Some(row), Some(obj)) = (row, job.as_object_mut()) {
        let path = s
            .slides
            .root()
            .join(row.get::<Option<String>, _>(0).unwrap_or_default())
            .join(row.get::<String, _>(1))
            .to_string_lossy()
            .to_string();
        obj.insert("image_path".into(), json!(path));
        let params: Option<Value> =
            sqlx::query_scalar("SELECT parameters FROM processing_pluginjob WHERE id = $1")
                .bind(id)
                .fetch_one(&s.pool)
                .await
                .map_err(db_err)?;
        obj.insert("params".into(), params.unwrap_or_else(|| json!({})));
        let types: Vec<Value> = sqlx::query(
            "SELECT t.id::bigint, t.name, t.vector_type::bigint FROM annotations_annotationtype t WHERE t.active AND t.product_id IN \
             (SELECT ap.product_id FROM administration_product_imagesets ap WHERE ap.imageset_id::bigint = $1) ORDER BY t.sort_order, t.id",
        )
        .bind(row.get::<i64, _>(2))
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?
        .iter()
        .map(|r| json!({"id": r.get::<i64, _>(0), "name": r.get::<String, _>(1), "vector_type": r.get::<i64, _>(2)}))
        .collect();
        obj.insert("annotation_types".into(), json!(types));
    }
    Ok(Some(job))
}

/// The job a worker reports on: it has to be attached to that worker, unfinished, without result, and on an image of the
/// caller's teams. Answers the image and the plugin of the job.
async fn owned_job(
    s: &AppState,
    p: &crate::auth::Principal,
    id: i64,
    worker: &str,
) -> ApiResult<(i64, i64)> {
    let viewer = p.viewer();
    let teams: Option<Vec<i64>> = viewer.token_teams.as_ref().map(|t| t.to_vec());
    let r = sqlx::query(
        "SELECT q.image_id::bigint, q.plugin_id::bigint, q.attached_worker, q.processing_complete, q.error_message, \
                EXISTS (SELECT 1 FROM processing_pluginresult r WHERE r.job_id = q.id) \
         FROM processing_pluginjob q WHERE q.id::bigint = $1 \
           AND q.plugin_id IN (SELECT id FROM processing_plugin WHERE plugin_type = 1) \
           AND q.image_id IN (SELECT i.id FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
               WHERE st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $2 \
                 AND ($3::bigint[] IS NULL OR team_id = ANY($3))))",
    )
    .bind(id)
    .bind(viewer.id)
    .bind(teams)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("Not found."))?;
    let attached: Option<String> = r.get(2);
    let done: f64 = r.get::<Option<f64>, _>(3).unwrap_or(0.0);
    if attached.as_deref() != Some(worker)
        || done >= 100.0
        || r.get::<Option<String>, _>(4).is_some()
        || r.get::<bool, _>(5)
    {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "The job is not running for this worker.",
        ));
    }
    Ok((r.get(0), r.get(1)))
}

async fn worker_of(
    s: &AppState,
    headers: &HeaderMap,
    body: &Bytes,
) -> ApiResult<(
    crate::auth::Principal,
    serde_json::Map<String, Value>,
    String,
)> {
    let p = require_model_perm(
        s,
        authenticate(s, headers, &Method::POST).await?,
        &Method::PATCH,
        "processing",
        "pluginjob",
    )
    .await?;
    let d: serde_json::Map<String, Value> = match serde_json::from_slice(body) {
        Ok(Value::Object(m)) => m,
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
        .unwrap_or("")
        .to_string();
    Ok((p, d, worker))
}

fn bad(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
}

/// `POST /api/v2/plugin-jobs/{id}/progress`: `{"worker", "progress": 0..99.9}`.
pub async fn progress_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let (p, d, worker) = worker_of(&s, &headers, &body).await?;
    owned_job(&s, &p, id, &worker).await?;
    let v = d
        .get("progress")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| bad("progress: a number is required."))?;
    sqlx::query("UPDATE processing_pluginjob SET processing_complete = $2, updated_time = now() WHERE id::bigint = $1")
        .bind(id)
        .bind(v.clamp(0.0, 99.9))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `POST /api/v2/plugin-jobs/{id}/fail`: `{"worker", "error", "detail"}`.
pub async fn fail_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let (p, d, worker) = worker_of(&s, &headers, &body).await?;
    owned_job(&s, &p, id, &worker).await?;
    let text = |k: &str, n: usize| -> String {
        d.get(k)
            .and_then(Value::as_str)
            .unwrap_or("")
            .chars()
            .take(n)
            .collect()
    };
    let error = Some(text("error", 1000))
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "failed".into());
    sqlx::query("UPDATE processing_pluginjob SET error_message = $2, error_detail = $3, updated_time = now() WHERE id::bigint = $1")
        .bind(id)
        .bind(error)
        .bind(text("detail", 4000))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `POST /api/v2/plugin-jobs/{id}/complete`:
/// `{"worker", "annotation_type": id, "name": "Mitotic Figures", "default_threshold": 0.5, "detections": [{"vector": {...}, "score": 0.9}]}`.
/// Stores the result, its entry and all annotations in one transaction and finishes the job: a job is never left with
/// half a result (v1 needs one request per annotation).
pub async fn complete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    axum::extract::Path(id): axum::extract::Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let (p, d, worker) = worker_of(&s, &headers, &body).await?;
    let (image, plugin) = owned_job(&s, &p, id, &worker).await?;
    let atype = d
        .get("annotation_type")
        .and_then(Value::as_i64)
        .ok_or_else(|| bad("annotation_type: an id is required."))?;
    let atype_row = sqlx::query(
        "SELECT t.vector_type::bigint, t.node_count::bigint, t.name FROM annotations_annotationtype t WHERE t.id = $1 AND t.product_id IN \
         (SELECT ap.product_id FROM administration_product_imagesets ap JOIN images_image i ON i.image_set_id = ap.imageset_id WHERE i.id::bigint = $2)",
    )
    .bind(atype as i32)
    .bind(image)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| bad("annotation_type: not an annotation type of this image's set."))?;
    let (vector_type, node_count, type_name): (i64, i64, String) =
        (atype_row.get(0), atype_row.get(1), atype_row.get(2));
    let name: String = d
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("Result")
        .chars()
        .take(200)
        .collect();
    let threshold = d
        .get("default_threshold")
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .unwrap_or(0.0);
    let detections = match d.get("detections") {
        Some(Value::Array(a)) => a,
        _ => return Err(bad("detections: a list is required.")),
    };
    if detections.len() > 1_000_000 {
        return Err(bad("detections: at most 1,000,000 per job."));
    }
    let mut rows: Vec<Value> = Vec::with_capacity(detections.len());
    for (n, x) in detections.iter().enumerate() {
        let vector = x.get("vector").filter(|v| v.is_object());
        let score = x
            .get("score")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite());
        match (vector, score) {
            (Some(v), Some(sc)) => {
                // the rule of the annotation type, as for annotations made by hand (`AnnotationType.validate_vector`)
                let mut v = v.clone();
                if !crate::compat::vector::validate(vector_type as i32, node_count as i32, &mut v) {
                    return Err(bad(&format!(
                        "detections[{n}]: the vector is not valid for the annotation type {type_name:?} ({}).",
                        vector_rule(vector_type)
                    )));
                }
                rows.push(json!({"v": v, "s": sc}));
            }
            _ => {
                return Err(bad(&format!(
                    "detections[{n}]: a vector object and a numeric score are required."
                )))
            }
        }
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let result: i64 = sqlx::query_scalar(
        "INSERT INTO processing_pluginresult (plugin_id, job_id, image_id, created_time, completed_time, default_alpha) \
         VALUES ($1::int, $2::int, $3::int, now(), now(), 1) RETURNING id::bigint",
    )
    .bind(plugin)
    .bind(id as i32)
    .bind(image)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    let entry: i64 = sqlx::query_scalar(
        "INSERT INTO processing_pluginresultentry (pluginresult_id, default_threshold, name, visible, created_time) \
         VALUES ($1::int, $2, $3, true, now()) RETURNING id::bigint",
    )
    .bind(result)
    .bind(threshold)
    .bind(&name)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query(
        "INSERT INTO processing_pluginresultannotation (annotation_type_id, vector, score, time, description, unique_identifier, image_id, pluginresultentry_id) \
         SELECT $1::int, e->'v', (e->>'s')::float8, now(), '', \
                uuid_in(overlay(overlay(md5(random()::text || clock_timestamp()::text) placing '4' from 13) placing to_hex(8 + (random() * 3)::int) from 17)::cstring), \
                $2::int, $3::int FROM jsonb_array_elements($4::jsonb) e",
    )
    .bind(atype as i32)
    .bind(image)
    .bind(entry)
    .bind(Value::Array(rows))
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query("UPDATE processing_pluginjob SET processing_complete = 100, updated_time = now() WHERE id::bigint = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"result": result, "entry": entry, "annotations": detections.len()})),
    )
        .into_response())
}

/// What a vector of this type looks like, for the error message.
fn vector_rule(vector_type: i64) -> &'static str {
    match vector_type {
        1 | 6 | 7 => "a box needs exactly x1, y1, x2, y2 with x2 > x1 and y2 > y1",
        2 => "a point needs x1, y1, x2, y2",
        3 => "a line needs two distinct points x1, y1, x2, y2",
        4 => "a polyline needs x1, y1, x2, y2, ... (an even number of coordinates, at least two points)",
        5 => "a polygon needs x1, y1, x2, y2, x3, y3, ... (at least three points)",
        _ => "this type takes no detections",
    }
}
