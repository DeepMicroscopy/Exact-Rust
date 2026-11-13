//! Image registration: jobs, the worker API, coordinate conversion and inverse registrations.
//!
//! Computing a registration (`qt-wsi-registration`, Python) is done by a worker that claims jobs from the queue: jobs of
//! registration plugins in `processing_pluginjob` (`image` and the position 0 of `processing_pluginjobimage` is the image that
//! is registered, position 1 the image it is registered onto; the result is the `ImageRegistration` of the pair, which a new
//! result overwrites). The server owns storage, permissions, the job lifecycle, the geometry (`convert_coodinates`,
//! `create_inverse_registration`) and the compat endpoints.
//!
//! v2: `POST /api/v2/images/{id}/register` (202, answers the job), `GET /api/v2/registration-jobs[/{id}]`,
//!     worker: `POST /api/v2/registration-jobs/claim`, `POST .../{id}/complete`, `POST .../{id}/fail`,
//!     `GET|POST /api/v2/registrations/{id}/convert`, `POST /api/v2/registrations/{id}/inverse`.
//! v1 (exact-sync): `POST /api/v1/images/images/{id}/register_images/` (waits for the worker up to
//!     `REGISTRATION_WAIT_SECONDS`, default 900; 201/202 like Django, 202 with the job if the wait ran out),
//!     `GET /api/v1/images/registration/{id}/convert_coodinates/?vector=`, `.../create_inverse_registration/`.
//!
//! A registration that has a pickled quad tree converts through the Python helper (`REGISTRATION_PYTHON`,
//! `helpers/registration_helper.py`); one that only has a matrix converts natively.

use crate::{
    auth::{authenticate, require_model_perm, require_user, Principal},
    compat::{
        engine::{self, db_err, snake_keys, Ctx},
        perms::{perms, set_row},
        specs,
    },
    error::{ApiError, ApiResult},
    media,
    page::Flex,
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::time::Duration;

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/images/{id}/register", post(v2_register))
        .route("/api/v2/registration-jobs", get(jobs_list))
        .route("/api/v2/registration-jobs/claim", post(claim))
        .route("/api/v2/registration-jobs/{id}", get(job_get))
        .route("/api/v2/registration-jobs/{id}/complete", post(complete))
        .route("/api/v2/registration-jobs/{id}/fail", post(fail))
        .route(
            "/api/v2/registrations/{id}/convert",
            get(v2_convert_get).post(v2_convert_post),
        )
        .route("/api/v2/registrations/{id}/inverse", post(v2_inverse))
        .route("/api/v2/registrations/manual", post(manual))
        .route("/api/v2/registrations/{id}/points", get(points_of))
}

pub fn legacy_routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v1/images/images/{id}/register_images/",
            post(v1_register),
        )
        .route(
            "/api/v1/images/registration/{id}/convert_coodinates/",
            get(v1_convert),
        )
        .route(
            "/api/v1/images/registration/{id}/create_inverse_registration/",
            get(v1_inverse),
        )
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
}

fn field_err(field: &str, msg: &str) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({"detail": "Validation failed.", "errors": {field: [msg]}}),
    }
}

fn host(headers: &HeaderMap) -> String {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost")
        .to_string()
}

async fn registration_json(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    id: i64,
    v2: bool,
) -> ApiResult<Value> {
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: host(headers),
        v2,
    };
    let v = engine::serialize_ids(&ctx, specs::by_name("ImageRegistration"), &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    Ok(if v2 { snake_keys(v) } else { v })
}

/// The caller may read the image set of the image (else the image does not exist for them).
async fn readable_image(s: &AppState, p: &Principal, image: i64) -> ApiResult<()> {
    let set: Option<i64> =
        sqlx::query_scalar("SELECT image_set_id FROM images_image WHERE id = $1")
            .bind(image)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?;
    let ok = match set {
        Some(set) => match set_row(s, set).await? {
            Some(row) => perms(s, p, &row).await?.read,
            None => false,
        },
        None => false,
    };
    if ok {
        Ok(())
    } else {
        Err(ApiError::not_found("No Image matches the given query."))
    }
}

