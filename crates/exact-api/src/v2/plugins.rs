//! Plugins as the screens and the workers see them: registration algorithms next to image analysis (processing) plugins.
//!
//! A plugin is a row of Django's `processing_plugin`; `plugin_type` (1 image analysis, 2 registration) and
//! `parameters_schema` (the parameters a job accepts) are columns shared with EXACT, see migration 0007.
//!
//! - `GET /api/v2/registration-plugins`: the registration algorithms (for the "register" dialog), default first.
//! - `POST /api/v2/plugins/register`: a worker announces a plugin it serves (created, or updated when `name` and `package`
//!   match); needs `processing.add_plugin`.
//! - `GET /api/v2/admin/plugins`: overview for site administrators: every plugin with its jobs by status, the products it
//!   is enabled for and the workers that serve it now.

use crate::{
    auth::{authenticate, require_model_perm, require_user},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    v2::jobs,
    AppState,
};
use axum::{
    body::Bytes,
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use exact_db::users;
use serde_json::{json, Map, Value};
use sqlx::Row;
use std::collections::HashMap;

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/registration-plugins", get(registration_plugins_h))
        .route("/api/v2/plugins/register", post(register_h))
        .route("/api/v2/admin/plugins", get(overview_h))
}

/// The icon of a plugin announced by a worker: EXACT's API shows an unset icon as null, which clients such as exact-sync
/// refuse to read, so a path is stored (the file need not exist; the UI shows no icon).
const DEFAULT_ICON: &str = "plugins/default_plugin.png";
const IMAGE_ANALYSIS: i16 = 1;
const REGISTRATION: i16 = 2;

fn bad(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
}

/// What a parameter schema must look like: a list of `{name, type, ...}`; the types a screen can show.
pub(crate) fn schema_ok(v: &Value) -> Result<(), String> {
    let Value::Array(items) = v else {
        return Err("parameters_schema must be a list.".into());
    };
    let mut names = Vec::new();
    for p in items {
        let name = p
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| !n.is_empty());
        let Some(name) = name else {
            return Err("every parameter needs a name.".into());
        };
        if names.contains(&name) {
            return Err(format!("parameter {name} appears twice."));
        }
        names.push(name);
        match p.get("type").and_then(Value::as_str) {
            Some("int" | "float" | "bool" | "text") => {}
            Some("choice") => {
                if !p
                    .get("choices")
                    .is_some_and(|c| c.as_array().is_some_and(|a| !a.is_empty()))
                {
                    return Err(format!(
                        "parameter {name}: a choice needs a list of choices."
                    ));
                }
            }
            _ => {
                return Err(format!(
                    "parameter {name}: type must be int, float, bool, text or choice."
                ))
            }
        }
    }
    Ok(())
}

/// The parameter names a schema declares.
pub(crate) fn schema_names(schema: &Value) -> Vec<String> {
    schema
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|p| p.get("name").and_then(Value::as_str).map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// The registration plugin used when none is named: the oldest one.
pub(crate) async fn default_registration_plugin(s: &AppState) -> ApiResult<Option<i32>> {
    sqlx::query_scalar(&format!("SELECT pl.id FROM processing_plugin pl WHERE pl.plugin_type = 2 AND {} ORDER BY pl.id LIMIT 1", crate::v2::jobs::CONNECTED_SQL))
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)
}

fn plugin_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "id": r.get::<i32, _>("id"), "name": r.get::<String, _>("name"), "author": r.get::<String, _>("author"),
        "package": r.get::<String, _>("package"), "contact": r.get::<String, _>("contact"), "abouturl": r.get::<String, _>("abouturl"),
        "plugin_type": r.get::<i16, _>("plugin_type"), "parameters_schema": r.get::<Option<Value>, _>("parameters_schema"),
    })
}

const PLUGIN_COLUMNS: &str =
    "id, name, author, package, contact, abouturl, plugin_type, parameters_schema";

