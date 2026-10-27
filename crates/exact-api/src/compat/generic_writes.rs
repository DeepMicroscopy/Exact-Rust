//! Writes (POST, PUT, PATCH, DELETE) of the resources that are plain tables: the processing resources the plugin workers
//! use, registrations, screening modes, set tags, action logs and verifications. One implementation serves `/api/v1/...`
//! (DRF-shaped errors, v1 representation) and `/api/v2/...` (`{"detail", "errors"}`, v2 representation).
//!
//! The columns come from the resource's `Spec`; what Django fills in itself (defaults, `auto_now_add`) is listed per
//! resource, because the tables have no column defaults. Permissions are Django's model permissions (`add_`, `change_`,
//! `delete_` + model name) as `DjangoModelPermissions` requires them; a referenced image has to be readable by the
//! caller, existing rows have to be visible to the caller (the resource's scope).
//!
//! Not covered: file fields (`PluginResultBitmap.bitmap`, `Plugin.icon`, `ImageRegistration.file`) and many-to-many fields.

use super::{
    engine::{self, db_err, snake_keys, Ctx, K},
    perms::set_perms_of_image,
    specs,
};
use crate::media::{self, Payload, Upload};
use crate::{
    auth::{require_model_perm, Principal},
    cascade,
    error::{ApiError, ApiResult},
    page::Flex,
    AppState,
};
use axum::{
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Map, Value};
use sqlx::{Postgres, QueryBuilder};

pub struct W {
    pub spec: &'static str,
    /// fields a client cannot write
    pub readonly: &'static [&'static str],
    /// fields that have to be present on create and PUT
    pub required: &'static [&'static str],
    /// `(column, SQL expression)` Django fills in when the client sends nothing
    pub defaults: &'static [(&'static str, &'static str)],
}

pub const WRITABLE: &[W] = &[
    W {
        spec: "PluginJob",
        readonly: &["result"],
        required: &["plugin", "image"],
        defaults: &[
            ("processing_complete", "0"),
            ("created_time", "now()"),
            ("updated_time", "now()"),
            ("eta_time", "now()"),
        ],
    },
    W {
        spec: "PluginResult",
        readonly: &[],
        required: &["plugin", "image"],
        defaults: &[
            ("created_time", "now()"),
            ("completed_time", "now()"),
            ("default_alpha", "1"),
        ],
    },
    W {
        spec: "PluginResultEntry",
        readonly: &["annotation_results", "bitmap_results"],
        required: &["pluginresult", "name"],
        defaults: &[
            ("default_threshold", "0"),
            ("visible", "true"),
            ("created_time", "now()"),
        ],
    },
    W {
        spec: "PluginResultAnnotation",
        readonly: &["generated", "plugin", "time"],
        required: &["annotation_type", "image", "pluginresultentry"],
        defaults: &[
            ("time", "now()"),
            ("unique_identifier", "gen_random_uuid()"),
            ("description", "''"),
            ("score", "0"),
        ],
    },
    W {
        spec: "Plugin",
        readonly: &["results", "products"],
        required: &["name"],
        defaults: &[
            ("author", "''"),
            ("contact", "''"),
            ("package", "''"),
            ("abouturl", "''"),
            ("icon", "''"),
        ],
    },
    W {
        spec: "PluginResultBitmap",
        readonly: &["plugin"],
        required: &["pluginresultentry", "image", "name"],
        defaults: &[
            ("scale_min", "0"),
            ("scale_max", "1"),
            ("default_threshold", "0"),
            ("default_alpha", "1"),
            ("channels", "1"),
            ("frame", "1"),
            (
                "location_rect",
                "'{\"x\": 0, \"y\": 0, \"w\": 10000, \"h\": 10000}'::jsonb",
            ),
            ("bitmap", "''"),
        ],
    },
    W {
        spec: "ImageRegistration",
        readonly: &[
            "file",
            "rotation_angle",
            "inv_matrix",
            "get_scale",
            "get_inv_scale",
        ],
        required: &["source_image", "target_image"],
        defaults: &[("registration_error", "0"), ("runtime", "0")],
    },
    W {
        spec: "ScreeningMode",
        readonly: &[],
        required: &["image"],
        defaults: &[
            ("x_steps", "0"),
            ("y_steps", "0"),
            ("current_index", "0"),
            ("x_resolution", "0"),
            ("y_resolution", "0"),
        ],
    },
    W {
        spec: "SetTag",
        readonly: &["imagesets"],
        required: &["name"],
        defaults: &[],
    },
    W {
        spec: "LogImageAction",
        readonly: &[],
        required: &["action"],
        defaults: &[("time", "now()")],
    },
    W {
        spec: "Verification",
        readonly: &[],
        required: &["annotation"],
        defaults: &[("time", "now()"), ("verified", "false")],
    },
];