/// A registration the caller may see (the source image's team), else 404.
async fn visible_registration(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    id: i64,
    v2: bool,
) -> ApiResult<()> {
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: host(headers),
        v2,
    };
    let (_, found) = engine::list(
        &ctx,
        specs::by_name("ImageRegistration"),
        &[],
        &Flex::default(),
        1,
        0,
        Some(id),
    )
    .await?;
    if found.is_empty() {
        return Err(ApiError::not_found(
            "No ImageRegistration matches the given query.",
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------
// jobs
// ---------------------------------------------------------------------------------------------------------

const PARAM_KEYS: &[&str] = &[
    "maxFeatures",
    "crossCheck",
    "flann",
    "ratio",
    "use_gray",
    "homography",
    "filter_outliner",
    "target_depth",
    "thumbnail_size",
    "create_inverse_registration",
];

/// Only the parameters of `perform_registration` (plus `create_inverse_registration`) are passed on.
fn job_params(d: &Map<String, Value>, schema_names: &[String]) -> Value {
    Value::Object(
        d.iter()
            .filter(|(k, _)| PARAM_KEYS.contains(&k.as_str()) || schema_names.contains(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    )
}

/// The plugin that computes a job (`plugin`: a registration plugin; none: the default one) and the parameters it accepts
/// (those the plugin's schema names, plus `create_inverse_registration`).
async fn plan(s: &AppState, d: &Map<String, Value>) -> ApiResult<(i32, Value)> {
    let plugin: i32 = match d.get("plugin") {
        None | Some(Value::Null) => crate::v2::plugins::default_registration_plugin(s)
            .await?
            .ok_or_else(|| {
                ApiError::detail(
                    StatusCode::CONFLICT,
                    "No registration plugin is registered: start a registration worker (helpers/queue_worker.py) first.",
                )
            })?,
        Some(v) => {
            let id = v
                .as_i64()
                .ok_or_else(|| bad("plugin: the id of a registration plugin is required."))?;
            let ok: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM processing_plugin WHERE id = $1 AND plugin_type = 2)",
            )
            .bind(id as i32)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
            if !ok {
                return Err(bad("plugin: there is no registration plugin with this id."));
            }
            id as i32
        }
    };
    let schema: Option<Value> =
        sqlx::query_scalar("SELECT parameters_schema FROM processing_plugin WHERE id = $1")
            .bind(plugin)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
    let names = schema
        .map(|v| crate::v2::plugins::schema_names(&v))
        .unwrap_or_default();
    Ok((plugin, job_params(d, &names)))
}

/// Queues a registration of source onto target; an open job of the pair is reused.
async fn enqueue(
    s: &AppState,
    p: &Principal,
    source: i64,
    target: i64,
    params: Value,
    plugin: i32,
) -> ApiResult<i64> {
    if source == target {
        return Err(bad("Source and target image have to differ."));
    }
    readable_image(s, p, source).await?;
    readable_image(s, p, target).await?;
    let open: Option<i64> = sqlx::query_scalar(&job_select(
        "WHERE j.source = $1 AND j.target = $2 AND j.status IN ('queued', 'running') ORDER BY j.id LIMIT 1",
        "j.id",
    ))
    .bind(source)
    .bind(target)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    if let Some(id) = open {
        return Ok(id);
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let id: i32 = sqlx::query_scalar(
        "INSERT INTO processing_pluginjob (plugin_id, image_id, creator_id, parameters, processing_complete, created_time, updated_time, eta_time) \
         VALUES ($1, $2::bigint, $3::bigint, $4, 0, now(), now(), now()) RETURNING id",
    )
    .bind(plugin)
    .bind(source)
    .bind(p.user.id)
    .bind(params)
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    sqlx::query(
        "INSERT INTO processing_pluginjobimage (job_id, image_id, position) VALUES ($1, $2, 0), ($1, $3, 1)",
    )
    .bind(id)
    .bind(source)
    .bind(target)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(id as i64)
}

/// `SELECT {columns} FROM <registration jobs> j {tail}`: the jobs of registration plugins that have their two images, with
/// `id, source, target, params, status, error, worker, created_by, created_at, updated, plugin, registration` (the
/// registration of the pair, if there is one) and the status words of `GET /api/v2/jobs`.
pub(crate) fn job_select(tail: &str, columns: &str) -> String {
    format!(
        "SELECT {columns} FROM (SELECT q.id::bigint AS id, q.image_id::bigint AS source, t.image_id::bigint AS target, \
                COALESCE(q.parameters, '{{}}'::jsonb) AS params, ({status}) AS status, q.error_message AS error, \
                NULLIF(q.attached_worker, '') AS worker, q.creator_id::bigint AS created_by, q.created_time AS created_at, \
                q.updated_time AS updated, q.plugin_id AS plugin, \
                (SELECT r.id::bigint FROM images_imageregistration r WHERE r.source_image_id = q.image_id AND r.target_image_id = t.image_id LIMIT 1) AS registration \
             FROM processing_pluginjob q JOIN processing_plugin pl ON pl.id = q.plugin_id AND pl.plugin_type = 2 \
             JOIN processing_pluginjobimage t ON t.job_id = q.id AND t.position = 1) j {tail}",
        status = crate::v2::jobs::plugin_job_status_sql()
    )
}

/// The columns `row_json` reads.
const JOB_COLUMNS: &str = "j.id, j.source, j.target, j.params, j.status, j.error, j.worker, j.registration, j.created_by, \
                           j.created_at, j.updated, j.plugin";

async fn job_json(s: &AppState, id: i64) -> ApiResult<Value> {
    let r = sqlx::query(&job_select("WHERE j.id = $1", JOB_COLUMNS))
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    Ok(row_json(&r))
}

/// A job as the registration endpoints show it. The tables keep no start and end time of their own: a running job was
/// touched when it started, a finished one when it ended.
fn row_json(r: &sqlx::postgres::PgRow) -> Value {
    let status = r.get::<String, _>(4);
    let updated = r
        .get::<chrono::DateTime<chrono::Utc>, _>(10)
        .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
    let created = r
        .get::<chrono::DateTime<chrono::Utc>, _>(9)
        .to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
    let (started, finished) = match status.as_str() {
        "running" => (Some(updated), None),
        "done" | "failed" => (None, Some(updated)),
        _ => (None, None),
    };
    json!({
        "id": r.get::<i64, _>(0), "source_image": r.get::<i64, _>(1), "target_image": r.get::<i64, _>(2),
        "params": r.get::<Value, _>(3), "error": r.get::<Option<String>, _>(5),
        "worker": r.get::<Option<String>, _>(6),
        "registration": if status == "done" { r.get::<Option<i64>, _>(7) } else { None },
        "status": status, "created_by": r.get::<Option<i64>, _>(8),
        "created_at": created, "started_at": started, "finished_at": finished, "plugin": r.get::<i32, _>(11),
    })
}

fn parse_object(body: &[u8]) -> ApiResult<Map<String, Value>> {
    if body.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(bad("Expected a JSON object.")),
        Err(e) => Err(bad(format!("JSON parse error - {e}"))),
    }
}

fn target_of(d: &Map<String, Value>) -> ApiResult<i64> {
    match d.get("target_image") {
        Some(Value::Number(n)) if n.is_i64() => Ok(n.as_i64().unwrap_or(0)),
        Some(Value::String(t)) => t
            .parse()
            .map_err(|_| field_err("target_image", "An integer id is required.")),
        _ => Err(field_err("target_image", "This field is required.")),
    }
}

/// The caller may edit the image set of the image (members of the team may), no Django model permission needed.
async fn editable_image(s: &AppState, p: &Principal, image: i64) -> ApiResult<()> {
    let set: Option<i64> =
        sqlx::query_scalar("SELECT image_set_id FROM images_image WHERE id = $1")
            .bind(image)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?;
    let Some(set) = set else {
        return Err(ApiError::not_found("No Image matches the given query."));
    };
    let row = set_row(s, set)
        .await?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    let pm = perms(s, p, &row).await?;
    if !pm.read {
        return Err(ApiError::not_found("No Image matches the given query."));
    }
    if pm.edit_set {
        Ok(())
    } else {
        Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for editing this image set missing.",
        ))
    }
}

async fn v2_register(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    editable_image(&s, &p, id).await?;
    let d = parse_object(&body)?;
    let (plugin, params) = plan(&s, &d).await?;
    let job = enqueue(&s, &p, id, target_of(&d)?, params, plugin).await?;
    Ok((StatusCode::ACCEPTED, Json(job_json(&s, job).await?)).into_response())
}

async fn job_visible(s: &AppState, p: &Principal, id: i64) -> ApiResult<()> {
    let row: Option<(i64, i64)> =
        sqlx::query_as(&job_select("WHERE j.id = $1", "j.source, j.target"))
            .bind(id)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?;
    let (a, b) = row.ok_or_else(|| ApiError::not_found("Not found."))?;
    readable_image(s, p, a)
        .await
        .map_err(|_| ApiError::not_found("Not found."))?;
    readable_image(s, p, b)
        .await
        .map_err(|_| ApiError::not_found("Not found."))
}

async fn job_get(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    job_visible(&s, &p, id).await?;
    Ok(Json(job_json(&s, id).await?).into_response())
}

/// Jobs of the caller's teams, newest first; `?status=queued|running|done|failed`, `?image=` (source or target).
async fn jobs_list(State(s): State<AppState>, headers: HeaderMap, uri: Uri) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let q: std::collections::HashMap<String, String> =
        form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
            .into_owned()
            .collect();
    let v = p.viewer();
    let rows = sqlx::query(&job_select(
        "WHERE ($1::text IS NULL OR j.status = $1) AND ($2::bigint IS NULL OR j.source = $2 OR j.target = $2) \
           AND j.source IN (SELECT i.id FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
               WHERE st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $3 AND ($4::bigint[] IS NULL OR team_id = ANY($4)))) \
         ORDER BY j.id DESC LIMIT 200",
        JOB_COLUMNS,
    ))
    .bind(q.get("status"))
    .bind(q.get("image").and_then(|v| v.parse::<i64>().ok()))
    .bind(v.id)
    .bind(v.token_teams)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(json!({"items": rows.iter().map(row_json).collect::<Vec<_>>()})).into_response())
}

