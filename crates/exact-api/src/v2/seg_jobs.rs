//! Automatic segmentation: workers that compute the mask of a volume, and the jobs that ask them for it.
//!
//! A *segmenter* is a method a worker announces (`helpers/segment_worker.py` serves the Python modules of `helpers/segmenters/`);
//! a *job* asks one segmenter for the mask of one image. The worker fetches the voxels, computes, and puts the result into the
//! mask annotation with `PUT /api/v2/segmentation/{annotation}/labels` (`seg3d.rs`), so the mask arrives in the same tiles, with
//! the same undo and views, as one that was painted.
//!
//! Worker side
//! - `POST /api/v2/segmenters/register {name, author, description, parameters_schema}`: announce (upsert by name); needs
//!   `processing.add_plugin`, as announcing a plugin does
//! - `POST /api/v2/segmentation-jobs/claim {worker, segmenter | segmenters}`: the oldest waiting job (of images in the caller's
//!   teams) is marked as taken, 204 if there is none; a job whose worker has been silent for 30 minutes is offered again
//! - `POST /api/v2/segmentation-jobs/{id}/progress {progress, message}`, `.../complete`, `.../fail {message}`
//! - `GET /api/v2/images/{id}/voxels?kind=display|intensity`: the volume as raw little-endian voxels of the mask grid
//!
//! User side
//! - `GET /api/v2/segmenters`
//! - `POST /api/v2/images/{id}/auto-segment {segmenter, annotation_type, mode, parameters}`: queue a job; needs `annotate` and
//!   `edit_annotation` in the image set; the mask annotation of the type is created if the image has none
//! - `GET /api/v2/segmentation-jobs?image=&status=`, `GET /api/v2/segmentation-jobs/{id}`
//!
//! The jobs page (`jobs.rs`) lists these jobs next to the others as kind `segmentation`.

use crate::{
    auth::{authenticate, require_model_perm, require_user, Principal},
    compat::{
        engine::db_err,
        writes::{image_row, insert_annotation, set_perms, type_row, NewAnnotation},
    },
    error::{ApiError, ApiResult},
    v2::{jobs, plugins, seg3d::geometry},
    AppState,
};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sqlx::{postgres::PgRow, Row};
use std::collections::HashMap;
use std::sync::Arc;

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/segmenters", get(segmenters_h))
        .route("/api/v2/segmenters/register", post(register_h))
        .route("/api/v2/images/{id}/auto-segment", post(create_h))
        .route("/api/v2/images/{id}/voxels", get(voxels_h))
        .route("/api/v2/segmentation-jobs", get(list_h))
        .route("/api/v2/segmentation-jobs/claim", post(claim_h))
        .route("/api/v2/segmentation-jobs/{id}", get(get_h))
        .route("/api/v2/segmentation-jobs/{id}/progress", post(progress_h))
        .route("/api/v2/segmentation-jobs/{id}/complete", post(complete_h))
        .route("/api/v2/segmentation-jobs/{id}/fail", post(fail_h))
}

/// Seconds without a word from a worker after which its job is offered to another.
const LEASE: &str = "30 minutes";

