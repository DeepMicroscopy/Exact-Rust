//! A table-driven engine for the DRF-style list/retrieve endpoints of the compat API.
//!
//! Every resource is described once (`Spec`: table, visibility SQL, serializer fields, filters); the engine then
//! provides what DRF + django-filter + drf-flex-fields provide in Django: scoped querysets, filter parsing and
//! validation, limit/offset pagination, related-id lists and `expand`/`fields`/`omit`.

use crate::{
    error::{ApiError, ApiResult},
    page::{drf_datetime, Flex},
    AppState,
};
use axum::http::StatusCode;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use exact_db::users::Viewer;
use serde_json::{json, Map, Value};
use sqlx::{Postgres, QueryBuilder, Row};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

// ---------------------------------------------------------------------------------------------------------
// resource description
// ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Copy)]
pub enum K {
    Id,
    Int,
    Float,
    Str,
    Bool,
    Dt,
    Json,
    File,
    Uuid,
    Inet,
    Fk {
        target: &'static str,
        expand: bool,
    },
    M2m {
        target: &'static str,
        through: &'static str,
        left: &'static str,
        right: &'static str,
        expand: bool,
    },
    Rev {
        target: &'static str,
        table: &'static str,
        col: &'static str,
        expand: bool,
    },
    /// reverse one-to-one: the id of the single related row or null
    RevOne {
        target: &'static str,
        table: &'static str,
        col: &'static str,
        expand: bool,
    },
    Comp(Comp),
}

/// Fields that are not plain columns.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Comp {
    VerifiedByUser,
    Concealed,
    Blurred,
    Generated,
    HasChanges,
    RotationAngle,
    InvMatrix,
    Scale,
    InvScale,
    /// `PluginResultAnnotation.plugin` / `PluginResultBitmap.plugin`: the plugin id of the entry's result
    PluginOfEntry,
    /// `PluginResultAnnotation.generated` is always true
    GeneratedTrue,
}

#[derive(Clone, Copy)]
pub struct F {
    pub name: &'static str,
    /// database column for scalar and FK fields
    pub col: &'static str,
    pub kind: K,
}

pub const fn f(name: &'static str, col: &'static str, kind: K) -> F {
    F { name, col, kind }
}