// ---------------------------------------------------------------------------------------------------------
// worker API
// ---------------------------------------------------------------------------------------------------------

/// A running job that was not touched for this long is claimed again (its worker is lost).
const LEASE: &str = "30 minutes";

async fn worker_principal(
    s: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> ApiResult<Principal> {
    require_model_perm(
        s,
        authenticate(s, headers, method).await?,
        &Method::PATCH,
        "images",
        "imageregistration",
    )
    .await
}

/// `{"worker": "name"}`: the oldest queued job (or one whose lease ran out) is marked running for the worker. 200 with the
/// job, the file paths of both images on the server and the parameters, or 204.
async fn claim(State(s): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    worker_principal(&s, &headers, &Method::POST).await?;
    let d = parse_object(&body)?;
    let worker = d
        .get("worker")
        .and_then(Value::as_str)
        .filter(|w| !w.is_empty() && w.chars().count() <= 200)
        .ok_or_else(|| field_err("worker", "A name of 1 to 200 characters is required."))?;
    crate::v2::jobs::seen(worker, &["registration"], &[]);
    Ok(match claim_one(&s, worker, None).await? {
        Some(job) => Json(job).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

/// Marks the oldest waiting registration job as running for `worker`; the job as the worker needs it, or none. `plugins`
/// are the registration plugins the worker serves (none given: any).
pub(crate) async fn claim_one(
    s: &AppState,
    worker: &str,
    plugins: Option<&[i64]>,
) -> ApiResult<Option<Value>> {
    let row = sqlx::query(&format!(
        "UPDATE processing_pluginjob SET attached_worker = $1, updated_time = now(), error_message = NULL, error_detail = NULL \
         WHERE id = ( \
           SELECT q.id FROM processing_pluginjob q \
             JOIN processing_plugin pl ON pl.id = q.plugin_id AND pl.plugin_type = 2 \
             JOIN processing_pluginjobimage t ON t.job_id = q.id AND t.position = 1 \
           WHERE q.error_message IS NULL AND q.processing_complete < 100 \
             AND (q.attached_worker IS NULL OR q.attached_worker = '' OR q.updated_time < now() - interval '{LEASE}') \
             AND ($2::bigint[] IS NULL OR q.plugin_id = ANY($2)) \
           ORDER BY q.created_time, q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED) \
         RETURNING id::bigint, image_id::bigint, \
           (SELECT t.image_id::bigint FROM processing_pluginjobimage t WHERE t.job_id = processing_pluginjob.id AND t.position = 1), \
           COALESCE(parameters, '{{}}'::jsonb), plugin_id"
    ))
    .bind(worker)
    .bind(plugins)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    let Some(row) = row else {
        return Ok(None);
    };
    let (id, source, target, params, plugin_id): (i64, i64, i64, Value, i32) =
        (row.get(0), row.get(1), row.get(2), row.get(3), row.get(4));
    let plugin: Option<Value> = sqlx::query("SELECT id, name, package FROM processing_plugin WHERE id = $1")
        .bind(plugin_id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .map(|r| json!({"id": r.get::<i32, _>(0), "name": r.get::<String, _>(1), "package": r.get::<String, _>(2)}));
    let path_of = |image: i64| {
        let s = s.clone();
        async move {
            let r = sqlx::query("SELECT st.path, i.filename FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id WHERE i.id = $1")
                .bind(image)
                .fetch_optional(&s.pool)
                .await
                .map_err(db_err)?;
            Ok::<_, ApiError>(r.map(|r| {
                s.slides
                    .root()
                    .join(r.get::<Option<String>, _>(0).unwrap_or_default())
                    .join(r.get::<String, _>(1))
                    .to_string_lossy()
                    .to_string()
            }))
        }
    };
    let (sp, tp) = (path_of(source).await?, path_of(target).await?);
    let (Some(sp), Some(tp)) = (sp, tp) else {
        sqlx::query("UPDATE processing_pluginjob SET error_message = 'image no longer exists', updated_time = now() WHERE id::bigint = $1")
            .bind(id)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
        return Ok(None);
    };
    // a registration of this pair that DeeperHistReg made last (its file is the pickled transform): a refining plugin starts from it
    let existing: Option<Value> = sqlx::query(
        "SELECT r.transformation_matrix, r.registration_error FROM images_imageregistration r \
         WHERE r.source_image_id = $1 AND r.target_image_id = $2 AND COALESCE(r.file, '') <> '' AND r.transformation_matrix IS NOT NULL \
           AND (SELECT pl.name FROM processing_pluginjob q JOIN processing_plugin pl ON pl.id = q.plugin_id AND pl.plugin_type = 2 \
                  JOIN processing_pluginjobimage t ON t.job_id = q.id AND t.position = 1 \
                WHERE q.image_id = $1 AND t.image_id = $2 AND q.processing_complete = 100 AND q.id::bigint <> $3 \
                ORDER BY q.updated_time DESC, q.id DESC LIMIT 1) ILIKE '%deeperhistreg%'",
    )
    .bind(source)
    .bind(target)
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .map(|r| json!({"plugin": "DeeperHistReg", "matrix": r.get::<Value, _>(0), "error": r.get::<Option<f64>, _>(1)}));
    Ok(Some(
        json!({"id": id, "source_image": source, "target_image": target, "source_path": sp, "target_path": tp, "params": params, "plugin": plugin, "existing": existing}),
    ))
}

async fn owned_running(s: &AppState, id: i64, worker: &str) -> ApiResult<(i64, i64, Value)> {
    let r = sqlx::query(&job_select(
        "WHERE j.id = $1",
        "j.source, j.target, j.params, j.status, j.worker",
    ))
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("Not found."))?;
    if r.get::<String, _>(3) != "running"
        || r.get::<Option<String>, _>(4).as_deref() != Some(worker)
    {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "The job is not running for this worker.",
        ));
    }
    Ok((r.get(0), r.get(1), r.get(2)))
}

/// `{"worker", "error"}`
async fn fail(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    worker_principal(&s, &headers, &Method::POST).await?;
    let d = parse_object(&body)?;
    let worker = d.get("worker").and_then(Value::as_str).unwrap_or("");
    owned_running(&s, id, worker).await?;
    let error: String = d
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("failed")
        .chars()
        .take(4000)
        .collect();
    sqlx::query("UPDATE processing_pluginjob SET error_message = $2, updated_time = now() WHERE id::bigint = $1")
        .bind(id)
        .bind(error)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(Json(job_json(&s, id).await?).into_response())
}

fn matrix_ok(m: &Value) -> bool {
    [
        "t_00", "t_01", "t_02", "t_10", "t_11", "t_12", "t_20", "t_21", "t_22",
    ]
    .iter()
    .all(|k| {
        m.get(k)
            .is_some_and(|v| v.as_f64().is_some_and(f64::is_finite))
    })
}

/// `{"worker", "transformation_matrix": {t_00..t_22}, "registration_error", "runtime"}` as JSON or multipart (JSON text
/// fields) with the pickled quad tree as file `file`. Creates or updates the registration of the pair.
async fn complete(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = worker_principal(&s, &headers, &Method::POST).await?;
    let payload = media::parse_body(&headers, &body).await?;
    let d = &payload.fields;
    let as_json = |k: &str| {
        d.get(k).map(|v| match v {
            Value::String(t) if payload.form => serde_json::from_str(t).unwrap_or(Value::Null),
            o => o.clone(),
        })
    };
    let num = |k: &str| {
        as_json(k).and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|t| t.parse().ok()))
        })
    };
    let worker = d.get("worker").and_then(Value::as_str).unwrap_or("");
    let (source, target, params) = owned_running(&s, id, worker).await?;
    let matrix = as_json("transformation_matrix")
        .filter(matrix_ok)
        .ok_or_else(|| {
            field_err(
                "transformation_matrix",
                "t_00 ... t_22 are required numbers.",
            )
        })?;
    let error = num("registration_error")
        .ok_or_else(|| field_err("registration_error", "A number is required."))?;
    let runtime = num("runtime").map(|v| v as i32).unwrap_or(-1);

    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let existing: Option<(i64, Option<String>)> = sqlx::query_as("SELECT id, file FROM images_imageregistration WHERE source_image_id = $1 AND target_image_id = $2")
        .bind(source)
        .bind(target)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db_err)?;
    let reg = match &existing {
        Some((rid, _)) => {
            sqlx::query("UPDATE images_imageregistration SET transformation_matrix = $2, registration_error = $3, runtime = $4 WHERE id = $1")
                .bind(rid)
                .bind(&matrix)
                .bind(error)
                .bind(runtime)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
            *rid
        }
        None => sqlx::query_scalar(
            "INSERT INTO images_imageregistration (source_image_id, target_image_id, transformation_matrix, registration_error, runtime) \
             VALUES ($1, $2, $3, $4, $5) RETURNING id",
        )
        .bind(source)
        .bind(target)
        .bind(&matrix)
        .bind(error)
        .bind(runtime)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?,
    };
    let mut stored = None;
    if !payload.files.iter().any(|f| f.field == "file") {
        // a result without a file converts by its matrix: an older plugin's file must not shadow it
        if let Some((_, Some(old))) = &existing {
            media::remove(&s, old).await;
            sqlx::query("UPDATE images_imageregistration SET file = NULL WHERE id = $1")
                .bind(reg)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
        }
    }
    if let Some(up) = payload.files.iter().find(|f| f.field == "file") {
        let name = format!("{source}_{target}.pickle");
        if let Some((_, Some(old))) = &existing {
            media::remove(&s, old).await;
        }
        let rel = media::store(&s, "registration", &name, &up.data).await?;
        sqlx::query("UPDATE images_imageregistration SET file = $2 WHERE id = $1")
            .bind(reg)
            .bind(&rel)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        stored = Some(rel);
    }
    if params
        .get("create_inverse_registration")
        .is_some_and(|v| v.as_bool() == Some(true))
    {
        let _ = insert_inverse(&mut tx, reg).await;
    }
    sqlx::query("UPDATE processing_pluginjob SET processing_complete = 100, updated_time = now() WHERE id::bigint = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(|e| {
            let _ = &stored;
            db_err(e)
        })?;
    tx.commit().await.map_err(db_err)?;
    Ok(Json(registration_json(&s, &p, &headers, reg, true).await?).into_response())
}