fn bad(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
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

/// Images of the caller's teams, as a SQL condition on `image_id` (`$1` user, `$2` token teams are bound by the callers
/// that use it with the given parameter numbers).
fn visible(user: &str, teams: &str) -> String {
    format!(
        "SELECT i.id FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = {user} AND ({teams}::bigint[] IS NULL OR team_id = ANY({teams})))"
    )
}

fn stamp(t: Option<DateTime<Utc>>) -> Option<String> {
    t.map(|d| d.to_rfc3339_opts(SecondsFormat::Micros, true))
}

const JOB_COLUMNS: &str = "q.id, q.image_id, q.segmenter, q.annotation_type_id, q.annotation_id, q.mode, q.parameters, q.status, q.progress, \
     q.message, q.worker, q.created_by, q.created_at, q.updated_at, q.finished_at";

fn job_json(r: &PgRow) -> Value {
    let status: String = r.get("status");
    json!({
        "id": r.get::<i64, _>("id"), "image": r.get::<i64, _>("image_id"), "segmenter": r.get::<String, _>("segmenter"),
        "annotation_type": r.get::<i64, _>("annotation_type_id"), "annotation": r.get::<Option<i64>, _>("annotation_id"),
        "mode": r.get::<String, _>("mode"), "parameters": r.get::<Value, _>("parameters"),
        "status": status, "progress": r.get::<f32, _>("progress"), "message": r.get::<Option<String>, _>("message"),
        "worker": r.get::<Option<String>, _>("worker"), "creator": r.get::<Option<i64>, _>("created_by"),
        "created_at": stamp(r.get("created_at")),
        "started_at": if status == "queued" { None } else { stamp(r.get("updated_at")) },
        "finished_at": stamp(r.get("finished_at")),
    })
}

// ------------------------------------------------------------------------------------------------ segmenters

async fn register_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    require_model_perm(
        &s,
        authenticate(&s, &headers, &Method::POST).await?,
        &Method::POST,
        "processing",
        "plugin",
    )
    .await?;
    let d = object(&body)?;
    let text = |k: &str, max: usize| -> ApiResult<String> {
        let v = d.get(k).and_then(Value::as_str).unwrap_or("").trim();
        if v.chars().count() > max {
            return Err(bad(&format!("{k}: at most {max} characters.")));
        }
        Ok(v.to_string())
    };
    let name = text("name", 100)?;
    if name.is_empty() {
        return Err(bad("name: a name is required."));
    }
    let schema = d.get("parameters_schema").cloned().unwrap_or(json!([]));
    plugins::schema_ok(&schema).map_err(|m| bad(&m))?;
    let r = sqlx::query(
        "INSERT INTO exact_rust_segmenter (name, author, description, parameters_schema, last_seen) VALUES ($1, $2, $3, $4, now()) \
         ON CONFLICT (name) DO UPDATE SET author = EXCLUDED.author, description = EXCLUDED.description, \
           parameters_schema = EXCLUDED.parameters_schema, last_seen = now() RETURNING id, (xmax = 0)",
    )
    .bind(&name)
    .bind(text("author", 200)?)
    .bind(text("description", 2000)?)
    .bind(&schema)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    let created: bool = r.get(1);
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(json!({"id": r.get::<i64, _>(0), "name": name})),
    )
        .into_response())
}

async fn segmenters_h(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let rows = sqlx::query("SELECT id, name, author, description, parameters_schema, last_seen FROM exact_rust_segmenter ORDER BY name")
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            let seen: DateTime<Utc> = r.get(5);
            json!({
                "id": r.get::<i64, _>(0), "name": r.get::<String, _>(1), "author": r.get::<String, _>(2),
                "description": r.get::<String, _>(3), "parameters_schema": r.get::<Value, _>(4),
                "last_seen": stamp(Some(seen)),
                // a segmenter whose worker has not asked for work for a day is probably gone
                "available": (Utc::now() - seen).num_seconds() < 86_400,
            })
        })
        .collect();
    Ok(Json(json!({"items": items, "workers": jobs::workers_seen().into_iter().filter(|w| w["kinds"].as_array().is_some_and(|k| k.iter().any(|k| k == "segmentation"))).collect::<Vec<_>>()})).into_response())
}

// ------------------------------------------------------------------------------------------------ the volume

/// The image as a volume: its reader and the geometry of the mask grid.
async fn open_volume(
    s: &AppState,
    image: i64,
) -> ApiResult<(Arc<dyn exact_wsi::Slide>, crate::v2::volmask::Geometry)> {
    let r = sqlx::query("SELECT i.filename, st.path FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id WHERE i.id = $1")
        .bind(image)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    let path = s
        .slides
        .root()
        .join(r.get::<String, _>(1))
        .join(r.get::<String, _>(0));
    let slides = s.slides.clone();
    let p = path.to_string_lossy().into_owned();
    let slide = tokio::task::spawn_blocking(move || slides.open_slide(&p))
        .await
        .map_err(|e| exact_core::Error::Internal(e.to_string()))?
        .map_err(|e| bad(&format!("The image cannot be read: {e}")))?;
    let g = geometry(&*slide)
        .ok_or_else(|| bad("This image is not a volume: it has no coronal and sagittal planes."))?;
    Ok((slide, g))
}

