//! Image analysis from the viewer: what an image has (results of plugins) and what can be run on it (plugins whose products meet
//! the products of the image's set), starting a job with parameters, and the detections of a result.
//!
//! - `GET  /api/v2/images/{id}/analysis`: `{results, plugins}`; a plugin is offered when it names no product at all or shares one with
//!   the image's set; `served` says whether a worker asked for its jobs lately; `job` is the latest job of the plugin on this image.
//! - `POST /api/v2/images/{id}/analyze` `{"plugin", "params"}`: queues a job (202); an open job of the plugin on the image is reused (200).
//! - `GET  /api/v2/plugin-result-entries/{id}/detections`: the boxes (`[x1, y1, x2, y2, score, type]`) and polygons of an entry.

use crate::{
    auth::{authenticate, require_user, Principal},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    v2::jobs::{plugin_job_status_sql, workers_seen},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};
use sqlx::Row;

/// Most detections one answer carries (an entry with more says `truncated`).
const MAX_DETECTIONS: i64 = 300_000;

fn bad(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
}

/// The set of the image, if the caller belongs to the team that owns it (404 otherwise).
async fn visible_image(s: &AppState, p: &Principal, image: i64) -> ApiResult<i64> {
    let viewer = p.viewer();
    let teams: Option<Vec<i64>> = viewer.token_teams.as_ref().map(|t| t.to_vec());
    sqlx::query_scalar(
        "SELECT i.image_set_id::bigint FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE i.id::bigint = $1 AND st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $2 \
           AND ($3::bigint[] IS NULL OR team_id = ANY($3)))",
    )
    .bind(image)
    .bind(viewer.id)
    .bind(teams)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("Not found."))
}

/// Plugins of type image analysis that may run on images of `set`: those without products, and those that share one with the set.
const AVAILABLE_SQL: &str = "pl.plugin_type = 1 AND (NOT EXISTS (SELECT 1 FROM processing_plugin_products pp WHERE pp.plugin_id = pl.id) \
     OR EXISTS (SELECT 1 FROM processing_plugin_products pp JOIN administration_product_imagesets ap ON ap.product_id = pp.product_id \
                WHERE pp.plugin_id = pl.id AND ap.imageset_id::bigint = $1))";

pub async fn analysis_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(image): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let set = visible_image(&s, &p, image).await?;
    let results = sqlx::query(
        "SELECT r.id::bigint, r.plugin_id::bigint, pl.name, r.job_id::bigint, r.completed_time \
         FROM processing_pluginresult r JOIN processing_plugin pl ON pl.id = r.plugin_id \
         WHERE r.image_id::bigint = $1 ORDER BY r.completed_time DESC, r.id DESC",
    )
    .bind(image)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let ids: Vec<i64> = results.iter().map(|r| r.get::<i64, _>(0)).collect();
    let entries = sqlx::query(
        "SELECT e.id::bigint, e.pluginresult_id::bigint, e.name, e.default_threshold, \
                (SELECT count(*) FROM processing_pluginresultannotation a WHERE a.pluginresultentry_id = e.id)::bigint \
         FROM processing_pluginresultentry e WHERE e.pluginresult_id::bigint = ANY($1::bigint[]) ORDER BY e.id",
    )
    .bind(&ids)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let results: Vec<Value> = results
        .iter()
        .map(|r| {
            let id: i64 = r.get(0);
            let mine: Vec<Value> = entries
                .iter()
                .filter(|e| e.get::<i64, _>(1) == id)
                .map(|e| json!({"id": e.get::<i64, _>(0), "name": e.get::<String, _>(2), "default_threshold": e.get::<f64, _>(3), "count": e.get::<i64, _>(4)}))
                .collect();
            json!({"id": id, "plugin": {"id": r.get::<i64, _>(1), "name": r.get::<String, _>(2)}, "job": r.get::<Option<i64>, _>(3),
                   "completed_time": r.get::<Option<chrono::DateTime<chrono::Utc>>, _>(4), "entries": mine})
        })
        .collect();

    let plugin_rows = sqlx::query(&format!(
        "SELECT pl.id::bigint, pl.name, pl.package, pl.author, pl.parameters_schema FROM processing_plugin pl WHERE {AVAILABLE_SQL} ORDER BY pl.name"
    ))
    .bind(set)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let jobs = sqlx::query(&format!(
        "SELECT DISTINCT ON (q.plugin_id) q.plugin_id::bigint, q.id::bigint, ({}), q.processing_complete, q.error_message, q.created_time \
         FROM processing_pluginjob q WHERE q.image_id::bigint = $1 ORDER BY q.plugin_id, q.id DESC",
        plugin_job_status_sql()
    ))
    .bind(image)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let workers = workers_seen();
    let plugins: Vec<Value> = plugin_rows
        .iter()
        .map(|r| {
            let id: i64 = r.get(0);
            let served = workers.iter().any(|w| {
                w["kinds"].as_array().is_some_and(|k| k.iter().any(|k| k == "plugin"))
                    && w["plugins"].as_array().is_some_and(|ps| ps.iter().any(|x| x.as_i64() == Some(id)))
            });
            let job = jobs.iter().find(|j| j.get::<i64, _>(0) == id).map(|j| {
                json!({"id": j.get::<i64, _>(1), "status": j.get::<String, _>(2), "progress": j.get::<Option<f64>, _>(3),
                       "error": j.get::<Option<String>, _>(4), "created_time": j.get::<Option<chrono::DateTime<chrono::Utc>>, _>(5)})
            });
            json!({"id": id, "name": r.get::<String, _>(1), "package": r.get::<String, _>(2), "author": r.get::<String, _>(3),
                   "parameters_schema": r.get::<Option<Value>, _>(4).unwrap_or_else(|| json!([])), "served": served, "job": job})
        })
        .collect();
    Ok(Json(json!({"results": results, "plugins": plugins})).into_response())
}