// ---------------------------------------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------------------------------------

fn m(matrix: &Value, k: &str) -> ApiResult<f64> {
    matrix
        .get(k)
        .and_then(Value::as_f64)
        .ok_or_else(|| bad("The registration has no transformation matrix yet."))
}

/// Inverse of the affine part as `cv2.invertAffineTransform` computes it (a singular matrix gives zeros); the last row is copied.
fn inverse_matrix(t: &Value) -> ApiResult<Value> {
    let (a, b, tx) = (m(t, "t_00")?, m(t, "t_01")?, m(t, "t_02")?);
    let (c, d, ty) = (m(t, "t_10")?, m(t, "t_11")?, m(t, "t_12")?);
    let det = a * d - b * c;
    let k = if det != 0.0 { 1.0 / det } else { 0.0 };
    let (ia, ib, ic, id) = (d * k, -b * k, -c * k, a * k);
    Ok(json!({
        "t_00": ia, "t_01": ib, "t_02": -(ia * tx + ib * ty),
        "t_10": ic, "t_11": id, "t_12": -(ic * tx + id * ty),
        "t_20": m(t, "t_20")?, "t_21": m(t, "t_21")?, "t_22": m(t, "t_22")?,
    }))
}

/// Creates the registration of target onto source from this one. `Err` if it exists already.
async fn insert_inverse(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: i64) -> ApiResult<i64> {
    let r = sqlx::query("SELECT source_image_id, target_image_id, transformation_matrix, registration_error, runtime FROM images_imageregistration WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut **tx)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let (source, target): (i64, i64) = (r.get(0), r.get(1));
    let matrix: Option<Value> = r.get(2);
    let inv = inverse_matrix(
        &matrix.ok_or_else(|| bad("The registration has no transformation matrix yet."))?,
    )?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM images_imageregistration WHERE source_image_id = $1 AND target_image_id = $2)")
        .bind(target)
        .bind(source)
        .fetch_one(&mut **tx)
        .await
        .map_err(db_err)?;
    if taken {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "The inverse registration exists already.",
        ));
    }
    sqlx::query_scalar(
        "INSERT INTO images_imageregistration (source_image_id, target_image_id, transformation_matrix, registration_error, runtime) \
         VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(target)
    .bind(source)
    .bind(inv)
    .bind(r.get::<f64, _>(3))
    .bind(r.get::<i32, _>(4))
    .fetch_one(&mut **tx)
    .await
    .map_err(db_err)
}