#[derive(Deserialize)]
struct VoxelsQuery {
    kind: Option<String>,
}

async fn voxels_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(image): Path<i64>,
    Query(q): Query<VoxelsQuery>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let img = image_row(&s, image)
        .await?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    if !set_perms(&s, &p, img.set_id).await?.read {
        return Err(ApiError::not_found("No Image matches the given query."));
    }
    let intensity = match q.kind.as_deref() {
        None | Some("display") => false,
        Some("intensity") => true,
        Some(_) => return Err(bad("kind is \"display\" or \"intensity\".")),
    };
    let (slide, g) = open_volume(&s, image).await?;
    if intensity && slide.intensity_slice(0).is_none() {
        return Err(bad(
            "This image has no intensity values: ask for kind=display.",
        ));
    }
    let (w, h, n) = (g.w, g.h, g.n);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::task::spawn_blocking(move || {
        for z in 0..n {
            let chunk: Result<Bytes, std::io::Error> = if intensity {
                match slide.intensity_slice(z as u32) {
                    Some(v) if v.len() == w * h => Ok(Bytes::from(
                        v.iter().flat_map(|f| f.to_le_bytes()).collect::<Vec<u8>>(),
                    )),
                    _ => Err(std::io::Error::other("slice unavailable")),
                }
            } else {
                match slide.read_region_plane(0, 0, 0, w as u32, h as u32, z as u32, 0) {
                    Ok(img) => Ok(Bytes::from(
                        img.pixels()
                            .map(|p| {
                                ((p.0[0] as u32 * 299 + p.0[1] as u32 * 587 + p.0[2] as u32 * 114)
                                    / 1000) as u8
                            })
                            .collect::<Vec<u8>>(),
                    )),
                    Err(e) => Err(std::io::Error::other(e.to_string())),
                }
            };
            let failed = chunk.is_err();
            if tx.blocking_send(chunk).is_err() || failed {
                break; // the client went away, or a slice could not be read: the body ends short and the client sees it
            }
        }
    });
    // poll_fn, not unfold: the compression layer may poll once more after the end
    let mut rx = rx;
    let stream = futures_util::stream::poll_fn(move |cx| rx.poll_recv(cx));
    let vm = g.voxel_mm();
    let width = w * h * n * if intensity { 4 } else { 1 };
    let mut r = Response::new(Body::from_stream(stream));
    let hv = |v: String| header::HeaderValue::from_str(&v).expect("ascii");
    let hm = r.headers_mut();
    hm.insert(header::CONTENT_TYPE, hv("application/octet-stream".into()));
    hm.insert(header::CONTENT_LENGTH, hv(width.to_string()));
    hm.insert("x-voxels-width", hv(w.to_string()));
    hm.insert("x-voxels-height", hv(h.to_string()));
    hm.insert("x-voxels-frames", hv(n.to_string()));
    hm.insert("x-voxel-mm", hv(format!("{},{},{}", vm[0], vm[1], vm[2])));
    hm.insert(
        "x-dtype",
        hv(if intensity { "float32" } else { "uint8" }.into()),
    );
    hm.insert(header::CACHE_CONTROL, hv("no-store".into()));
    Ok(r)
}

// ------------------------------------------------------------------------------------------------ jobs: user side

fn check_parameters(schema: &Value, given: &Value) -> Result<Value, String> {
    let Value::Object(m) = given else {
        return Err("parameters must be an object.".into());
    };
    let names = plugins::schema_names(schema);
    for (k, v) in m {
        if !names.contains(k) {
            return Err(format!("parameter {k} is not one of this segmenter's."));
        }
        if !matches!(v, Value::Bool(_) | Value::Number(_) | Value::String(_)) {
            return Err(format!("parameter {k} must be a number, text or yes/no."));
        }
    }
    Ok(given.clone())
}

