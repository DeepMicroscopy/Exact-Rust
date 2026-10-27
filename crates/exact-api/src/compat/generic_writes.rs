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
        readonly: &["results", "products", "icon"],
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
    d: &Map<String, Value>,
    partial: bool,
    v2: bool,
) -> ApiResult<Vec<(&'static str, Val)>> {
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
            Some(v) => match convert(s, p, f.kind, v).await {
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

fn body_object(body: &[u8]) -> ApiResult<Map<String, Value>> {
    if body.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(other) => Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            body: json!({"non_field_errors": [format!("Invalid data. Expected a dictionary, but got {}.", kind_name(&other))]}),
        }),
        Err(e) => Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("JSON parse error - {e}"),
        )),
    }
}

pub async fn create(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &'static super::engine::Spec,
    w: &W,
    body: &[u8],
    v2: bool,
) -> ApiResult<Response> {
    let d = body_object(body)?;
    let cols = parse(s, p, w, &d, false, v2).await?;
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
    let id: i64 = qb
        .build_query_scalar()
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    Ok((
        StatusCode::CREATED,
        Json(serialized(s, p, headers, spec, id, v2).await?),
    )
        .into_response())
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
    body: &[u8],
    partial: bool,
    v2: bool,
) -> ApiResult<Response> {
    visible(s, p, headers, spec, id, v2).await?;
    let d = body_object(body)?;
    let cols = parse(s, p, w, &d, partial, v2).await?;
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
        qb.build().execute(&s.pool).await.map_err(db_err)?;
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
    body: &[u8],
    v2: bool,
) -> ApiResult<Response> {
    let p = require_model_perm(s, principal, method, spec.perm.0, spec.perm.1).await?;
    match (id, method) {
        (None, &Method::POST) => create(s, &p, headers, spec, w, body, v2).await,
        (Some(id), &Method::PUT) => update(s, &p, headers, spec, w, id, body, false, v2).await,
        (Some(id), &Method::PATCH) => update(s, &p, headers, spec, w, id, body, true, v2).await,
        (Some(id), &Method::DELETE) => delete(s, &p, headers, spec, id, v2).await,
        _ => Err(ApiError::detail(
            StatusCode::METHOD_NOT_ALLOWED,
            "Method not allowed.",
        )),
    }
}