async fn source_of(s: &AppState, registration: i64) -> ApiResult<i64> {
    sqlx::query_scalar("SELECT source_image_id FROM images_imageregistration WHERE id = $1")
        .bind(registration)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("Not found."))
}

/// `DELETE /api/v2/registrations/{id}`: members who may edit the image set of the source image (no model permission needed);
/// the pickled quad tree goes with it.
pub async fn delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    visible_registration(&s, &p, &headers, id, true).await?;
    editable_image(&s, &p, source_of(&s, id).await?).await?;
    let file: Option<String> =
        sqlx::query_scalar("SELECT file FROM images_imageregistration WHERE id = $1")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    crate::cascade::delete_rows(&mut tx, "images_imageregistration", &[id]).await?;
    tx.commit().await.map_err(db_err)?;
    if let Some(f) = file.filter(|f| !f.is_empty()) {
        crate::media::remove(&s, &f).await;
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn inverse_of(s: &AppState, id: i64) -> ApiResult<i64> {
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let new = insert_inverse(&mut tx, id).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(new)
}

fn affine(matrix: &Value, x: f64, y: f64) -> ApiResult<(f64, f64)> {
    Ok((
        m(matrix, "t_00")? * x + m(matrix, "t_01")? * y + m(matrix, "t_02")?,
        m(matrix, "t_10")? * x + m(matrix, "t_11")? * y + m(matrix, "t_12")?,
    ))
}

/// Converts a vector `{x1, y1, x2, y2, ...}` from the source to the target image.
async fn convert(s: &AppState, id: i64, vector: &Map<String, Value>) -> ApiResult<Value> {
    let r = sqlx::query(
        "SELECT transformation_matrix, file FROM images_imageregistration WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("Not found."))?;
    let (matrix, file): (Option<Value>, Option<String>) = (r.get(0), r.get(1));
    let mut points = vec![];
    for i in 1..=(vector.len() / 2) {
        let get = |k: String| vector.get(&k).and_then(Value::as_f64);
        match (get(format!("x{i}")), get(format!("y{i}"))) {
            (Some(x), Some(y)) => points.push((x, y)),
            _ => return Err(bad(format!("x{i} and y{i} have to be numbers."))),
        }
    }
    let converted: Vec<(f64, f64)> = match file.filter(|f| !f.is_empty()) {
        Some(f) => helper_convert(s, &f, &points).await?,
        None => {
            let matrix =
                matrix.ok_or_else(|| bad("The registration has no transformation matrix yet."))?;
            points
                .iter()
                .map(|(x, y)| affine(&matrix, *x, *y))
                .collect::<ApiResult<_>>()?
        }
    };
    let mut out = Map::new();
    for (i, (x, y)) in converted.iter().enumerate() {
        out.insert(format!("x{}", i + 1), json!(x));
        out.insert(format!("y{}", i + 1), json!(y));
    }
    Ok(Value::Object(out))
}

/// Quad tree registrations convert piecewise; that needs the pickled tree, which only the Python library reads.
async fn helper_convert(
    s: &AppState,
    file: &str,
    points: &[(f64, f64)],
) -> ApiResult<Vec<(f64, f64)>> {
    let python = std::env::var("REGISTRATION_PYTHON").map_err(|_| {
        ApiError::detail(
            StatusCode::SERVICE_UNAVAILABLE,
            "This registration has a quad tree; converting needs the Python registration helper (set REGISTRATION_PYTHON).",
        )
    })?;
    let script = std::env::var("REGISTRATION_HELPER")
        .unwrap_or_else(|_| "helpers/registration_helper.py".into());
    if file.contains("..") || file.starts_with('/') {
        return Err(bad("invalid registration file"));
    }
    let path = s.media_root.join(file);
    let input = serde_json::to_vec(&points.iter().map(|(x, y)| [x, y]).collect::<Vec<_>>())
        .unwrap_or_default();
    use tokio::io::AsyncWriteExt;
    let mut child = tokio::process::Command::new(python)
        .arg("-I")
        .arg(script)
        .arg("convert")
        .arg(path)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| {
            ApiError::detail(
                StatusCode::SERVICE_UNAVAILABLE,
                format!("cannot start the registration helper: {e}"),
            )
        })?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(&input).await;
    }
    let out = tokio::time::timeout(Duration::from_secs(120), child.wait_with_output())
        .await
        .map_err(|_| {
            ApiError::detail(
                StatusCode::GATEWAY_TIMEOUT,
                "The registration helper timed out.",
            )
        })?
        .map_err(|e| ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if !out.status.success() {
        tracing::error!(
            "registration helper failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        return Err(ApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            "The registration helper failed.",
        ));
    }
    let v: Vec<[f64; 2]> = serde_json::from_slice(&out.stdout)
        .map_err(|e| ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(v.into_iter().map(|[x, y]| (x, y)).collect())
}

fn vector_param(uri: &Uri) -> ApiResult<Map<String, Value>> {
    let raw = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == "vector")
        .map(|(_, v)| v.into_owned())
        .ok_or_else(|| bad("vector parameter not set"))?;
    // Django accepts Python style quotes
    match serde_json::from_str::<Value>(&raw.replace('\'', "\"")) {
        Ok(Value::Object(m)) => Ok(m),
        _ => Err(bad(
            "vector has to be a JSON object like {\"x1\": 1, \"y1\": 2}",
        )),
    }
}