async fn create_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(image): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    let img = image_row(&s, image)
        .await?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    let pm = set_perms(&s, &p, img.set_id).await?;
    if !pm.read {
        return Err(ApiError::not_found("No Image matches the given query."));
    }
    if !pm.annotate || !pm.edit_annotation {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for annotating in this image set missing.",
        ));
    }
    let name = d
        .get("segmenter")
        .and_then(Value::as_str)
        .ok_or_else(|| bad("segmenter: a segmenter is required."))?;
    let schema: Value =
        sqlx::query_scalar("SELECT parameters_schema FROM exact_rust_segmenter WHERE name = $1")
            .bind(name)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?
            .ok_or_else(|| bad("segmenter: no such segmenter."))?;
    let parameters = check_parameters(&schema, d.get("parameters").unwrap_or(&json!({})))
        .map_err(|m| bad(&m))?;
    let mode = match d.get("mode").and_then(Value::as_str) {
        None | Some("replace") => "replace",
        Some("add") => "add",
        Some(_) => return Err(bad("mode is \"replace\" or \"add\".")),
    };
    let type_id = d
        .get("annotation_type")
        .and_then(Value::as_i64)
        .ok_or_else(|| bad("annotation_type: a segmentation type is required."))?;
    let atype = type_row(&s, type_id)
        .await?
        .ok_or_else(|| bad("annotation_type: no such annotation type."))?;
    let in_product: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM annotations_annotationtype t JOIN administration_product_imagesets pi ON pi.product_id = t.product_id \
         WHERE t.id = $1 AND pi.imageset_id = $2)",
    )
    .bind(type_id)
    .bind(img.set_id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if atype.vector_type != 8 || !in_product {
        return Err(bad(
            "annotation_type must be a segmentation type of a product of the image set.",
        ));
    }
    let (_slide, g) = open_volume(&s, image).await?;
    let busy: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM exact_rust_segmentation_job WHERE image_id = $1 AND annotation_type_id = $2 AND status IN ('queued', 'running'))",
    )
    .bind(image)
    .bind(type_id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if busy {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "A segmentation of this image for this type is already waiting or running.",
        ));
    }
    // the mask annotation of the type, made if the image has none (as the viewer does when a mask tool is chosen)
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let existing: Option<i64> = sqlx::query_scalar(
        "SELECT id FROM annotations_annotation WHERE image_id = $1 AND annotation_type_id = $2 AND NOT deleted ORDER BY id LIMIT 1",
    )
    .bind(image)
    .bind(type_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(db_err)?;
    let annotation = match existing {
        Some(id) => id,
        None => {
            insert_annotation(
                &mut tx,
                &NewAnnotation {
                    image_id: image,
                    annotation_type_id: type_id,
                    vector: json!({"tile_size": 256, "width": g.w, "height": g.h}),
                    user_id: p.user.id,
                    last_editor_id: p.user.id,
                    blurred: false,
                    concealed: false,
                    description: String::new(),
                    meta_data: Value::Null,
                    unique_identifier: None,
                    deleted: false,
                },
            )
            .await?
        }
    };
    let sql = format!(
        "WITH q AS (INSERT INTO exact_rust_segmentation_job (image_id, segmenter, annotation_type_id, annotation_id, mode, parameters, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *) SELECT {JOB_COLUMNS} FROM q"
    );
    let row = sqlx::query(&sql)
        .bind(image)
        .bind(name)
        .bind(type_id)
        .bind(annotation)
        .bind(mode)
        .bind(&parameters)
        .bind(p.user.id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok((StatusCode::CREATED, Json(job_json(&row))).into_response())
}

async fn list_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let items = list_items(
        &s,
        &p,
        q.get("image").and_then(|v| v.parse().ok()),
        q.get("status").map(String::as_str),
        q.get("limit").and_then(|v| v.parse().ok()).unwrap_or(100),
    )
    .await?;
    Ok(Json(json!({"items": items})).into_response())
}