#[derive(Clone, Copy)]
pub enum T {
    /// DecimalField: integer or decimal number
    Num,
    Int,
    /// django-filter `BooleanWidget`: 1/0/true/false (case-insensitive)
    Bool,
    /// `NullBooleanSelect`: true/True/2 and false/False/3
    NullBool,
    Uuid,
    /// `DateTimeFilter`: naive local time (`USE_TZ=False`)
    Dt,
    /// `IsoDateTimeFilter`: ISO 8601, offset allowed
    IsoDt,
    Choice(&'static [i64]),
    Str,
}

#[derive(Clone, Copy)]
pub enum Shape {
    One(T),
    /// comma separated list (`*__in`)
    List(T),
    /// comma separated pair (`*__range`)
    Range(T),
    Contains,
    /// pk of an existing row of the table (`ModelChoiceFilter`)
    ModelChoice(&'static str),
    ModelChoiceIn(&'static str),
    /// repeatable parameter, any-of (`ModelMultipleChoiceFilter`)
    ModelMulti(&'static str),
}

#[derive(Clone, Copy)]
pub struct Flt {
    pub param: &'static str,
    pub shape: Shape,
    /// SQL condition on alias `t`; `{}` marks bound values (a list for `List`/`ModelMulti`), `{VT}` the viewer's teams
    pub sql: &'static str,
}

pub struct Spec {
    pub name: &'static str,
    pub table: &'static str,
    /// (app label, model) for `DjangoModelPermissions`
    pub perm: (&'static str, &'static str),
    pub fields: &'static [F],
    /// visibility predicate on alias `t` (empty = everything is visible, as in Django for some resources)
    pub scope: &'static str,
    pub filters: &'static [Flt],
    pub order: &'static str,
}

#[macro_export]
macro_rules! flt {
    ($p:literal, $shape:expr, $sql:expr) => {
        $crate::compat::engine::Flt {
            param: $p,
            shape: $shape,
            sql: $sql,
        }
    };
}

// ---------------------------------------------------------------------------------------------------------
// bound values and SQL templates
// ---------------------------------------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum V {
    I(i64),
    F(f64),
    S(String),
    B(bool),
    Dt(DateTime<Utc>),
    U(uuid::Uuid),
    IL(Vec<i64>),
    SL(Vec<String>),
    UL(Vec<uuid::Uuid>),
}

fn bind(qb: &mut QueryBuilder<'_, Postgres>, v: &V) {
    match v {
        V::I(x) => qb.push_bind(*x),
        V::F(x) => qb.push_bind(*x),
        V::S(x) => qb.push_bind(x.clone()),
        V::B(x) => qb.push_bind(*x),
        V::Dt(x) => qb.push_bind(*x),
        V::U(x) => qb.push_bind(*x),
        V::IL(x) => qb.push_bind(x.clone()),
        V::SL(x) => qb.push_bind(x.clone()),
        V::UL(x) => qb.push_bind(x.clone()),
    };
}

/// Pushes `tpl`, replacing `{}` by the next value and `{VT}` by the viewer's team subquery.
fn push_tpl(qb: &mut QueryBuilder<'_, Postgres>, tpl: &str, vals: &[V], viewer: &Viewer) {
    let mut vals = vals.iter();
    let mut rest = tpl;
    while let Some(i) = rest.find('{') {
        qb.push(&rest[..i]);
        if rest[i..].starts_with("{VT}") {
            qb.push("(SELECT team_id FROM users_teammembership WHERE user_id = ")
                .push_bind(viewer.id);
            if let Some(t) = &viewer.token_teams {
                qb.push(" AND team_id = ANY(")
                    .push_bind(t.clone())
                    .push(")");
            }
            qb.push(")");
            rest = &rest[i + 4..];
        } else if rest[i..].starts_with("{}") {
            if let Some(v) = vals.next() {
                bind(qb, v);
            }
            rest = &rest[i + 2..];
        } else {
            qb.push("{");
            rest = &rest[i + 1..];
        }
    }
    qb.push(rest);
}

// ---------------------------------------------------------------------------------------------------------
// filter parsing (django-filter semantics)
// ---------------------------------------------------------------------------------------------------------

pub struct Params<'a> {
    pub pairs: &'a [(String, String)],
}

impl Params<'_> {
    fn last(&self, k: &str) -> Option<&str> {
        self.pairs
            .iter()
            .rev()
            .find(|(key, _)| key == k)
            .map(|(_, v)| v.as_str())
            .filter(|v| !v.is_empty())
    }
    fn all(&self, k: &str) -> Vec<&str> {
        self.pairs
            .iter()
            .filter(|(key, v)| key == k && !v.is_empty())
            .map(|(_, v)| v.as_str())
            .collect()
    }
}

const MSG_NUMBER: &str = "Enter a number.";
const MSG_MODEL_CHOICE: &str =
    "Select a valid choice. That choice is not one of the available choices.";

fn parse_dt(s: &str, tz: chrono_tz::Tz, iso: bool) -> Option<DateTime<Utc>> {
    let s = s.trim();
    if iso || s.contains('T') {
        if let Ok(d) = DateTime::parse_from_rfc3339(s) {
            return Some(d.with_timezone(&Utc));
        }
    }
    let naive = [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M",
    ]
    .iter()
    .find_map(|f| NaiveDateTime::parse_from_str(s, f).ok())
    .or_else(|| {
        NaiveDate::parse_from_str(s, "%Y-%m-%d")
            .ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0))
    })?;
    tz.from_local_datetime(&naive)
        .earliest()
        .map(|d| d.with_timezone(&Utc))
}