async fn v1_convert(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::GET).await?,
        &Method::GET,
        "images",
        "imageregistration",
    )
    .await?;
    visible_registration(&s, &p, &headers, id, false).await?;
    let out = convert(&s, id, &vector_param(&uri)?).await?;
    Ok((StatusCode::ACCEPTED, Json(out)).into_response())
}

async fn v2_convert_get(
    State(s): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    visible_registration(&s, &p, &headers, id, true).await?;
    Ok(Json(convert(&s, id, &vector_param(&uri)?).await?).into_response())
}

async fn v2_convert_post(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    visible_registration(&s, &p, &headers, id, true).await?;
    let d = parse_object(&body)?;
    let vector = match d.get("vector") {
        Some(Value::Object(m)) => m.clone(),
        _ => {
            return Err(field_err(
                "vector",
                "An object like {\"x1\": 1, \"y1\": 2} is required.",
            ))
        }
    };
    Ok(Json(convert(&s, id, &vector).await?).into_response())
}

async fn v1_inverse(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::GET).await?,
        &Method::GET,
        "images",
        "imageregistration",
    )
    .await?;
    visible_registration(&s, &p, &headers, id, false).await?;
    let new = inverse_of(&s, id).await?;
    Ok((
        StatusCode::CREATED,
        Json(registration_json(&s, &p, &headers, new, false).await?),
    )
        .into_response())
}

/// Our points are `[{"source": [x, y], "target": [x, y]}]`; Django's manual registration stores `{"0": "x1:..,y1:..,x2:..,y2:.."}`
/// with the target point first and the source point second.
fn normalize_points(v: Value) -> Value {
    let Value::Object(m) = v else { return v };
    let mut out = Vec::new();
    for t in m.values().filter_map(Value::as_str) {
        let kv: std::collections::HashMap<&str, f64> = t
            .split(',')
            .filter_map(|p| p.split_once(':'))
            .filter_map(|(k, v)| Some((k.trim(), v.trim().parse().ok()?)))
            .collect();
        if let (Some(x1), Some(y1), Some(x2), Some(y2)) =
            (kv.get("x1"), kv.get("y1"), kv.get("x2"), kv.get("y2"))
        {
            out.push(json!({"source": [x2, y2], "target": [x1, y1]}));
        }
    }
    Value::Array(out)
}