/// Jobs of the caller's teams, newest first.
pub(crate) async fn list_items(
    s: &AppState,
    p: &Principal,
    image: Option<i64>,
    status: Option<&str>,
    limit: i64,
) -> ApiResult<Vec<Value>> {
    let v = p.viewer();
    let sql = format!(
        "SELECT {JOB_COLUMNS} FROM exact_rust_segmentation_job q WHERE q.image_id IN ({}) \
         AND ($3::bigint IS NULL OR q.image_id = $3) AND ($4::text IS NULL OR q.status = $4) \
         ORDER BY q.created_at DESC, q.id DESC LIMIT {}",
        visible("$1", "$2"),
        limit.clamp(1, 500)
    );
    let rows = sqlx::query(&sql)
        .bind(v.id)
        .bind(v.token_teams)
        .bind(image)
        .bind(status)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(rows.iter().map(job_json).collect())
}

/// A job as the jobs page lists it (the common shape of `jobs.rs`).
pub(crate) fn as_list_item(j: &Value) -> Value {
    let failed = j["status"] == "failed";
    json!({
        "kind": "segmentation", "id": j["id"], "status": j["status"], "image": j["image"], "images": [j["image"].clone()],
        "plugin": null, "plugin_name": j["segmenter"], "progress": j["progress"], "worker": j["worker"],
        "error": if failed { j["message"].clone() } else { Value::Null }, "creator": j["creator"],
        "created_at": j["created_at"], "started_at": j["started_at"], "finished_at": j["finished_at"],
        "result": if j["status"] == "done" { j["annotation"].clone() } else { Value::Null },
    })
}

async fn get_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let (row, _) = job_access(&s, &p, id, false).await?;
    Ok(Json(job_json(&row)).into_response())
}

/// The job if it is on an image of the caller's teams (404 otherwise); `change`: the caller must also be its creator or
/// have `edit_annotation` in the image set (403 otherwise).
async fn job_access(s: &AppState, p: &Principal, id: i64, change: bool) -> ApiResult<(PgRow, i64)> {
    let row = sqlx::query(&format!(
        "SELECT {JOB_COLUMNS}, i.image_set_id AS set_id FROM exact_rust_segmentation_job q JOIN images_image i ON i.id = q.image_id WHERE q.id = $1"
    ))
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("Not found."))?;
    let set_id: i64 = row.get("set_id");
    let pm = set_perms(s, p, set_id).await?;
    if !pm.read {
        return Err(ApiError::not_found("Not found."));
    }
    if change && row.get::<Option<i64>, _>("created_by") != Some(p.user.id) && !pm.edit_annotation {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Only the creator of a job or a user who may edit annotations here can do this.",
        ));
    }
    Ok((row, set_id))
}

/// Removes a job (a running one is cancelled: its worker is told the job is gone when it reports).
pub(crate) async fn remove(s: &AppState, p: &Principal, id: i64) -> ApiResult<()> {
    job_access(s, p, id, true).await?;
    sqlx::query("DELETE FROM exact_rust_segmentation_job WHERE id = $1")
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

/// Queues a failed job again.
pub(crate) async fn restart(s: &AppState, p: &Principal, id: i64) -> ApiResult<()> {
    let (row, _) = job_access(s, p, id, true).await?;
    if row.get::<String, _>("status") != "failed" {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "Only a failed job can be restarted.",
        ));
    }
    sqlx::query("UPDATE exact_rust_segmentation_job SET status = 'queued', progress = 0, message = NULL, worker = NULL, finished_at = NULL, created_at = now(), updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(())
}