fn parse_one(
    ty: T,
    s: &str,
    param: &str,
    tz: chrono_tz::Tz,
) -> Result<Option<V>, (String, String)> {
    let err = |m: String| (param.to_string(), m);
    Ok(Some(match ty {
        T::Int | T::Num => {
            let s = s.trim();
            if let Ok(i) = s.parse::<i64>() {
                V::I(i)
            } else if let Ok(f) = s.parse::<f64>() {
                if f.is_finite() {
                    V::F(f)
                } else {
                    return Err(err(MSG_NUMBER.into()));
                }
            } else {
                return Err(err(MSG_NUMBER.into()));
            }
        }
        T::Str => V::S(s.to_string()),
        T::Bool => match s.to_lowercase().as_str() {
            "1" | "true" => V::B(true),
            "0" | "false" => V::B(false),
            _ => return Ok(None),
        },
        T::NullBool => match s {
            "true" | "True" | "2" => V::B(true),
            "false" | "False" | "3" => V::B(false),
            _ => return Ok(None),
        },
        T::Uuid => V::U(
            s.trim()
                .parse()
                .map_err(|_| err("Enter a valid UUID.".into()))?,
        ),
        T::Dt => {
            V::Dt(parse_dt(s, tz, false).ok_or_else(|| err("Enter a valid date/time.".into()))?)
        }
        T::IsoDt => {
            V::Dt(parse_dt(s, tz, true).ok_or_else(|| err("Enter a valid date/time.".into()))?)
        }
        T::Choice(choices) => {
            let v: i64 = s.trim().parse().map_err(|_| {
                err(format!(
                    "Select a valid choice. {s} is not one of the available choices."
                ))
            })?;
            if !choices.contains(&v) {
                return Err(err(format!(
                    "Select a valid choice. {s} is not one of the available choices."
                )));
            }
            V::I(v)
        }
    }))
}

fn to_list(ty: T, vals: Vec<V>) -> V {
    match (ty, vals.first()) {
        (T::Uuid, _) => V::UL(
            vals.into_iter()
                .filter_map(|v| if let V::U(u) = v { Some(u) } else { None })
                .collect(),
        ),
        (T::Str, _) => V::SL(
            vals.into_iter()
                .filter_map(|v| if let V::S(u) = v { Some(u) } else { None })
                .collect(),
        ),
        _ => V::IL(
            vals.into_iter()
                .filter_map(|v| if let V::I(u) = v { Some(u) } else { None })
                .collect(),
        ),
    }
}

/// Parses and validates all filters of `spec` against the query string. Errors are collected like django-filter does.
pub async fn parse_filters(
    s: &AppState,
    spec: &Spec,
    p: &Params<'_>,
) -> ApiResult<Vec<(&'static Flt, Vec<V>)>> {
    let mut out = vec![];
    let mut errors: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut push_err = |(k, m): (String, String)| {
        let list = errors.entry(k).or_default();
        if !list.contains(&m) {
            list.push(m);
        }
    };
    for fl in spec.filters {
        match fl.shape {
            Shape::One(ty) => {
                if let Some(raw) = p.last(fl.param) {
                    match parse_one(ty, raw, fl.param, s.tz) {
                        Ok(Some(v)) => out.push((fl, vec![v])),
                        Ok(None) => {}
                        Err(e) => push_err(e),
                    }
                }
            }
            Shape::Contains => {
                if let Some(raw) = p.last(fl.param) {
                    out.push((
                        fl,
                        vec![V::S(format!(
                            "%{}%",
                            raw.replace('\\', "\\\\")
                                .replace('%', "\\%")
                                .replace('_', "\\_")
                        ))],
                    ));
                }
            }
            Shape::List(ty) | Shape::Range(ty) => {
                if let Some(raw) = p.last(fl.param) {
                    let mut vals = vec![];
                    let mut bad = false;
                    for part in raw.split(',') {
                        match parse_one(ty, part, fl.param, s.tz) {
                            Ok(Some(v)) => vals.push(v),
                            Ok(None) => {}
                            Err(e) => {
                                push_err(e);
                                bad = true;
                                break;
                            }
                        }
                    }
                    if bad {
                        continue;
                    }
                    if let Shape::Range(_) = fl.shape {
                        if vals.len() != 2 {
                            push_err((fl.param.to_string(), "Invalid range".into()));
                            continue;
                        }
                        out.push((fl, vals));
                    } else {
                        out.push((fl, vec![to_list(ty, vals)]));
                    }
                }
            }
            Shape::ModelChoice(table) => {
                if let Some(raw) = p.last(fl.param) {
                    match raw.trim().parse::<i64>() {
                        Ok(id) if row_exists(s, table, id).await? => out.push((fl, vec![V::I(id)])),
                        _ => push_err((fl.param.to_string(), MSG_MODEL_CHOICE.into())),
                    }
                }
            }
            Shape::ModelChoiceIn(table) => {
                if let Some(raw) = p.last(fl.param) {
                    let mut ids = vec![];
                    for part in raw.split(',') {
                        match part.trim().parse::<i64>() {
                            Ok(id) if row_exists(s, table, id).await? => ids.push(id),
                            _ => push_err((fl.param.to_string(), MSG_MODEL_CHOICE.into())),
                        }
                    }
                    out.push((fl, vec![V::IL(ids)]));
                }
            }
            Shape::ModelMulti(table) => {
                let raws = p.all(fl.param);
                if !raws.is_empty() {
                    let mut ids = vec![];
                    for raw in raws {
                        match raw.trim().parse::<i64>() {
                            Ok(id) if row_exists(s, table, id).await? => ids.push(id),
                            _ => push_err((fl.param.to_string(), format!("Select a valid choice. {raw} is not one of the available choices."))),
                        }
                    }
                    out.push((fl, vec![V::IL(ids)]));
                }
            }
        }
    }
    if errors.is_empty() {
        Ok(out)
    } else {
        Err(ApiError {
            status: StatusCode::BAD_REQUEST,
            body: json!(errors),
        })
    }
}