async fn registration_plugins_h(
    State(s): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    // only plugins whose worker has been there within a week are offered
    let rows = sqlx::query(&format!("SELECT {PLUGIN_COLUMNS} FROM processing_plugin pl WHERE plugin_type = {REGISTRATION} AND {} ORDER BY id", crate::v2::jobs::CONNECTED_SQL))
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    let items: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| {
            let mut p = plugin_json(r);
            p["default"] = json!(i == 0);
            p
        })
        .collect();
    Ok(Json(json!({"items": items})).into_response())
}

/// `{"name", "author", "package", "plugin_type": 1|2, "parameters_schema": [...], "contact", "abouturl"}`
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
    let d: Map<String, Value> = match serde_json::from_slice(&body) {
        Ok(Value::Object(m)) => m,
        _ => return Err(bad("Expected a JSON object.")),
    };
    let text = |k: &str, max: usize, required: bool| -> ApiResult<String> {
        match d.get(k) {
            Some(Value::String(t))
                if t.chars().count() <= max && (!required || !t.trim().is_empty()) =>
            {
                Ok(t.trim().to_string())
            }
            None if !required => Ok(String::new()),
            _ => Err(bad(&format!(
                "{k}: {}.",
                if required {
                    format!("a text of 1 to {max} characters is required")
                } else {
                    format!("at most {max} characters")
                }
            ))),
        }
    };
    let name = text("name", 200, true)?;
    let author = text("author", 200, false)?;
    let package = text("package", 200, false)?;
    let contact = text("contact", 80, false)?;
    let abouturl = text("abouturl", 80, false)?;
    let plugin_type = match d.get("plugin_type") {
        None => IMAGE_ANALYSIS,
        Some(v) => match v.as_i64() {
            Some(t @ (1 | 2)) => t as i16,
            _ => {
                return Err(bad(
                    "plugin_type must be 1 (image analysis) or 2 (registration).",
                ))
            }
        },
    };
    let schema = match d.get("parameters_schema") {
        None | Some(Value::Null) => None,
        Some(v) => {
            schema_ok(v).map_err(|e| bad(&e))?;
            Some(v.clone())
        }
    };
    let existing: Option<i32> = sqlx::query_scalar(
        "SELECT id FROM processing_plugin WHERE name = $1 AND package = $2 ORDER BY id LIMIT 1",
    )
    .bind(&name)
    .bind(&package)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    let (id, created): (i32, bool) = match existing {
        Some(id) => {
            sqlx::query("UPDATE processing_plugin SET author = $2, contact = $3, abouturl = $4, plugin_type = $5, parameters_schema = $6 WHERE id = $1")
                .bind(id)
                .bind(&author)
                .bind(&contact)
                .bind(&abouturl)
                .bind(plugin_type)
                .bind(&schema)
                .execute(&s.pool)
                .await
                .map_err(db_err)?;
            (id, false)
        }
        None => (
            sqlx::query_scalar(
                "INSERT INTO processing_plugin (name, author, package, contact, abouturl, icon, plugin_type, parameters_schema) \
                 VALUES ($1, $2, $3, $4, $5, $8, $6, $7) RETURNING id",
            )
            .bind(&name)
            .bind(&author)
            .bind(&package)
            .bind(&contact)
            .bind(&abouturl)
            .bind(plugin_type)
            .bind(&schema)
            .bind(DEFAULT_ICON)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?,
            true,
        ),
    };
    let row = sqlx::query(&format!(
        "SELECT {PLUGIN_COLUMNS} FROM processing_plugin WHERE id = $1"
    ))
    .bind(id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    crate::v2::jobs::touch_plugins(&s.pool, &[id as i64]).await;
    let mut out = plugin_json(&row);
    out["created"] = json!(created);
    Ok((
        if created {
            StatusCode::CREATED
        } else {
            StatusCode::OK
        },
        Json(out),
    )
        .into_response())
}