/// `(resource, field, required)`: file fields that can be uploaded (multipart) with the resource.
const FILE_FIELDS: &[(&str, &str, bool)] = &[
    ("Plugin", "icon", false),
    ("PluginResultBitmap", "bitmap", true),
];

pub fn writable(spec: &super::engine::Spec) -> Option<&'static W> {
    WRITABLE.iter().find(|w| w.spec == spec.name)
}

#[derive(Clone)]
enum Val {
    Null,
    I(i64),
    F(f64),
    S(String),
    B(bool),
    Dt(DateTime<Utc>),
    U(uuid::Uuid),
    J(Value),
    Ip(String),
}

struct Errors {
    v2: bool,
    map: Map<String, Value>,
}

impl Errors {
    fn add(&mut self, field: &str, msg: &str) {
        self.map.insert(field.to_string(), json!([msg]));
    }
    fn into_result(self) -> ApiResult<()> {
        if self.map.is_empty() {
            return Ok(());
        }
        let body = if self.v2 {
            json!({"detail": "Validation failed.", "errors": self.map})
        } else {
            Value::Object(self.map)
        };
        Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            body,
        })
    }
}

fn kind_name(v: &Value) -> &'static str {
    match v {
        Value::Null => "NoneType",
        Value::Bool(_) => "bool",
        Value::Number(n) if n.is_f64() => "float",
        Value::Number(_) => "int",
        Value::String(_) => "str",
        Value::Array(_) => "list",
        Value::Object(_) => "dict",
    }
}

/// RFC 3339, or the naive local time of the v1 API (`2024-01-02T03:04:05.123456`, server time zone).
fn parse_time(s: &AppState, t: &str) -> Option<DateTime<Utc>> {
    if let Ok(d) = DateTime::parse_from_rfc3339(t) {
        return Some(d.with_timezone(&Utc));
    }
    let naive = chrono::NaiveDateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f").ok()?;
    s.tz.from_local_datetime(&naive)
        .earliest()
        .map(|d| d.with_timezone(&Utc))
}