async fn row_exists(s: &AppState, table: &str, id: i64) -> ApiResult<bool> {
    let q = format!("SELECT EXISTS (SELECT 1 FROM {table} WHERE id = $1)");
    sqlx::query_scalar(&q)
        .bind(id)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)
}

pub fn db_err(e: sqlx::Error) -> ApiError {
    exact_core::Error::Internal(e.to_string()).into()
}

// ---------------------------------------------------------------------------------------------------------
// listing
// ---------------------------------------------------------------------------------------------------------

pub struct Ctx<'a> {
    pub s: &'a AppState,
    pub viewer: Viewer,
    pub host: String,
    /// `/api/v2`: UTC timestamps and team-scoped processing data
    pub v2: bool,
}

/// v2 scopes the processing resources to the teams of the image they belong to (v1 shows them to everybody). v1 knows
/// image analyses only: registration plugins and their jobs belong to the new API.
pub fn effective_scope(spec: &Spec, v2: bool) -> String {
    if !spec.scope.is_empty() {
        return spec.scope.to_string();
    }
    if !v2 {
        return match spec.name {
            "Plugin" => "t.plugin_type = 1".to_string(),
            "PluginJob" => {
                "t.plugin_id IN (SELECT id FROM processing_plugin WHERE plugin_type = 1)"
                    .to_string()
            }
            _ => String::new(),
        };
    }
    let img = "t.image_id IN (SELECT i.id FROM images_image i WHERE i.image_set_id IN (SELECT s.id FROM images_imageset s WHERE s.team_id IN {VT}))";
    match spec.name {
        "PluginJob" | "PluginResult" => img.to_string(),
        "PluginResultEntry" => "t.pluginresult_id IN (SELECT r.id FROM processing_pluginresult r WHERE r.image_id IN (SELECT i.id FROM images_image i WHERE i.image_set_id IN (SELECT s.id FROM images_imageset s WHERE s.team_id IN {VT})))".to_string(),
        "PluginResultAnnotation" | "PluginResultBitmap" => "t.pluginresultentry_id IN (SELECT e.id FROM processing_pluginresultentry e JOIN processing_pluginresult r ON r.id = e.pluginresult_id WHERE r.image_id IN (SELECT i.id FROM images_image i WHERE i.image_set_id IN (SELECT s.id FROM images_imageset s WHERE s.team_id IN {VT})))".to_string(),
        _ => String::new(),
    }
}

pub fn where_clause(
    qb: &mut QueryBuilder<'_, Postgres>,
    scope: &str,
    filters: &[(&Flt, Vec<V>)],
    viewer: &Viewer,
    pk: Option<i64>,
) {
    qb.push(" WHERE TRUE");
    if !scope.is_empty() {
        qb.push(" AND (");
        push_tpl(qb, scope, &[], viewer);
        qb.push(")");
    }
    if let Some(pk) = pk {
        qb.push(" AND t.id = ").push_bind(pk);
    }
    for (fl, vals) in filters {
        qb.push(" AND (");
        push_tpl(qb, fl.sql, vals, viewer);
        qb.push(")");
    }
}