/// Every plugin with its jobs by status, its products, when it was last used and which workers serve it now.
async fn overview_h(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    if !users::is_site_admin(&s.pool, p.user.id).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Site admin permission required.",
        ));
    }
    let plugins = sqlx::query(&format!(
        "SELECT {PLUGIN_COLUMNS} FROM processing_plugin ORDER BY plugin_type DESC, name, id"
    ))
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let default = default_registration_plugin(&s).await?;
    let mut counts: HashMap<i32, HashMap<String, i64>> = HashMap::new();
    let analysis = sqlx::query(&format!(
        "SELECT q.plugin_id, ({}) AS status, count(*)::bigint, max(q.created_time) FROM processing_pluginjob q GROUP BY 1, 2",
        crate::v2::jobs::plugin_job_status_sql()
    ))
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let mut last: HashMap<i32, chrono::DateTime<chrono::Utc>> = HashMap::new();
    for r in &analysis {
        let (id, status, n): (i32, String, i64) = (r.get(0), r.get(1), r.get(2));
        *counts.entry(id).or_default().entry(status).or_default() += n;
        if let Some(t) = r.get::<Option<chrono::DateTime<chrono::Utc>>, _>(3) {
            let e = last.entry(id).or_insert(t);
            if t > *e {
                *e = t;
            }
        }
    }
    let results: HashMap<i32, i64> =
        sqlx::query("SELECT plugin_id, count(*)::bigint FROM processing_pluginresult GROUP BY 1")
            .fetch_all(&s.pool)
            .await
            .map_err(db_err)?
            .iter()
            .map(|r| (r.get(0), r.get(1)))
            .collect();
    let products: Vec<(i32, i64, String)> = sqlx::query(
        "SELECT pp.plugin_id, p.id, p.name FROM processing_plugin_products pp JOIN administration_product p ON p.id = pp.product_id ORDER BY p.name",
    )
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?
    .iter()
    .map(|r| (r.get(0), r.get(1), r.get(2)))
    .collect();
    let workers = jobs::workers_seen();
    let items: Vec<Value> = plugins
        .iter()
        .map(|r| {
            let mut j = plugin_json(r);
            let id: i32 = r.get("id");
            let c = counts.get(&id).cloned().unwrap_or_default();
            let n = |k: &str| c.get(k).copied().unwrap_or(0);
            j["jobs"] = json!({"queued": n("queued"), "running": n("running"), "done": n("done"), "failed": n("failed")});
            j["results"] = json!(results.get(&id).copied().unwrap_or(0));
            j["last_job_at"] = json!(last.get(&id).map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Micros, true)));
            j["default"] = json!(Some(id) == default);
            j["products"] = json!(products.iter().filter(|(pid, _, _)| *pid == id).map(|(_, i, n)| json!({"id": i, "name": n})).collect::<Vec<_>>());
            j["workers"] = json!(workers
                .iter()
                .filter(|w| w["plugins"].as_array().is_some_and(|a| a.iter().any(|x| x.as_i64() == Some(id as i64))))
                .map(|w| json!({"name": w["name"], "seen_seconds_ago": w["seen_seconds_ago"]}))
                .collect::<Vec<_>>());
            j
        })
        .collect();
    Ok(Json(json!({"items": items, "workers": workers})).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_are_checked() {
        assert!(schema_ok(&json!([{"name": "maxFeatures", "type": "int", "default": 512}, {"name": "mode", "type": "choice", "choices": ["a", "b"]}])).is_ok());
        assert!(schema_ok(&json!([])).is_ok());
        assert!(schema_ok(&json!({"name": "x"})).is_err());
        assert!(schema_ok(&json!([{"type": "int"}])).is_err());
        assert!(schema_ok(&json!([{"name": "a", "type": "weird"}])).is_err());
        assert!(schema_ok(&json!([{"name": "a", "type": "choice"}])).is_err());
        assert!(
            schema_ok(&json!([{"name": "a", "type": "int"}, {"name": "a", "type": "int"}]))
                .is_err()
        );
        assert_eq!(
            schema_names(&json!([{"name": "a"}, {"name": "b"}])),
            vec!["a", "b"]
        );
    }
}