async fn convert(s: &AppState, p: &Principal, kind: K, v: &Value) -> Result<Val, String> {
    if v.is_null() {
        return Ok(Val::Null);
    }
    match kind {
        K::Int => match v {
            Value::Number(n) if n.is_i64() => Ok(Val::I(n.as_i64().unwrap_or(0))),
            Value::String(t) => t
                .trim()
                .parse()
                .map(Val::I)
                .map_err(|_| "A valid integer is required.".into()),
            _ => Err("A valid integer is required.".into()),
        },
        K::Float => match v {
            Value::Number(n) => Ok(Val::F(n.as_f64().unwrap_or(0.0))),
            Value::String(t) => t
                .trim()
                .parse()
                .map(Val::F)
                .map_err(|_| "A valid number is required.".into()),
            _ => Err("A valid number is required.".into()),
        },
        K::Str => match v {
            Value::String(t) => Ok(Val::S(t.clone())),
            _ => Err("Not a valid string.".into()),
        },
        K::Bool => match v {
            Value::Bool(b) => Ok(Val::B(*b)),
            Value::Number(n) if n.as_i64() == Some(0) || n.as_i64() == Some(1) => {
                Ok(Val::B(n.as_i64() == Some(1)))
            }
            Value::String(t) => match t.to_lowercase().as_str() {
                "true" | "1" | "t" | "yes" | "on" => Ok(Val::B(true)),
                "false" | "0" | "f" | "no" | "off" => Ok(Val::B(false)),
                _ => Err("Must be a valid boolean.".into()),
            },
            _ => Err("Must be a valid boolean.".into()),
        },
        K::Dt => v
            .as_str()
            .and_then(|t| parse_time(s, t))
            .map(Val::Dt)
            .ok_or_else(|| {
                "Datetime has wrong format. Use this format instead: YYYY-MM-DDTHH:MM:SS.ffffff."
                    .to_string()
            }),
        K::Uuid => v
            .as_str()
            .and_then(|t| uuid::Uuid::parse_str(t).ok())
            .map(Val::U)
            .ok_or_else(|| "Must be a valid UUID.".to_string()),
        K::Json => Ok(Val::J(v.clone())),
        K::Inet => v
            .as_str()
            .filter(|t| t.parse::<std::net::IpAddr>().is_ok())
            .map(|t| Val::Ip(t.to_string()))
            .ok_or_else(|| "Enter a valid IPv4 or IPv6 address.".to_string()),
        K::Fk { target, .. } => {
            let id = match v {
                Value::Number(n) if n.is_i64() => n.as_i64().unwrap_or(0),
                Value::String(t) => t.trim().parse::<i64>().map_err(|_| {
                    format!(
                        "Incorrect type. Expected pk value, received {}.",
                        kind_name(v)
                    )
                })?,
                _ => {
                    return Err(format!(
                        "Incorrect type. Expected pk value, received {}.",
                        kind_name(v)
                    ))
                }
            };
            let table = specs::by_name(target).table;
            let ok: bool = sqlx::query_scalar(&format!(
                "SELECT EXISTS (SELECT 1 FROM {table} WHERE id = $1)"
            ))
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .map_err(|e| e.to_string())?;
            if !ok {
                return Err(format!("Invalid pk \"{id}\" - object does not exist."));
            }
            if target == "Image"
                && !set_perms_of_image(s, p, id)
                    .await
                    .map_err(|e| e.status.to_string())?
                    .read
            {
                return Err(format!("Invalid pk \"{id}\" - object does not exist."));
            }
            Ok(Val::I(id))
        }
        _ => Err("This field cannot be written.".into()),
    }
}

/// Form bodies carry JSON fields as text.
fn form_value(form: bool, kind: K, v: &Value) -> Value {
    match (form, kind, v) {
        (true, K::Json, Value::String(t)) => serde_json::from_str(t).unwrap_or_else(|_| v.clone()),
        _ => v.clone(),
    }
}

fn push_val(qb: &mut QueryBuilder<'_, Postgres>, v: &Val) {
    match v {
        Val::Null => qb.push("NULL"),
        Val::I(x) => qb.push_bind(*x),
        Val::F(x) => qb.push_bind(*x),
        Val::S(x) => qb.push_bind(x.clone()),
        Val::B(x) => qb.push_bind(*x),
        Val::Dt(x) => qb.push_bind(*x),
        Val::U(x) => qb.push_bind(*x),
        Val::J(x) => qb.push_bind(x.clone()),
        Val::Ip(x) => qb.push_bind(x.clone()).push("::inet"),
    };
}

/// The columns the client wrote, validated.
async fn parse(
    s: &AppState,
    p: &Principal,
    w: &W,
    payload: &Payload,
    partial: bool,
    v2: bool,
) -> ApiResult<Vec<(&'static str, Val)>> {
    let (d, files) = (&payload.fields, &payload.files);
    let spec = specs::by_name(w.spec);
    let mut errors = Errors {
        v2,
        map: Map::new(),
    };
    let mut out = vec![];
    for f in spec.fields {
        if f.col.is_empty() || matches!(f.kind, K::Id | K::File) || w.readonly.contains(&f.name) {
            continue;
        }
        let key = if v2 {
            engine::snake(f.name)
        } else {
            f.name.to_string()
        };
        match d.get(&key) {
            Some(v) => match convert(s, p, f.kind, &form_value(payload.form, f.kind, v)).await {
                Ok(Val::Null) if w.required.contains(&f.name) => {
                    errors.add(f.name, "This field may not be null.")
                }
                Ok(val) => out.push((f.col, val)),
                Err(m) => errors.add(f.name, &m),
            },
            None if !partial && w.required.contains(&f.name) => {
                errors.add(f.name, "This field is required.")
            }
            None => {}
        }
    }
    for (spec_name, field, required) in FILE_FIELDS {
        if *spec_name == w.spec && *required && !partial && !files.iter().any(|f| f.field == *field)
        {
            errors.add(field, "No file was submitted.");
        }
    }
    errors.into_result()?;
    Ok(out)
}