pub async fn list(
    ctx: &Ctx<'_>,
    spec: &Spec,
    pairs: &[(String, String)],
    flex: &Flex,
    limit: i64,
    offset: i64,
    pk: Option<i64>,
) -> ApiResult<(i64, Vec<Value>)> {
    let filters = parse_filters(ctx.s, spec, &Params { pairs }).await?;
    let mut c = QueryBuilder::new(format!("SELECT count(*) FROM {} t", spec.table));
    where_clause(
        &mut c,
        &effective_scope(spec, ctx.v2),
        &filters,
        &ctx.viewer,
        pk,
    );
    let count: i64 = c
        .build_query_scalar()
        .fetch_one(&ctx.s.pool)
        .await
        .map_err(db_err)?;
    let mut q = QueryBuilder::new(format!("SELECT to_jsonb(t) FROM {} t", spec.table));
    where_clause(
        &mut q,
        &effective_scope(spec, ctx.v2),
        &filters,
        &ctx.viewer,
        pk,
    );
    q.push(format!(" ORDER BY {} LIMIT ", spec.order))
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    let rows: Vec<Value> = q
        .build_query_scalar()
        .fetch_all(&ctx.s.pool)
        .await
        .map_err(db_err)?;
    let rows: Vec<Map<String, Value>> = rows
        .into_iter()
        .filter_map(|v| {
            if let Value::Object(m) = v {
                Some(m)
            } else {
                None
            }
        })
        .collect();
    Ok((count, serialize(ctx, spec, rows, Some(flex)).await?))
}

async fn fetch_by_ids(
    ctx: &Ctx<'_>,
    spec: &Spec,
    ids: &[i64],
) -> ApiResult<Vec<Map<String, Value>>> {
    let q = format!(
        "SELECT to_jsonb(t) FROM {} t WHERE t.id = ANY($1) ORDER BY t.id",
        spec.table
    );
    let rows: Vec<Value> = sqlx::query_scalar(&q)
        .bind(ids)
        .fetch_all(&ctx.s.pool)
        .await
        .map_err(db_err)?;
    Ok(rows
        .into_iter()
        .filter_map(|v| {
            if let Value::Object(m) = v {
                Some(m)
            } else {
                None
            }
        })
        .collect())
}

// ---------------------------------------------------------------------------------------------------------
// serialization
// ---------------------------------------------------------------------------------------------------------

fn row_id(r: &Map<String, Value>) -> i64 {
    r.get("id").and_then(Value::as_i64).unwrap_or(0)
}

async fn id_map(ctx: &Ctx<'_>, sql: &str, ids: &[i64]) -> ApiResult<HashMap<i64, Vec<i64>>> {
    let rows = sqlx::query(sql)
        .bind(ids)
        .fetch_all(&ctx.s.pool)
        .await
        .map_err(db_err)?;
    let mut m: HashMap<i64, Vec<i64>> = HashMap::new();
    for r in rows {
        let (a, b): (i64, i64) = (
            r.try_get::<i64, _>(0)
                .or_else(|_| r.try_get::<i32, _>(0).map(i64::from))
                .map_err(db_err)?,
            r.try_get::<i64, _>(1)
                .or_else(|_| r.try_get::<i32, _>(1).map(i64::from))
                .map_err(db_err)?,
        );
        m.entry(a).or_default().push(b);
    }
    Ok(m)
}

fn file_url(ctx: &Ctx<'_>, v: &Value) -> Value {
    match v.as_str() {
        Some(name) if !name.is_empty() => {
            const SAFE: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
                .remove(b'/')
                .remove(b'~')
                .remove(b'!')
                .remove(b'*')
                .remove(b'(')
                .remove(b')')
                .remove(b'\'')
                .remove(b'-')
                .remove(b'_')
                .remove(b'.');
            Value::String(format!(
                "http://{}/media/{}",
                ctx.host,
                percent_encoding::utf8_percent_encode(name, SAFE)
            ))
        }
        _ => Value::Null,
    }
}