// ------------------------------------------------------------------------------------------------ jobs: worker side

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
    let names: Option<Vec<String>> = match (d.get("segmenters"), d.get("segmenter")) {
        (Some(Value::Array(a)), _) => Some(
            a.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect(),
        ),
        (_, Some(Value::String(n))) => Some(vec![n.clone()]),
        (None, None) => None,
        _ => return Err(bad("segmenter is a name, segmenters a list of names.")),
    };
    jobs::seen(&worker, &["segmentation"], &[]);
    let v = p.viewer();
    let sql = format!(
        "UPDATE exact_rust_segmentation_job q SET status = 'running', worker = $1, progress = 0, message = NULL, updated_at = now() WHERE q.id = ( \
           SELECT c.id FROM exact_rust_segmentation_job c \
           WHERE (c.status = 'queued' OR (c.status = 'running' AND c.updated_at < now() - interval '{LEASE}')) \
             AND ($2::text[] IS NULL OR c.segmenter = ANY($2)) \
             AND c.image_id IN ({}) \
           ORDER BY c.created_at, c.id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING {JOB_COLUMNS}",
        visible("$3", "$4")
    );
    let row = sqlx::query(&sql)
        .bind(&worker)
        .bind(names)
        .bind(v.id)
        .bind(v.token_teams)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(match row {
        Some(r) => Json(job_json(&r)).into_response(),
        None => StatusCode::NO_CONTENT.into_response(),
    })
}

/// A report from the worker that has the job: the job must be running (and be this worker's, when the report names it).
async fn running(s: &AppState, p: &Principal, id: i64, d: &Map<String, Value>) -> ApiResult<()> {
    let (row, _) = job_access(s, p, id, false).await?;
    if row.get::<String, _>("status") != "running" {
        return Err(ApiError::detail(
            StatusCode::CONFLICT,
            "The job is not running.",
        ));
    }
    if let (Some(w), Some(mine)) = (
        d.get("worker").and_then(Value::as_str),
        row.get::<Option<String>, _>("worker"),
    ) {
        if w != mine {
            return Err(ApiError::detail(
                StatusCode::CONFLICT,
                "The job is taken by another worker.",
            ));
        }
    }
    Ok(())
}

fn message(d: &Map<String, Value>) -> Option<String> {
    d.get("message")
        .and_then(Value::as_str)
        .map(|m| m.chars().take(2000).collect())
}

async fn progress_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    running(&s, &p, id, &d).await?;
    let progress = d
        .get("progress")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .clamp(0.0, 1.0);
    sqlx::query("UPDATE exact_rust_segmentation_job SET progress = $2, message = COALESCE($3, message), updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(progress as f32)
        .bind(message(&d))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn complete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    running(&s, &p, id, &d).await?;
    sqlx::query("UPDATE exact_rust_segmentation_job SET status = 'done', progress = 1, message = COALESCE($2, message), finished_at = now(), updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(message(&d))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn fail_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    running(&s, &p, id, &d).await?;
    sqlx::query("UPDATE exact_rust_segmentation_job SET status = 'failed', message = $2, finished_at = now(), updated_at = now() WHERE id = $1")
        .bind(id)
        .bind(message(&d).unwrap_or_else(|| "The worker gave no reason.".into()))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_job_carries_only_parameters_the_segmenter_declares_and_plain_values() {
        let schema = json!([{"name": "level", "type": "float"}, {"name": "tidy", "type": "bool"}]);
        assert!(check_parameters(&schema, &json!({"level": 0.5, "tidy": true})).is_ok());
        assert!(check_parameters(&schema, &json!({})).is_ok());
        assert!(check_parameters(&schema, &json!({"other": 1}))
            .unwrap_err()
            .contains("other"));
        assert!(check_parameters(&schema, &json!({"level": [1]})).is_err());
        assert!(check_parameters(&schema, &json!({"level": null})).is_err());
        assert!(check_parameters(&schema, &json!([1])).is_err());
    }

    #[test]
    fn the_jobs_page_shape_of_a_segmentation_job() {
        let job = json!({"id": 4, "image": 9, "segmenter": "Threshold", "status": "failed", "progress": 0.3, "worker": "w", "creator": 1,
            "message": "no model", "annotation": 77, "created_at": "2026-10-31T00:00:00.000000Z", "started_at": null, "finished_at": null});
        let item = as_list_item(&job);
        assert_eq!(item["kind"], "segmentation");
        assert_eq!(item["error"], "no model");
        assert_eq!(item["images"], json!([9]));
        assert!(item["result"].is_null(), "only a finished job has a result");
        let done =
            as_list_item(&json!({"status": "done", "annotation": 77, "message": "x", "image": 1}));
        assert_eq!(done["result"], 77);
        assert!(done["error"].is_null());
    }
}