fn ctx<'a>(s: &'a AppState, p: &Principal, headers: &HeaderMap, v2: bool) -> Ctx<'a> {
    Ctx {
        s,
        viewer: p.viewer(),
        host: headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string(),
        v2,
    }
}

async fn serialized(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &super::engine::Spec,
    id: i64,
    v2: bool,
) -> ApiResult<Value> {
    let v = engine::serialize_ids(&ctx(s, p, headers, v2), spec, &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    Ok(if v2 { snake_keys(v) } else { v })
}

pub async fn create(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &'static super::engine::Spec,
    w: &W,
    payload: Payload,
    v2: bool,
) -> ApiResult<Response> {
    let cols = parse(s, p, w, &payload, false, v2).await?;
    let mut names: Vec<&str> = cols.iter().map(|(c, _)| *c).collect();
    for (c, _) in w.defaults {
        if !names.contains(c) {
            names.push(c);
        }
    }
    let mut qb = QueryBuilder::<Postgres>::new(format!("INSERT INTO {} (", spec.table));
    qb.push(names.join(", ")).push(") VALUES (");
    for (i, n) in names.iter().enumerate() {
        if i > 0 {
            qb.push(", ");
        }
        match cols.iter().find(|(c, _)| c == n) {
            Some((_, v)) => push_val(&mut qb, v),
            None => {
                let expr = w
                    .defaults
                    .iter()
                    .find(|(c, _)| c == n)
                    .map(|(_, e)| *e)
                    .unwrap_or("NULL");
                qb.push(expr);
            }
        }
    }
    qb.push(") RETURNING id::bigint");
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let id: i64 = qb
        .build_query_scalar()
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
    let stored = store_files(s, &mut tx, spec, w, id, &payload.files).await;
    match stored {
        Ok(_) => tx.commit().await.map_err(db_err)?,
        Err((e, paths)) => {
            for p in paths {
                media::remove(s, &p).await;
            }
            return Err(e);
        }
    }
    Ok((
        StatusCode::CREATED,
        Json(serialized(s, p, headers, spec, id, v2).await?),
    )
        .into_response())
}

/// Stores the uploaded files of the resource's file fields and sets the columns. On failure returns the files written so far.
async fn store_files(
    s: &AppState,
    tx: &mut sqlx::Transaction<'_, Postgres>,
    spec: &super::engine::Spec,
    w: &W,
    id: i64,
    files: &[Upload],
) -> Result<(), (ApiError, Vec<String>)> {
    let mut written = vec![];
    for (spec_name, field, _) in FILE_FIELDS {
        if *spec_name != w.spec {
            continue;
        }
        let Some(up) = files.iter().find(|f| f.field == *field) else {
            continue;
        };
        let col = spec
            .fields
            .iter()
            .find(|f| f.name == *field)
            .map(|f| f.col)
            .unwrap_or("");
        let result: ApiResult<String> = async {
            let dir = upload_dir(tx, w.spec, id).await?;
            media::store(s, &dir, &up.filename, &up.data).await
        }
        .await;
        match result {
            Ok(rel) => {
                written.push(rel.clone());
                let r = sqlx::query(&format!(
                    "UPDATE {} SET {col} = $2 WHERE id = $1",
                    spec.table
                ))
                .bind(id)
                .bind(&rel)
                .execute(&mut **tx)
                .await
                .map_err(db_err);
                if let Err(e) = r {
                    return Err((e, written));
                }
            }
            Err(e) => return Err((e, written)),
        }
    }
    Ok(())
}

/// Storage directory like the Django `upload_to` functions (`plugins/<name>_<id>/...`).
async fn upload_dir(
    tx: &mut sqlx::Transaction<'_, Postgres>,
    spec: &str,
    id: i64,
) -> ApiResult<String> {
    match spec {
        "Plugin" => {
            let name: String =
                sqlx::query_scalar("SELECT name FROM processing_plugin WHERE id = $1")
                    .bind(id as i32)
                    .fetch_one(&mut **tx)
                    .await
                    .map_err(db_err)?;
            Ok(format!("plugins/{}_{id}", media::valid_name(&name)))
        }
        _ => {
            let (name, plugin, image): (String, i32, i64) = sqlx::query_as(
                "SELECT p.name, p.id, b.image_id FROM processing_pluginresultbitmap b \
                 JOIN processing_pluginresultentry e ON e.id = b.pluginresultentry_id \
                 JOIN processing_pluginresult r ON r.id = e.pluginresult_id \
                 JOIN processing_plugin p ON p.id = r.plugin_id WHERE b.id = $1",
            )
            .bind(id as i32)
            .fetch_one(&mut **tx)
            .await
            .map_err(db_err)?;
            Ok(format!(
                "plugins/{}_{plugin}/{image}",
                media::valid_name(&name)
            ))
        }
    }
}

/// The row has to be visible to the caller (the resource's scope), else 404.
async fn visible(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &'static super::engine::Spec,
    id: i64,
    v2: bool,
) -> ApiResult<()> {
    let (_, found) = engine::list(
        &ctx(s, p, headers, v2),
        spec,
        &[],
        &Flex::default(),
        1,
        0,
        Some(id),
    )
    .await?;
    if found.is_empty() {
        return Err(ApiError::not_found("Not found."));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub async fn update(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &'static super::engine::Spec,
    w: &W,
    id: i64,
    payload: Payload,
    partial: bool,
    v2: bool,
) -> ApiResult<Response> {
    visible(s, p, headers, spec, id, v2).await?;
    let cols = parse(s, p, w, &payload, partial, v2).await?;
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    if !cols.is_empty() {
        let mut qb = QueryBuilder::<Postgres>::new(format!("UPDATE {} SET ", spec.table));
        for (i, (c, v)) in cols.iter().enumerate() {
            if i > 0 {
                qb.push(", ");
            }
            qb.push(*c).push(" = ");
            push_val(&mut qb, v);
        }
        qb.push(" WHERE id = ").push_bind(id);
        qb.build().execute(&mut *tx).await.map_err(db_err)?;
    }
    match store_files(s, &mut tx, spec, w, id, &payload.files).await {
        Ok(_) => tx.commit().await.map_err(db_err)?,
        Err((e, paths)) => {
            for p in paths {
                media::remove(s, &p).await;
            }
            return Err(e);
        }
    }
    Ok(Json(serialized(s, p, headers, spec, id, v2).await?).into_response())
}

pub async fn delete(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &'static super::engine::Spec,
    id: i64,
    v2: bool,
) -> ApiResult<Response> {
    visible(s, p, headers, spec, id, v2).await?;
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    cascade::delete_rows(&mut tx, spec.table, &[id]).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// Entry for both API versions: model permission by method, then the operation. `id` is `None` for the collection.
#[allow(clippy::too_many_arguments)]
pub async fn handle(
    s: &AppState,
    principal: Option<Principal>,
    headers: &HeaderMap,
    method: &Method,
    spec: &'static super::engine::Spec,
    w: &W,
    id: Option<i64>,
    body: &axum::body::Bytes,
    v2: bool,
) -> ApiResult<Response> {
    let p = require_model_perm(s, principal, method, spec.perm.0, spec.perm.1).await?;
    let payload = || media::parse_body(headers, body);
    match (id, method) {
        (None, &Method::POST) => create(s, &p, headers, spec, w, payload().await?, v2).await,
        (Some(id), &Method::PUT) => {
            update(s, &p, headers, spec, w, id, payload().await?, false, v2).await
        }
        (Some(id), &Method::PATCH) => {
            update(s, &p, headers, spec, w, id, payload().await?, true, v2).await
        }
        (Some(id), &Method::DELETE) => delete(s, &p, headers, spec, id, v2).await,
        _ => Err(ApiError::detail(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed.",
        )),
    }
}