pub async fn serialize(
    ctx: &Ctx<'_>,
    spec: &Spec,
    rows: Vec<Map<String, Value>>,
    flex: Option<&Flex>,
) -> ApiResult<Vec<Value>> {
    let ids: Vec<i64> = rows.iter().map(row_id).collect();
    let expands = |name: &str| flex.is_some_and(|f| f.expands(name));
    // relation id lists / expansions per field
    let mut related: HashMap<&'static str, HashMap<i64, Value>> = HashMap::new();
    let mut computed: HashMap<&'static str, HashMap<i64, Value>> = HashMap::new();
    for fld in spec.fields {
        // a field that `fields` / `omit` leave out costs nothing: no lookup of the (possibly huge) lists of related ids
        if flex.is_some_and(|f| !f.wants(fld.name)) {
            continue;
        }
        match fld.kind {
            K::M2m {
                target,
                through,
                left,
                right,
                expand,
            } => {
                let m = id_map(ctx, &format!("SELECT {left}, {right} FROM {through} WHERE {left} = ANY($1) ORDER BY {right}"), &ids).await?;
                related.insert(
                    fld.name,
                    expand_ids(ctx, m, target, expand && expands(fld.name)).await?,
                );
            }
            K::RevOne {
                target,
                table,
                col,
                expand,
            } => {
                let m = id_map(
                    ctx,
                    &format!("SELECT {col}, id FROM {table} WHERE {col} = ANY($1) ORDER BY id"),
                    &ids,
                )
                .await?;
                let one: HashMap<i64, Vec<i64>> = m;
                let rel = expand_ids(ctx, one, target, expand && expands(fld.name)).await?;
                // unwrap the single-element lists
                related.insert(
                    fld.name,
                    rel.into_iter()
                        .map(|(k, v)| {
                            (
                                k,
                                v.as_array()
                                    .and_then(|a| a.first().cloned())
                                    .unwrap_or(Value::Null),
                            )
                        })
                        .collect(),
                );
            }
            K::Rev {
                target,
                table,
                col,
                expand,
            } => {
                let m = id_map(
                    ctx,
                    &format!("SELECT {col}, id FROM {table} WHERE {col} = ANY($1) ORDER BY id"),
                    &ids,
                )
                .await?;
                related.insert(
                    fld.name,
                    expand_ids(ctx, m, target, expand && expands(fld.name)).await?,
                );
            }
            K::Fk { target, expand } if expand && expands(fld.name) => {
                let fk_ids: Vec<i64> = rows
                    .iter()
                    .filter_map(|r| r.get(fld.col).and_then(Value::as_i64))
                    .collect::<BTreeSet<_>>()
                    .into_iter()
                    .collect();
                let target_spec = super::specs::by_name(target);
                let trows = fetch_by_ids(ctx, target_spec, &fk_ids).await?;
                let tids: Vec<i64> = trows.iter().map(row_id).collect();
                let objs = Box::pin(serialize(ctx, target_spec, trows, None)).await?;
                related.insert(fld.name, tids.into_iter().zip(objs).collect());
            }
            K::Comp(c) => {
                computed.insert(fld.name, super::computed::batch(ctx, c, &rows).await?);
            }
            _ => {}
        }
    }
    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let id = row_id(r);
        let mut o = Map::new();
        for fld in spec.fields {
            if flex.is_some_and(|f| !f.wants(fld.name)) {
                continue;
            }
            let col = r.get(fld.col).cloned().unwrap_or(Value::Null);
            let v = match fld.kind {
                K::Id | K::Int | K::Bool | K::Json | K::Str | K::Uuid | K::Inet => col,
                K::Float => col.as_f64().map(Value::from).unwrap_or(col),
                K::Dt if ctx.v2 => col
                    .as_str()
                    .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                    .map(|d| {
                        Value::String(
                            d.with_timezone(&Utc)
                                .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true),
                        )
                    })
                    .unwrap_or(Value::Null),
                K::Dt => drf_datetime(
                    col.as_str()
                        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
                        .map(|d| d.with_timezone(&Utc)),
                    ctx.s.tz,
                ),
                K::File => file_url(ctx, &col),
                K::Fk { .. } => match related
                    .get(fld.name)
                    .and_then(|m| col.as_i64().and_then(|k| m.get(&k)))
                {
                    Some(obj) => obj.clone(),
                    None => col,
                },
                K::M2m { .. } | K::Rev { .. } => related
                    .get(fld.name)
                    .and_then(|m| m.get(&id))
                    .cloned()
                    .unwrap_or_else(|| json!([])),
                K::RevOne { .. } => related
                    .get(fld.name)
                    .and_then(|m| m.get(&id))
                    .cloned()
                    .unwrap_or(Value::Null),
                K::Comp(_) => computed
                    .get(fld.name)
                    .and_then(|m| m.get(&id))
                    .cloned()
                    .unwrap_or(Value::Null),
            };
            o.insert(fld.name.to_string(), v);
        }
        if let Some(fx) = flex {
            fx.apply(&mut o);
        }
        out.push(Value::Object(o));
    }
    Ok(out)
}