/// The values of a job: every one has to be a parameter of the plugin, and a number, text or yes/no.
fn check_params(schema: &Value, given: &Value) -> Result<Value, String> {
    let Value::Object(m) = given else {
        return Err("params must be an object.".into());
    };
    let names = super::plugins::schema_names(schema);
    for (k, v) in m {
        if !names.contains(k) {
            return Err(format!("parameter {k} is not one of this plugin's."));
        }
        if !matches!(v, Value::Bool(_) | Value::Number(_) | Value::String(_)) {
            return Err(format!("parameter {k} must be a number, text or yes/no."));
        }
    }
    Ok(given.clone())
}

pub async fn analyze_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(image): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let set = visible_image(&s, &p, image).await?;
    let d: Map<String, Value> = match serde_json::from_slice(&body) {
        Ok(Value::Object(m)) => m,
        _ => return Err(bad("Expected a JSON object.")),
    };
    let plugin = d
        .get("plugin")
        .and_then(Value::as_i64)
        .ok_or_else(|| bad("plugin: an id is required."))?;
    let row = sqlx::query(&format!(
        "SELECT pl.parameters_schema FROM processing_plugin pl WHERE pl.id::bigint = $2 AND {AVAILABLE_SQL}"
    ))
    .bind(set)
    .bind(plugin)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| bad("plugin: not an image analysis plugin that is available for the products of this image set."))?;
    let schema: Value = row.get::<Option<Value>, _>(0).unwrap_or_else(|| json!([]));
    let params =
        check_params(&schema, d.get("params").unwrap_or(&json!({}))).map_err(|e| bad(&e))?;
    // an open job of the plugin on the image is the answer, not a second one
    let open: Option<i64> = sqlx::query_scalar(
        "SELECT q.id::bigint FROM processing_pluginjob q WHERE q.image_id::bigint = $1 AND q.plugin_id::bigint = $2 \
           AND q.error_message IS NULL AND q.processing_complete < 100 \
           AND NOT EXISTS (SELECT 1 FROM processing_pluginresult r WHERE r.job_id = q.id) ORDER BY q.id LIMIT 1",
    )
    .bind(image)
    .bind(plugin)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    if let Some(id) = open {
        return Ok(Json(
            json!({"id": id, "plugin": plugin, "image": image, "status": "queued", "reused": true}),
        )
        .into_response());
    }
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO processing_pluginjob (plugin_id, image_id, creator_id, parameters, processing_complete, created_time, updated_time, eta_time) \
         VALUES ($1::int, $2::bigint, $3::bigint, $4, 0, now(), now(), now()) RETURNING id::bigint",
    )
    .bind(plugin as i32)
    .bind(image)
    .bind(p.user.id)
    .bind(params)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    Ok((StatusCode::ACCEPTED, Json(json!({"id": id, "plugin": plugin, "image": image, "status": "queued", "reused": false}))).into_response())
}

pub async fn detections_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(entry): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let head = sqlx::query(
        "SELECT r.image_id::bigint, e.name, e.default_threshold FROM processing_pluginresultentry e \
         JOIN processing_pluginresult r ON r.id = e.pluginresult_id WHERE e.id::bigint = $1",
    )
    .bind(entry)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("Not found."))?;
    visible_image(&s, &p, head.get::<i64, _>(0)).await?;
    let rows = sqlx::query(
        "SELECT a.annotation_type_id::bigint, a.score, a.vector FROM processing_pluginresultannotation a \
         WHERE a.pluginresultentry_id::bigint = $1 ORDER BY a.id LIMIT $2",
    )
    .bind(entry)
    .bind(MAX_DETECTIONS + 1)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let truncated = rows.len() as i64 > MAX_DETECTIONS;
    let (mut boxes, mut polygons, mut type_ids) = (Vec::new(), Vec::new(), Vec::<i64>::new());
    for r in rows.iter().take(MAX_DETECTIONS as usize) {
        let (t, score, vector): (i64, Option<f64>, Option<Value>) = (r.get(0), r.get(1), r.get(2));
        let Some(Value::Object(v)) = vector else {
            continue;
        };
        let num = |k: &str| v.get(k).and_then(Value::as_f64);
        if !type_ids.contains(&t) {
            type_ids.push(t);
        }
        if v.len() == 4 {
            if let (Some(a), Some(b), Some(c), Some(d)) =
                (num("x1"), num("y1"), num("x2"), num("y2"))
            {
                boxes.push(json!([a, b, c, d, score.unwrap_or(0.0), t]));
                continue;
            }
        }
        let mut pts = Vec::new();
        let mut i = 1;
        while let (Some(x), Some(y)) = (num(&format!("x{i}")), num(&format!("y{i}"))) {
            pts.extend([x, y]);
            i += 1;
        }
        if pts.len() >= 4 {
            polygons.push(json!({"t": t, "s": score.unwrap_or(0.0), "p": pts}));
        }
    }
    let types = sqlx::query("SELECT t.id::bigint, t.name, t.color_code FROM annotations_annotationtype t WHERE t.id::bigint = ANY($1::bigint[])")
        .bind(&type_ids)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    let types: Map<String, Value> = types
        .iter()
        .map(|t| {
            (
                t.get::<i64, _>(0).to_string(),
                json!({"name": t.get::<String, _>(1), "color": t.get::<Option<String>, _>(2)}),
            )
        })
        .collect();
    Ok(Json(json!({"id": entry, "name": head.get::<String, _>(1), "default_threshold": head.get::<f64, _>(2),
                   "types": types, "boxes": boxes, "polygons": polygons, "truncated": truncated})).into_response())
}