/// `GET /api/v2/registrations/{id}/points`: the point pairs a manual registration was made from (`null` for an automatic one).
async fn points_of(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    visible_registration(&s, &p, &headers, id, true).await?;
    let points: Option<Value> = sqlx::query_scalar(
        "SELECT registration_points FROM images_imageregistration WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .flatten();
    Ok(Json(json!({ "id": id, "points": points.map(normalize_points) })).into_response())
}

async fn v2_inverse(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    visible_registration(&s, &p, &headers, id, true).await?;
    editable_image(&s, &p, source_of(&s, id).await?).await?;
    let new = inverse_of(&s, id).await?;
    Ok((
        StatusCode::CREATED,
        Json(registration_json(&s, &p, &headers, new, true).await?),
    )
        .into_response())
}

// ---------------------------------------------------------------------------------------------------------
// manual registration
// ---------------------------------------------------------------------------------------------------------

type Pair = ([f64; 2], [f64; 2]);

/// Affine `[[a, b, tx], [c, d, ty]]` with target = M * source from picked point pairs: one pair gives a translation, two a
/// similarity (scale, rotation, translation), three or more the least-squares affine map. Returns the matrix and the RMS
/// distance (target pixels) between the mapped source points and the target points.
fn fit_points(pairs: &[Pair]) -> Result<([[f64; 3]; 2], f64), String> {
    let n = pairs.len();
    let mt = match n {
        0 => return Err("at least one pair of points is required".into()),
        1 => {
            let (s, t) = pairs[0];
            [[1.0, 0.0, t[0] - s[0]], [0.0, 1.0, t[1] - s[1]]]
        }
        2 => {
            let (s0, t0) = pairs[0];
            let (s1, t1) = pairs[1];
            let (sx, sy) = (s1[0] - s0[0], s1[1] - s0[1]);
            let (tx, ty) = (t1[0] - t0[0], t1[1] - t0[1]);
            let den = sx * sx + sy * sy;
            if den == 0.0 {
                return Err("the two source points are identical".into());
            }
            // complex ratio t/s = a + ib
            let a = (tx * sx + ty * sy) / den;
            let b = (ty * sx - tx * sy) / den;
            [
                [a, -b, t0[0] - (a * s0[0] - b * s0[1])],
                [b, a, t0[1] - (b * s0[0] + a * s0[1])],
            ]
        }
        _ => {
            // normal equations of [x y 1] * p = t, solved for both target coordinates
            let mut ata = [[0.0f64; 3]; 3];
            let mut atb = [[0.0f64; 3]; 2];
            for (s, t) in pairs {
                let r = [s[0], s[1], 1.0];
                for i in 0..3 {
                    for j in 0..3 {
                        ata[i][j] += r[i] * r[j];
                    }
                    atb[0][i] += r[i] * t[0];
                    atb[1][i] += r[i] * t[1];
                }
            }
            let det3 = |m: &[[f64; 3]; 3]| {
                m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
            };
            let d = det3(&ata);
            let scale = ata[0][0] * ata[1][1] * ata[2][2];
            if d.abs() <= 1e-9 * scale.abs().max(1.0) {
                return Err("the source points lie on a line".into());
            }
            let mut out = [[0.0; 3]; 2];
            for (k, row) in out.iter_mut().enumerate() {
                for (c, cell) in row.iter_mut().enumerate() {
                    let mut mm = ata;
                    for r in 0..3 {
                        mm[r][c] = atb[k][r];
                    }
                    *cell = det3(&mm) / d;
                }
            }
            out
        }
    };
    let sq: f64 = pairs
        .iter()
        .map(|(s, t)| {
            let px = mt[0][0] * s[0] + mt[0][1] * s[1] + mt[0][2];
            let py = mt[1][0] * s[0] + mt[1][1] * s[1] + mt[1][2];
            (px - t[0]).powi(2) + (py - t[1]).powi(2)
        })
        .sum();
    Ok((mt, (sq / n as f64).sqrt()))
}

fn point(v: &Value) -> Option<[f64; 2]> {
    let a = v.as_array()?;
    let (x, y) = (a.first()?.as_f64()?, a.get(1)?.as_f64()?);
    (a.len() == 2 && x.is_finite() && y.is_finite()).then_some([x, y])
}

/// `POST /api/v2/registrations/manual` `{"source_image", "target_image", "points": [{"source": [x, y], "target": [x, y]}], "inverse"?}`
/// as Django's manual registration: the matrix is estimated from the point pairs (full resolution pixels) and stored with
/// the points, replacing the registration of the pair (and its pickled quad tree). Needs edit rights on the source image's
/// set and read access to the target. 201.
async fn manual(State(s): State<AppState>, headers: HeaderMap, body: Bytes) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = parse_object(&body)?;
    let int = |k: &str| match d.get(k) {
        Some(Value::Number(n)) if n.is_i64() => Ok(n.as_i64().unwrap_or(0)),
        _ => Err(field_err(k, "An integer id is required.")),
    };
    let (source, target) = (int("source_image")?, int("target_image")?);
    if source == target {
        return Err(field_err("target_image", "Source and target must differ."));
    }
    editable_image(&s, &p, source).await?;
    readable_image(&s, &p, target).await?;
    let raw = d
        .get("points")
        .and_then(Value::as_array)
        .ok_or_else(|| field_err("points", "A list of point pairs is required."))?;
    let mut pairs = Vec::new();
    for v in raw {
        let (a, b) = (
            v.get("source").and_then(point),
            v.get("target").and_then(point),
        );
        match (a, b) {
            (Some(a), Some(b)) => pairs.push((a, b)),
            _ => {
                return Err(field_err(
                    "points",
                    "Every pair needs source and target as [x, y].",
                ))
            }
        }
    }
    let (mt, error) = fit_points(&pairs).map_err(|e| field_err("points", &e))?;
    let matrix = json!({
        "t_00": mt[0][0], "t_01": mt[0][1], "t_02": mt[0][2],
        "t_10": mt[1][0], "t_11": mt[1][1], "t_12": mt[1][2],
        "t_20": 0.0, "t_21": 0.0, "t_22": 1.0,
    });
    let points = Value::Array(
        pairs
            .iter()
            .map(|(a, b)| json!({"source": a, "target": b}))
            .collect(),
    );
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let old: Option<(i64, Option<String>)> = sqlx::query_as(
        "SELECT id, file FROM images_imageregistration WHERE source_image_id = $1 AND target_image_id = $2",
    )
    .bind(source)
    .bind(target)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;
    let id: i64 = match &old {
        Some((rid, _)) => {
            sqlx::query("UPDATE images_imageregistration SET transformation_matrix = $2, registration_error = $3, registration_points = $4, runtime = 0, file = NULL WHERE id = $1")
                .bind(rid)
                .bind(&matrix)
                .bind(error)
                .bind(&points)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
            *rid
        }
        None => sqlx::query_scalar("INSERT INTO images_imageregistration (source_image_id, target_image_id, transformation_matrix, registration_error, registration_points, runtime) VALUES ($1, $2, $3, $4, $5, 0) RETURNING id")
            .bind(source)
            .bind(target)
            .bind(&matrix)
            .bind(error)
            .bind(&points)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_err)?,
    };
    // the registration the other way, replacing an existing one
    let mut stale = Vec::new();
    if d.get("inverse").and_then(Value::as_bool).unwrap_or(false) {
        let inv = inverse_matrix(&matrix)?;
        let swapped = Value::Array(
            pairs
                .iter()
                .map(|(a, b)| json!({"source": b, "target": a}))
                .collect(),
        );
        let back: Option<(i64, Option<String>)> = sqlx::query_as("SELECT id, file FROM images_imageregistration WHERE source_image_id = $1 AND target_image_id = $2")
            .bind(target)
            .bind(source)
            .fetch_optional(&mut *tx)
            .await
            .map_err(db_err)?;
        match back {
            Some((rid, file)) => {
                sqlx::query("UPDATE images_imageregistration SET transformation_matrix = $2, registration_error = $3, registration_points = $4, runtime = 0, file = NULL WHERE id = $1")
                    .bind(rid)
                    .bind(&inv)
                    .bind(error)
                    .bind(&swapped)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
                stale.extend(file);
            }
            None => {
                sqlx::query("INSERT INTO images_imageregistration (source_image_id, target_image_id, transformation_matrix, registration_error, registration_points, runtime) VALUES ($1, $2, $3, $4, $5, 0)")
                    .bind(target)
                    .bind(source)
                    .bind(&inv)
                    .bind(error)
                    .bind(&swapped)
                    .execute(&mut *tx)
                    .await
                    .map_err(db_err)?;
            }
        }
    }
    tx.commit().await.map_err(db_err)?;
    stale.extend(old.and_then(|(_, f)| f));
    for f in stale {
        media::remove(&s, &f).await;
    }
    Ok((
        StatusCode::CREATED,
        Json(registration_json(&s, &p, &headers, id, true).await?),
    )
        .into_response())
}