/// id lists per owner id; when `expand`, each id becomes the target's nested object.
async fn expand_ids(
    ctx: &Ctx<'_>,
    m: HashMap<i64, Vec<i64>>,
    target: &'static str,
    expand: bool,
) -> ApiResult<HashMap<i64, Value>> {
    if !expand {
        return Ok(m.into_iter().map(|(k, v)| (k, json!(v))).collect());
    }
    let all: Vec<i64> = m
        .values()
        .flatten()
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let target_spec = super::specs::by_name(target);
    let trows = fetch_by_ids(ctx, target_spec, &all).await?;
    let tids: Vec<i64> = trows.iter().map(row_id).collect();
    let objs = Box::pin(serialize(ctx, target_spec, trows, None)).await?;
    let by_id: HashMap<i64, Value> = tids.into_iter().zip(objs).collect();
    Ok(m.into_iter()
        .map(|(k, ids)| {
            (
                k,
                Value::Array(ids.iter().filter_map(|i| by_id.get(i).cloned()).collect()),
            )
        })
        .collect())
}

/// Serializes the rows with the given ids (unscoped), in the order of `ids`: what a serializer does for a queryset.
pub async fn serialize_ids(ctx: &Ctx<'_>, spec: &Spec, ids: &[i64]) -> ApiResult<Vec<Value>> {
    let rows = fetch_by_ids(ctx, spec, ids).await?;
    let by_id: HashMap<i64, usize> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| (row_id(r), i))
        .collect();
    let objs = serialize(ctx, spec, rows, None).await?;
    Ok(ids
        .iter()
        .filter_map(|i| by_id.get(i).map(|k| objs[*k].clone()))
        .collect())
}

// ---------------------------------------------------------------------------------------------------------
// v2 listing: keyset pagination on the primary key, snake_case keys
// ---------------------------------------------------------------------------------------------------------

pub fn snake(s: &str) -> String {
    let mut o = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_ascii_uppercase() {
            if i > 0 && !o.ends_with('_') {
                o.push('_');
            }
            o.push(c.to_ascii_lowercase());
        } else {
            o.push(c);
        }
    }
    o
}

pub fn snake_keys(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| (snake(&k), snake_keys(v)))
                .collect(),
        ),
        Value::Array(a) => Value::Array(a.into_iter().map(snake_keys).collect()),
        o => o,
    }
}

/// Maps snake_case names given by a v2 client back to the engine's field names.
pub fn flex_to_engine(spec: &Spec, flex: &mut Flex) {
    let fix = |set: &mut HashSet<String>| {
        *set = set
            .iter()
            .map(|n| {
                spec.fields
                    .iter()
                    .find(|f| snake(f.name) == *n)
                    .map_or(n.clone(), |f| f.name.to_string())
            })
            .collect();
    };
    fix(&mut flex.expand);
    fix(&mut flex.omit);
    if let Some(f) = flex.fields.as_mut() {
        fix(f);
    }
}

/// Items ordered by id after `after`, one page of `limit`; the bool is whether more rows follow.
#[allow(clippy::too_many_arguments)]
pub async fn list_v2(
    ctx: &Ctx<'_>,
    spec: &Spec,
    pairs: &[(String, String)],
    flex: &Flex,
    limit: i64,
    after: Option<i64>,
    pk: Option<i64>,
    with_count: bool,
) -> ApiResult<(Option<i64>, bool, Vec<Value>)> {
    let filters = parse_filters(ctx.s, spec, &Params { pairs }).await?;
    let scope = effective_scope(spec, true);
    let count = if with_count {
        let mut c = QueryBuilder::new(format!("SELECT count(*) FROM {} t", spec.table));
        where_clause(&mut c, &scope, &filters, &ctx.viewer, pk);
        Some(
            c.build_query_scalar::<i64>()
                .fetch_one(&ctx.s.pool)
                .await
                .map_err(db_err)?,
        )
    } else {
        None
    };
    let mut q = QueryBuilder::new(format!("SELECT to_jsonb(t) FROM {} t", spec.table));
    where_clause(&mut q, &scope, &filters, &ctx.viewer, pk);
    if let Some(a) = after {
        q.push(" AND t.id > ").push_bind(a);
    }
    q.push(" ORDER BY t.id LIMIT ").push_bind(limit + 1);
    let mut rows: Vec<Value> = q
        .build_query_scalar()
        .fetch_all(&ctx.s.pool)
        .await
        .map_err(db_err)?;
    let more = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    let rows: Vec<Map<String, Value>> = rows
        .into_iter()
        .filter_map(|v| {
            if let Value::Object(m) = v {
                Some(m)
            } else {
                None
            }
        })
        .collect();
    let items = serialize(ctx, spec, rows, Some(flex)).await?;
    Ok((count, more, items.into_iter().map(snake_keys).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    const BERLIN: chrono_tz::Tz = chrono_tz::Europe::Berlin;

    fn v(ty: T, s: &str) -> Option<V> {
        parse_one(ty, s, "p", BERLIN).unwrap()
    }

    #[test]
    fn numbers_accept_ints_and_decimals() {
        assert!(matches!(v(T::Num, "42"), Some(V::I(42))));
        assert!(matches!(v(T::Num, "1.5"), Some(V::F(x)) if x == 1.5));
        assert!(parse_one(T::Num, "abc", "id", BERLIN).is_err());
        assert!(parse_one(T::Num, "nan", "id", BERLIN).is_err());
    }

    #[test]
    fn boolean_widgets_differ() {
        assert!(matches!(v(T::Bool, "TRUE"), Some(V::B(true))));
        assert!(matches!(v(T::Bool, "0"), Some(V::B(false))));
        assert!(v(T::Bool, "maybe").is_none());
        assert!(
            v(T::NullBool, "1").is_none(),
            "NullBooleanSelect does not know 1"
        );
        assert!(matches!(v(T::NullBool, "3"), Some(V::B(false))));
    }

    #[test]
    fn naive_datetimes_are_berlin_time() {
        let Some(V::Dt(d)) = v(T::Dt, "2026-07-01 12:00:00") else {
            panic!()
        };
        assert_eq!(d.to_rfc3339(), "2026-07-01T10:00:00+00:00"); // CEST = UTC+2
        let Some(V::Dt(d)) = v(T::IsoDt, "2026-07-01T12:00:00+00:00") else {
            panic!()
        };
        assert_eq!(d.to_rfc3339(), "2026-07-01T12:00:00+00:00");
        let Some(V::Dt(d)) = v(T::Dt, "2026-01-01") else {
            panic!()
        };
        assert_eq!(d.to_rfc3339(), "2025-12-31T23:00:00+00:00");
        assert!(parse_one(T::Dt, "yesterday", "time", BERLIN).is_err());
    }

    #[test]
    fn choices_are_validated() {
        assert!(matches!(v(T::Choice(&[0, 1, 2]), "1"), Some(V::I(1))));
        let e = parse_one(T::Choice(&[0, 1, 2]), "7", "image_type", BERLIN).unwrap_err();
        assert_eq!(
            e.1,
            "Select a valid choice. 7 is not one of the available choices."
        );
    }

    #[test]
    fn templates_bind_values_and_viewer_teams() {
        let viewer = Viewer {
            id: 7,
            token_teams: Some(vec![1, 2]),
        };
        let mut qb = QueryBuilder::new("SELECT 1 WHERE ");
        push_tpl(
            &mut qb,
            "a = {} AND t.team_id IN {VT} AND b = ANY({})",
            &[V::I(5), V::IL(vec![1, 2])],
            &viewer,
        );
        let sql = qb.sql().to_string();
        assert_eq!(sql, "SELECT 1 WHERE a = $1 AND t.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $2 AND team_id = ANY($3)) AND b = ANY($4)");
    }

    #[test]
    fn every_spec_is_consistent() {
        // every relation target exists and every route resolves (by_name panics on unknown names)
        for (_, _, name) in super::super::specs::ROUTES {
            let spec = super::super::specs::by_name(name);
            for fld in spec.fields {
                match fld.kind {
                    K::Fk { target, .. }
                    | K::M2m { target, .. }
                    | K::Rev { target, .. }
                    | K::RevOne { target, .. } => {
                        super::super::specs::by_name(target);
                    }
                    _ => {}
                }
            }
            assert!(spec.fields.iter().all(|f| !f.name.is_empty()));
        }
    }
}