// ---------------------------------------------------------------------------------------------------------
// v1 register_images
// ---------------------------------------------------------------------------------------------------------

/// `POST .../images/{id}/register_images/` `{"target_image", ...parameters}`: Django computes synchronously; here the job is
/// queued and the request waits for the worker. 201 for a new registration, 202 for a recomputed one, 202 with the job
/// when the wait ran out.
async fn v1_register(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::POST).await?,
        &Method::POST,
        "images",
        "image",
    )
    .await?;
    let d = parse_object(&body)?;
    let target =
        target_of(&d).map_err(|_| ApiError::not_found("No Image matches the given query."))?;
    let existed: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM images_imageregistration WHERE source_image_id = $1 AND target_image_id = $2)")
        .bind(id)
        .bind(target)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    let (plugin, params) = plan(&s, &d).await?;
    let job = enqueue(&s, &p, id, target, params, plugin).await?;
    let wait: u64 = std::env::var("REGISTRATION_WAIT_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(900);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(wait);
    loop {
        let (status, reg, error): (String, Option<i64>, Option<String>) = sqlx::query_as(
            &job_select("WHERE j.id = $1", "j.status, j.registration, j.error"),
        )
        .bind(job)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
        match (status.as_str(), reg) {
            ("done", Some(reg)) => {
                let code = if existed {
                    StatusCode::ACCEPTED
                } else {
                    StatusCode::CREATED
                };
                return Ok((
                    code,
                    Json(registration_json(&s, &p, &headers, reg, false).await?),
                )
                    .into_response());
            }
            ("failed", _) => {
                return Err(ApiError::detail(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("Registration failed: {}", error.unwrap_or_default()),
                ));
            }
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return Ok((StatusCode::ACCEPTED, Json(json!({"detail": "The registration is queued; no worker finished it in time.", "job": job}))).into_response());
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

#[cfg(test)]
mod fit_tests {
    use super::*;

    #[test]
    fn fits_translation_similarity_and_affine() {
        let (m, e) = fit_points(&[([10.0, 10.0], [15.0, 7.0])]).unwrap();
        assert_eq!((m[0][2], m[1][2], e), (5.0, -3.0, 0.0));
        // scale 2, rotation 90 degrees, shift (100, 50): (x, y) -> (-2y + 100, 2x + 50)
        let f = |x: f64, y: f64| [-2.0 * y + 100.0, 2.0 * x + 50.0];
        let (m, e) = fit_points(&[([0.0, 0.0], f(0.0, 0.0)), ([10.0, 5.0], f(10.0, 5.0))]).unwrap();
        assert!(e < 1e-9 && (m[0][1] + 2.0).abs() < 1e-9 && (m[1][0] - 2.0).abs() < 1e-9);
        // a shear needs the affine fit
        let g = |x: f64, y: f64| [x + 0.5 * y + 3.0, 2.0 * y - 4.0];
        let pts: Vec<Pair> = [[0.0, 0.0], [100.0, 0.0], [0.0, 80.0], [60.0, 90.0]]
            .iter()
            .map(|p| (*p, g(p[0], p[1])))
            .collect();
        let (m, e) = fit_points(&pts).unwrap();
        assert!(e < 1e-9 && (m[0][1] - 0.5).abs() < 1e-9 && (m[1][2] + 4.0).abs() < 1e-9);
        assert!(fit_points(&[
            ([0.0, 0.0], [0.0, 0.0]),
            ([1.0, 1.0], [0.0, 0.0]),
            ([2.0, 2.0], [0.0, 0.0])
        ])
        .is_err());
    }
}
