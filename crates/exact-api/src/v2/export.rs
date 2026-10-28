//! Annotation exports as EXACT's "export formats" define them: a text template per annotation (and per vector point, per image)
//! with `%%placeholders`, filled for every annotation of an image set. The result is stored as an `Export` (like Django does) and
//! downloaded as a text file.
//!
//! - `GET /api/v2/image-sets/{id}/export-formats`: formats of the user's teams and the public ones
//! - `GET|POST /api/v2/image-sets/{id}/exports`: list, create (`{"format": id}`, needs `create_export`)
//! - `GET /api/v2/exports/{id}/download`, `DELETE /api/v2/exports/{id}` (needs `delete_export`)
//! - `POST /api/v2/export-formats`, `DELETE /api/v2/export-formats/{id}`: members of the format's team
//!
//! The rendering follows `annotations/views.py: export_format` placeholder by placeholder, including its number formatting
//! (Python `str` of ints and floats) and its quirks.

use crate::{
    auth::{authenticate, require_user},
    compat::{
        engine::db_err,
        perms::{perms, set_row},
    },
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get},
    Json, Router,
};
use chrono::{DateTime, Timelike, Utc};
use serde_json::{json, Map, Value};
use sqlx::Row;

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/image-sets/{id}/export-formats", get(formats_h))
        .route(
            "/api/v2/image-sets/{id}/exports",
            get(exports_h).post(create_h),
        )
        .route("/api/v2/exports/{id}/download", get(download_h))
        .route("/api/v2/exports/{id}", delete(delete_h))
        .route(
            "/api/v2/export-formats",
            axum::routing::post(format_create_h),
        )
        .route(
            "/api/v2/export-formats/{id}",
            get(format_get_h)
                .patch(format_patch_h)
                .delete(format_delete_h),
        )
}

// ---------------------------------------------------------------------------------------------------------
// Python formatting
// ---------------------------------------------------------------------------------------------------------

/// A number the way Python holds it: an int stays an int through `+ -`, `/` gives a float.
#[derive(Clone, Copy, Debug)]
pub enum N {
    I(i64),
    F(f64),
}

impl N {
    fn f(self) -> f64 {
        match self {
            N::I(i) => i as f64,
            N::F(f) => f,
        }
    }
    fn sub(self, o: N) -> N {
        match (self, o) {
            (N::I(a), N::I(b)) => N::I(a - b),
            (a, b) => N::F(a.f() - b.f()),
        }
    }
    fn add(self, o: N) -> N {
        match (self, o) {
            (N::I(a), N::I(b)) => N::I(a + b),
            (a, b) => N::F(a.f() + b.f()),
        }
    }
    fn div(self, d: f64) -> f64 {
        self.f() / d
    }
    pub fn py(self) -> String {
        match self {
            N::I(i) => i.to_string(),
            N::F(f) => py_float(f),
        }
    }
}

/// `str(float)` of Python (`repr`: the shortest round-trip digits, scientific below 1e-4 and from 1e16).
pub fn py_float(f: f64) -> String {
    if f.is_nan() {
        return "nan".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "inf" } else { "-inf" }.into();
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0.0" } else { "0.0" }.into();
    }
    let sci = format!("{:e}", f.abs());
    let (mant, exp) = sci.split_once('e').unwrap_or((&sci, "0"));
    let exp: i32 = exp.parse().unwrap_or(0);
    let digits: String = mant.chars().filter(|c| *c != '.').collect();
    let sign = if f < 0.0 { "-" } else { "" };
    if (-4..16).contains(&exp) {
        let body = if exp >= 0 {
            let int_len = exp as usize + 1;
            if digits.len() <= int_len {
                format!("{}{}.0", digits, "0".repeat(int_len - digits.len()))
            } else {
                format!("{}.{}", &digits[..int_len], &digits[int_len..])
            }
        } else {
            format!("0.{}{}", "0".repeat((-exp - 1) as usize), digits)
        };
        format!("{sign}{body}")
    } else {
        let m = if digits.len() > 1 {
            format!("{}.{}", &digits[..1], &digits[1..])
        } else {
            digits
        };
        format!(
            "{sign}{m}e{}{:02}",
            if exp < 0 { '-' } else { '+' },
            exp.abs()
        )
    }
}

fn py_str_repr(t: &str) -> String {
    let q = if t.contains('\'') && !t.contains('"') {
        '"'
    } else {
        '\''
    };
    let mut o = String::from(q);
    for c in t.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if c == q => {
                o.push('\\');
                o.push(c);
            }
            c => o.push(c),
        }
    }
    o.push(q);
    o
}

/// `repr` of the Python object a JSON value loads as (`str(dict)`, which `%%meta_data` gives).
pub fn py_repr(v: &Value) -> String {
    match v {
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        Value::Number(n) => match n.as_i64() {
            Some(i) => i.to_string(),
            None => py_float(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(t) => py_str_repr(t),
        Value::Array(a) => format!("[{}]", a.iter().map(py_repr).collect::<Vec<_>>().join(", ")),
        Value::Object(m) => format!(
            "{{{}}}",
            m.iter()
                .map(|(k, v)| format!("{}: {}", py_str_repr(k), py_repr(v)))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// `str(datetime)` of an aware UTC datetime.
fn py_time(t: DateTime<Utc>) -> String {
    let base = t.format("%Y-%m-%d %H:%M:%S").to_string();
    let micros = t.nanosecond() / 1000;
    if micros == 0 {
        format!("{base}+00:00")
    } else {
        format!("{base}.{micros:06}+00:00")
    }
}

// ---------------------------------------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------------------------------------

pub struct Format {
    pub name_format: String,
    pub base_format: String,
    pub image_format: Option<String>,
    pub annotation_format: String,
    pub vector_format: String,
    pub not_in_image_format: String,
    pub image_aggregation: bool,
    pub include_blurred: bool,
    pub include_concealed: bool,
}

pub struct SetInfo {
    pub name: String,
    pub team: String,
    pub location: Option<String>,
    pub description: Option<String>,
}

pub struct Img {
    pub id: i64,
    pub name: String,
    pub width: i64,
    pub height: i64,
    /// `[name|user|time|action]` lines of the views of the image
    pub log: String,
}

pub struct Ann {
    pub image: i64,
    pub type_name: String,
    pub vector_type: i32,
    pub vector: Map<String, Value>,
    pub blurred: bool,
    pub concealed: bool,
    pub deleted: bool,
    pub time: DateTime<Utc>,
    pub last_edit_time: DateTime<Utc>,
    pub user: String,
    pub last_editor: Option<String>,
    pub uuid: String,
    pub meta: Value,
}

fn replace_all(mut text: String, pairs: &[(&str, String)], fix_braces: bool) -> String {
    for (k, v) in pairs {
        text = text.replace(k, v);
        if fix_braces {
            text = text.replace(",}", "}");
        }
    }
    text
}

/// `%%ifblurred ... %%endif`: the part is kept (without the markers) or removed.
fn apply_conditional(mut s: String, marker: &str, keep: bool) -> String {
    while let Some(start) = s.find(marker) {
        let after = start + marker.len();
        let end = s[after..]
            .find("%%endif")
            .map(|e| after + e)
            .unwrap_or(s.len());
        let inner = s[after..end].to_string();
        let whole_end = (end + "%%endif".len()).min(s.len());
        let whole = s[start..whole_end].to_string();
        // Python replaces every occurrence of the found text
        s = s.replace(&whole, if keep { &inner } else { "" });
        if !keep && !s.contains(marker) {
            break;
        }
    }
    s
}

struct Geo<'a> {
    a: &'a Ann,
    w: i64,
    h: i64,
}

impl Geo<'_> {
    fn nums(&self, axis: char) -> Vec<N> {
        self.a
            .vector
            .iter()
            .filter(|(k, _)| k.starts_with(axis))
            .filter_map(|(_, v)| match v {
                Value::Number(n) => Some(
                    n.as_i64()
                        .map(N::I)
                        .unwrap_or(N::F(n.as_f64().unwrap_or(0.0))),
                ),
                _ => None,
            })
            .collect()
    }
    fn min(&self, axis: char, init: i64) -> N {
        self.nums(axis)
            .into_iter()
            .fold(N::I(init), |m, v| if v.f() < m.f() { v } else { m })
    }
    fn max(&self, axis: char) -> N {
        self.nums(axis)
            .into_iter()
            .fold(N::I(-1), |m, v| if v.f() > m.f() { v } else { m })
    }
    fn get(&self, k: &str) -> Option<N> {
        match self.a.vector.get(k)? {
            Value::Number(n) => Some(n.as_i64().map(N::I).unwrap_or(N::F(n.as_f64()?))),
            _ => None,
        }
    }
    fn extent(&self, axis: char, init: i64) -> N {
        let (k1, k2) = (format!("{axis}1"), format!("{axis}2"));
        let len = self.a.vector.len();
        if len == 4 && self.get(&k2).is_some() && self.get(&k1).is_some() {
            self.get(&k2)
                .unwrap_or(N::I(0))
                .sub(self.get(&k1).unwrap_or(N::I(0)))
        } else if len > 4 {
            let d = self.max(axis).sub(self.min(axis, init));
            if d.f() > 0.0 {
                d
            } else {
                N::I(0)
            }
        } else {
            N::I(0)
        }
    }
    fn width(&self) -> N {
        self.extent('x', self.w)
    }
    fn height(&self) -> N {
        self.extent('y', self.h)
    }
    fn diameter(&self) -> N {
        if matches!(self.a.vector_type, 1 | 5) {
            N::F(self.height().add(self.width()).div(2.0))
        } else {
            N::I(0)
        }
    }
    fn radius(&self) -> f64 {
        self.diameter().div(2.0)
    }
    fn center(&self) -> (N, N) {
        match self.a.vector_type {
            1 | 3 | 5 => (
                self.min('x', self.w).add(N::F(self.width().div(2.0))),
                self.min('y', self.h).add(N::F(self.height().div(2.0))),
            ),
            2 => (
                self.get("x1").unwrap_or(N::I(0)),
                self.get("y1").unwrap_or(N::I(0)),
            ),
            _ => (N::I(0), N::I(0)),
        }
    }
    fn rel_radius(&self) -> f64 {
        (self.radius() / self.h as f64 + self.radius() / self.w as f64) / 2.0
    }
}

fn frame_of(a: &Ann) -> String {
    a.vector
        .get("frame")
        .map(py_repr)
        .unwrap_or_else(|| "1".into())
}

fn render_annotation(f: &Format, set: &SetInfo, img: &Img, a: &Ann) -> String {
    if a.vector.is_empty() {
        return replace_all(
            f.not_in_image_format.clone(),
            &[
                ("%%imageset", set.name.clone()),
                ("%%imagewidth", img.width.to_string()),
                ("%%imageheight", img.height.to_string()),
                ("%%imagename", img.name.clone()),
                ("%%type", a.type_name.clone()),
            ],
            true,
        );
    }
    let g = Geo {
        a,
        w: img.width,
        h: img.height,
    };
    let (w, h) = (img.width as f64, img.height as f64);
    let rel = |n: N, d: f64| n.div(d).pipe(py_float);
    let mut vector = String::new();
    for i in 1..=(a.vector.len() / 2) {
        let (kx, ky) = (format!("x{i}"), format!("y{i}"));
        let (Some(x), Some(y)) = (g.get(&kx), g.get(&ky)) else {
            continue;
        };
        vector.push_str(&replace_all(
            f.vector_format.clone(),
            &[
                ("%%count0", (i - 1).to_string()),
                ("%%count1", i.to_string()),
                ("%%x", x.py()),
                ("%%relx", rel(x, w)),
                ("%%y", y.py()),
                ("%%rely", rel(y, h)),
                ("%%br", "\n".into()),
            ],
            false,
        ));
    }
    let mut text = f.annotation_format.clone();
    text = apply_conditional(text, "%%ifblurred", a.blurred);
    text = apply_conditional(text, "%%ifnotblurred", !a.blurred);
    text = apply_conditional(text, "%%ifconcealed", a.concealed);
    text = apply_conditional(text, "%%ifnotconcealed", !a.concealed);
    let (cx, cy) = g.center();
    let (minx, maxx, miny, maxy) = (
        g.min('x', img.width),
        g.max('x'),
        g.min('y', img.height),
        g.max('y'),
    );
    let rr = g.rel_radius();
    let pairs: Vec<(&str, String)> = vec![
        ("%%imageset", set.name.clone()),
        ("%%imagewidth", img.width.to_string()),
        ("%%imageheight", img.height.to_string()),
        ("%%imagename", img.name.clone()),
        ("%%type", a.type_name.clone()),
        ("%%vector", vector),
        ("%%frame", frame_of(a)),
        ("%%first_editor", a.user.clone()),
        ("%%first_timepoint", py_time(a.time)),
        (
            "%%last_editor",
            a.last_editor.clone().unwrap_or_else(|| "-1".into()),
        ),
        ("%%last_timepoint", py_time(a.last_edit_time)),
        ("%%UUID", a.uuid.clone()),
        ("%%meta_data", py_repr(&a.meta)),
        ("%%deleted", if a.deleted { "True" } else { "False" }.into()),
        ("%%rad", py_float(g.radius())),
        ("%%dia", g.diameter().py()),
        ("%%cx", cx.py()),
        ("%%cy", cy.py()),
        ("%%minx", minx.py()),
        ("%%maxx", maxx.py()),
        ("%%miny", miny.py()),
        ("%%maxy", maxy.py()),
        ("%%width", g.width().py()),
        ("%%height", g.height().py()),
        ("%%relrad", py_float(rr)),
        ("%%reldia", py_float(rr * 2.0)),
        ("%%relcx", rel(cx, w)),
        ("%%relcy", rel(cy, h)),
        ("%%relminx", rel(minx, w)),
        ("%%relmaxx", rel(maxx, w)),
        ("%%relminy", rel(miny, h)),
        ("%%relmaxy", rel(maxy, h)),
        ("%%relwidth", rel(g.width(), w)),
        ("%%relheight", rel(g.height(), h)),
    ];
    replace_all(text, &pairs, true)
}

trait Pipe: Sized {
    fn pipe<R>(self, f: impl FnOnce(Self) -> R) -> R {
        f(self)
    }
}
impl<T> Pipe for T {}

/// `(text, annotation count, file name)`; the file name still holds `%%exportid`. `annotations` are the annotations of the
/// format's types that passed the filters, `images` all images of the set, both in id order.
pub fn render(
    f: &Format,
    set: &SetInfo,
    images: &[Img],
    annotations: &[Ann],
) -> (String, i32, String) {
    let mut file_name = f.name_format.clone();
    for (k, v) in [
        ("%%imageset", set.name.clone()),
        ("%%team", set.team.clone()),
        (
            "%%setlocation",
            set.location.clone().unwrap_or_else(|| "None".into()),
        ),
    ] {
        file_name = file_name.replace(k, &v);
    }
    let view_log: String = images.iter().map(|i| i.log.as_str()).collect();
    let mut count = 0;
    let content = if f.image_aggregation {
        let mut out = String::from("\n");
        for img in images {
            let mine: Vec<&Ann> = annotations.iter().filter(|a| a.image == img.id).collect();
            if mine.is_empty() {
                continue;
            }
            let mut body = String::new();
            for a in &mine {
                count += 1;
                body.push_str(&render_annotation(f, set, img, a));
                body.push('\n');
            }
            let last = mine
                .last()
                .map(|a| frame_of(a))
                .unwrap_or_else(|| "1".into());
            out.push_str(&replace_all(
                f.image_format.clone().unwrap_or_default(),
                &[
                    ("%%imageset", set.name.clone()),
                    ("%%imagewidth", img.width.to_string()),
                    ("%%imageheight", img.height.to_string()),
                    ("%%imagename", img.name.clone()),
                    ("%%annotations", body),
                    ("%%annoamount", mine.len().to_string()),
                    ("%%frame", last),
                ],
                false,
            ));
            out.push('\n');
        }
        out
    } else {
        let mut out = String::from("\n");
        for a in annotations {
            let Some(img) = images.iter().find(|i| i.id == a.image) else {
                continue;
            };
            count += 1;
            out.push_str(&render_annotation(f, set, img, a));
            out.push('\n');
        }
        out
    };
    let text = replace_all(
        f.base_format.clone(),
        &[
            ("%%view", view_log),
            ("%%content", content),
            ("%%imageset", set.name.clone()),
            (
                "%%setdescription",
                set.description.clone().unwrap_or_else(|| "None".into()),
            ),
            ("%%team", set.team.clone()),
            (
                "%%setlocation",
                set.location.clone().unwrap_or_else(|| "None".into()),
            ),
        ],
        false,
    );
    (text, count, file_name)
}

// ---------------------------------------------------------------------------------------------------------
// database
// ---------------------------------------------------------------------------------------------------------

fn field_err(field: &str, msg: &str) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({"detail": "Validation failed.", "errors": {field: [msg]}}),
    }
}

fn not_found() -> ApiError {
    ApiError::not_found("Not found.")
}

async fn set_perms(
    s: &AppState,
    headers: &HeaderMap,
    method: Method,
    set: i64,
) -> ApiResult<(crate::auth::Principal, crate::compat::perms::Perms)> {
    let p = require_user(authenticate(s, headers, &method).await?)?;
    let row = set_row(s, set).await?.ok_or_else(not_found)?;
    let pm = perms(s, &p, &row).await?;
    if !pm.read {
        return Err(not_found());
    }
    Ok((p, pm))
}

async fn formats_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(set): Path<i64>,
) -> ApiResult<Response> {
    let (p, _) = set_perms(&s, &headers, Method::GET, set).await?;
    let rows = sqlx::query(
        "SELECT f.id, f.name, f.team_id, f.public, f.image_aggregation FROM annotations_exportformat f \
         WHERE f.public OR f.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $1) ORDER BY f.name",
    )
    .bind(p.user.id)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| json!({"id": r.get::<i64,_>(0), "name": r.get::<String,_>(1), "team": r.get::<i64,_>(2), "public": r.get::<bool,_>(3), "image_aggregation": r.get::<bool,_>(4)}))
        .collect();
    Ok(Json(json!({ "items": items })).into_response())
}

async fn exports_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(set): Path<i64>,
) -> ApiResult<Response> {
    set_perms(&s, &headers, Method::GET, set).await?;
    let rows = sqlx::query(
        "SELECT e.id, e.time, e.annotation_count, e.filename, u.username, f.name, \
                (f.id IS NULL OR e.time < f.last_change_time) \
         FROM annotations_export e LEFT JOIN users_user u ON u.id = e.user_id LEFT JOIN annotations_exportformat f ON f.id = e.format_id \
         WHERE e.image_set_id = $1 ORDER BY e.id DESC",
    )
    .bind(set)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let items: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({"id": r.get::<i64,_>(0), "time": r.get::<DateTime<Utc>,_>(1), "annotation_count": r.get::<i32,_>(2),
                   "filename": r.get::<String,_>(3), "user": r.get::<Option<String>,_>(4), "format": r.get::<Option<String>,_>(5),
                   "deprecated": r.get::<bool,_>(6)})
        })
        .collect();
    Ok(Json(json!({ "items": items })).into_response())
}

async fn load_format(s: &AppState, id: i64) -> ApiResult<(Format, Vec<i64>)> {
    let r = sqlx::query(
        "SELECT name_format, base_format, image_format, annotation_format, vector_format, not_in_image_format, image_aggregation, include_blurred, include_concealed \
         FROM annotations_exportformat WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("No ExportFormat matches the given query."))?;
    let types: Vec<i64> = sqlx::query_scalar("SELECT annotationtype_id FROM annotations_exportformat_annotations_types WHERE exportformat_id = $1")
        .bind(id)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    Ok((
        Format {
            name_format: r.get(0),
            base_format: r.get(1),
            image_format: r.get(2),
            annotation_format: r.get(3),
            vector_format: r.get(4),
            not_in_image_format: r.get(5),
            image_aggregation: r.get(6),
            include_blurred: r.get(7),
            include_concealed: r.get(8),
        },
        types,
    ))
}

pub async fn build(s: &AppState, set: i64, format: i64) -> ApiResult<(String, i32, String)> {
    let (f, types) = load_format(s, format).await?;
    let info = sqlx::query("SELECT i.name, t.name, i.location, i.description FROM images_imageset i JOIN users_team t ON t.id = i.team_id WHERE i.id = $1")
        .bind(set)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(not_found)?;
    let info = SetInfo {
        name: info.get(0),
        team: info.get(1),
        location: info.get(2),
        description: info.get(3),
    };
    let mut images: Vec<Img> = sqlx::query(
        "SELECT id, name, width, height FROM images_image WHERE image_set_id = $1 ORDER BY id",
    )
    .bind(set)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?
    .iter()
    .map(|r| Img {
        id: r.get(0),
        name: r.get(1),
        width: r.get::<i32, _>(2) as i64,
        height: r.get::<i32, _>(3) as i64,
        log: String::new(),
    })
    .collect();
    let logs = sqlx::query(
        "SELECT l.image_id, i.name, u.username, l.time, l.action FROM annotations_logimageaction l \
         JOIN images_image i ON i.id = l.image_id LEFT JOIN users_user u ON u.id = l.user_id WHERE i.image_set_id = $1 ORDER BY l.id",
    )
    .bind(set)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    for r in &logs {
        let id: i64 = r.get(0);
        if let Some(img) = images.iter_mut().find(|i| i.id == id) {
            let user = r
                .get::<Option<String>, _>(2)
                .unwrap_or_else(|| "None".into());
            img.log.push_str(&format!(
                "[{}|{}|{}|{}]\n",
                r.get::<String, _>(1),
                user,
                py_time(r.get(3)),
                r.get::<i32, _>(4)
            ));
        }
    }
    let mut sql = String::from(
        "SELECT a.image_id, t.name, t.vector_type, a.vector, a._blurred AND t.enable_blurred, a._concealed AND t.enable_concealed, a.deleted, a.time, a.last_edit_time, \
                u.username, le.username, a.unique_identifier::text, a.meta_data, a.vector IS NULL \
         FROM annotations_annotation a JOIN annotations_annotationtype t ON t.id = a.annotation_type_id \
         JOIN images_image i ON i.id = a.image_id LEFT JOIN users_user u ON u.id = a.user_id LEFT JOIN users_user le ON le.id = a.last_editor_id \
         WHERE i.image_set_id = $1 AND a.annotation_type_id = ANY($2)",
    );
    if !f.annotation_format.contains("deleted") {
        sql.push_str(" AND NOT a.deleted");
    }
    if !f.include_blurred {
        sql.push_str(" AND NOT a._blurred");
    }
    if !f.include_concealed {
        sql.push_str(" AND NOT a._concealed");
    }
    sql.push_str(" ORDER BY a.id");
    let anns: Vec<Ann> = sqlx::query(&sql)
        .bind(set)
        .bind(&types)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?
        .iter()
        .map(|r| {
            let vector = match r.get::<Option<Value>, _>(3) {
                Some(Value::Object(m)) => m,
                _ => Map::new(),
            };
            let none = vector.is_empty();
            Ann {
                image: r.get(0),
                type_name: r.get(1),
                vector_type: r.get(2),
                blurred: r.get::<bool, _>(4) && !none,
                concealed: r.get::<bool, _>(5) && !none,
                vector,
                deleted: r.get(6),
                time: r.get(7),
                last_edit_time: r.get(8),
                user: r
                    .get::<Option<String>, _>(9)
                    .unwrap_or_else(|| "None".into()),
                last_editor: r.get(10),
                uuid: r.get(11),
                meta: r.get::<Option<Value>, _>(12).unwrap_or(Value::Null),
            }
        })
        .collect();
    Ok(render(&f, &info, &images, &anns))
}

async fn create_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(set): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let (p, pm) = set_perms(&s, &headers, Method::POST, set).await?;
    if !pm.create_export {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for creating exports missing.",
        ));
    }
    let format = serde_json::from_slice::<Value>(&body)
        .ok()
        .and_then(|v| v.get("format").and_then(Value::as_i64))
        .ok_or_else(|| field_err("format", "An integer id is required."))?;
    let usable: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM annotations_exportformat f WHERE f.id = $2 AND (f.public OR f.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $1)))",
    )
    .bind(p.user.id)
    .bind(format)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if !usable {
        return Err(field_err("format", "No such export format."));
    }
    let (text, count, name) = build(&s, set, format).await?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO annotations_export (time, annotation_count, export_text, image_set_id, user_id, format_id, filename) VALUES (now(), $1, $2, $3, $4, $5, '') RETURNING id",
    )
    .bind(count)
    .bind(&text)
    .bind(set)
    .bind(p.user.id)
    .bind(format)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    let filename = name.replace("%%exportid", &id.to_string());
    sqlx::query("UPDATE annotations_export SET filename = $2 WHERE id = $1")
        .bind(id)
        .bind(&filename)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"id": id, "filename": filename, "annotation_count": count})),
    )
        .into_response())
}

async fn export_set(s: &AppState, id: i64) -> ApiResult<(i64, String)> {
    sqlx::query("SELECT image_set_id, filename FROM annotations_export WHERE id = $1")
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .map(|r| (r.get(0), r.get(1)))
        .ok_or_else(not_found)
}

async fn download_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let (set, filename) = export_set(&s, id).await?;
    set_perms(&s, &headers, Method::GET, set).await?;
    let text: String =
        sqlx::query_scalar("SELECT export_text FROM annotations_export WHERE id = $1")
            .bind(id)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
    let safe = filename.replace(['"', '\r', '\n'], "_");
    Ok((
        [
            (header::CONTENT_TYPE, "text/plain".to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{safe}\""),
            ),
        ],
        text,
    )
        .into_response())
}

async fn delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let (set, _) = export_set(&s, id).await?;
    let (_, pm) = set_perms(&s, &headers, Method::DELETE, set).await?;
    if !pm.delete_export {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for deleting exports missing.",
        ));
    }
    sqlx::query("DELETE FROM annotations_export WHERE id = $1")
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn member_of(s: &AppState, user: i64, team: i64) -> ApiResult<bool> {
    sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users_teammembership WHERE team_id = $1 AND user_id = $2)",
    )
    .bind(team)
    .bind(user)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)
}

/// `{"name", "team", "annotation_types": [ids], optional: public, base_format, image_format, annotation_format, vector_format,
/// not_in_image_format, name_format, image_aggregation, include_blurred, include_concealed}`.
async fn format_create_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(m)) => m,
        _ => {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "Expected a JSON object.",
            ))
        }
    };
    let text = |k: &str, default: &str| {
        d.get(k)
            .and_then(Value::as_str)
            .unwrap_or(default)
            .to_string()
    };
    let flag = |k: &str, default: bool| d.get(k).and_then(Value::as_bool).unwrap_or(default);
    let name = text("name", "");
    if name.is_empty() || name.chars().count() > 20 {
        return Err(field_err(
            "name",
            "A name of 1 to 20 characters is required.",
        ));
    }
    let team = d
        .get("team")
        .and_then(Value::as_i64)
        .ok_or_else(|| field_err("team", "An integer id is required."))?;
    if !member_of(&s, p.user.id, team).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for managing export formats missing.",
        ));
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM annotations_exportformat WHERE name = $1)",
    )
    .bind(&name)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if taken {
        return Err(field_err(
            "name",
            "The name is already in use by an export format.",
        ));
    }
    let types: Vec<i64> = d
        .get("annotation_types")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default();
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO annotations_exportformat (name, public, base_format, annotation_format, team_id, not_in_image_format, min_verifications, image_aggregation, image_format, name_format, vector_format, last_change_time, include_blurred, include_concealed) \
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $8, $9, $10, now(), $11, $12) RETURNING id",
    )
    .bind(&name)
    .bind(flag("public", false))
    .bind(text("base_format", "%%content"))
    .bind(text("annotation_format", "%%imagename|%%type|{%%vector}|"))
    .bind(team)
    .bind(text("not_in_image_format", "image name|annotation type|not in image"))
    .bind(flag("image_aggregation", false))
    .bind(d.get("image_format").and_then(Value::as_str))
    .bind(text("name_format", "export_%%exportid.txt"))
    .bind(text("vector_format", r#""x%%count1": %%x,"y%%count1": %%y,"#))
    .bind(flag("include_blurred", true))
    .bind(flag("include_concealed", true))
    .fetch_one(&mut *tx)
    .await
    .map_err(db_err)?;
    for t in types {
        sqlx::query("INSERT INTO annotations_exportformat_annotations_types (exportformat_id, annotationtype_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
            .bind(id)
            .bind(t)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok((StatusCode::CREATED, Json(json!({"id": id, "name": name}))).into_response())
}

const TEXT_FIELDS: [&str; 6] = [
    "base_format",
    "image_format",
    "annotation_format",
    "vector_format",
    "not_in_image_format",
    "name_format",
];

async fn format_json(s: &AppState, id: i64) -> ApiResult<Value> {
    let r = sqlx::query(
        "SELECT id, name, team_id, public, image_aggregation, include_blurred, include_concealed, base_format, image_format, annotation_format, vector_format, not_in_image_format, name_format \
         FROM annotations_exportformat WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(not_found)?;
    let types: Vec<i64> = sqlx::query_scalar("SELECT annotationtype_id FROM annotations_exportformat_annotations_types WHERE exportformat_id = $1 ORDER BY 1")
        .bind(id)
        .fetch_all(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(json!({
        "id": r.get::<i64,_>(0), "name": r.get::<String,_>(1), "team": r.get::<i64,_>(2), "public": r.get::<bool,_>(3),
        "image_aggregation": r.get::<bool,_>(4), "include_blurred": r.get::<bool,_>(5), "include_concealed": r.get::<bool,_>(6),
        "base_format": r.get::<String,_>(7), "image_format": r.get::<Option<String>,_>(8), "annotation_format": r.get::<String,_>(9),
        "vector_format": r.get::<String,_>(10), "not_in_image_format": r.get::<String,_>(11), "name_format": r.get::<String,_>(12),
        "annotation_types": types,
    }))
}

/// `GET /api/v2/export-formats/{id}`: public formats and those of the user's teams.
async fn format_get_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let f = format_json(&s, id).await?;
    let team = f["team"].as_i64().unwrap_or(0);
    if !f["public"].as_bool().unwrap_or(false) && !member_of(&s, p.user.id, team).await? {
        return Err(not_found());
    }
    Ok(Json(f).into_response())
}

/// `PATCH /api/v2/export-formats/{id}`: any of the fields of the creation (members of the team; a new `team` needs membership too).
async fn format_patch_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PATCH).await?)?;
    let cur = format_json(&s, id).await?;
    if !member_of(&s, p.user.id, cur["team"].as_i64().unwrap_or(0)).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for managing export formats missing.",
        ));
    }
    let d = match serde_json::from_slice::<Value>(&body) {
        Ok(Value::Object(m)) => m,
        _ => {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "Expected a JSON object.",
            ))
        }
    };
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    if let Some(v) = d.get("name") {
        let name = v.as_str().unwrap_or("");
        if name.is_empty() || name.chars().count() > 20 {
            return Err(field_err(
                "name",
                "A name of 1 to 20 characters is required.",
            ));
        }
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM annotations_exportformat WHERE name = $1 AND id <> $2)",
        )
        .bind(name)
        .bind(id)
        .fetch_one(&mut *tx)
        .await
        .map_err(db_err)?;
        if taken {
            return Err(field_err(
                "name",
                "The name is already in use by an export format.",
            ));
        }
        sqlx::query("UPDATE annotations_exportformat SET name = $2 WHERE id = $1")
            .bind(id)
            .bind(name)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    if let Some(team) = d.get("team").and_then(Value::as_i64) {
        if !member_of(&s, p.user.id, team).await? {
            return Err(ApiError::detail(
                StatusCode::FORBIDDEN,
                "permission for managing export formats missing.",
            ));
        }
        sqlx::query("UPDATE annotations_exportformat SET team_id = $2 WHERE id = $1")
            .bind(id)
            .bind(team)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    for k in TEXT_FIELDS {
        if let Some(v) = d.get(k) {
            let t = match v {
                Value::String(t) => Some(t.as_str()),
                Value::Null if k == "image_format" => None,
                _ => return Err(field_err(k, "A text is required.")),
            };
            // the column names are the fixed ones above
            sqlx::query(&format!(
                "UPDATE annotations_exportformat SET {k} = $2 WHERE id = $1"
            ))
            .bind(id)
            .bind(t)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        }
    }
    for k in [
        "public",
        "image_aggregation",
        "include_blurred",
        "include_concealed",
    ] {
        if let Some(v) = d.get(k) {
            let b = v
                .as_bool()
                .ok_or_else(|| field_err(k, "true or false is required."))?;
            sqlx::query(&format!(
                "UPDATE annotations_exportformat SET {k} = $2 WHERE id = $1"
            ))
            .bind(id)
            .bind(b)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
        }
    }
    if let Some(Value::Array(a)) = d.get("annotation_types") {
        sqlx::query(
            "DELETE FROM annotations_exportformat_annotations_types WHERE exportformat_id = $1",
        )
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
        for t in a.iter().filter_map(Value::as_i64) {
            sqlx::query("INSERT INTO annotations_exportformat_annotations_types (exportformat_id, annotationtype_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
                .bind(id)
                .bind(t)
                .execute(&mut *tx)
                .await
                .map_err(db_err)?;
        }
    }
    // exports made with the old version become "deprecated" (as in Django)
    sqlx::query("UPDATE annotations_exportformat SET last_change_time = now() WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(Json(format_json(&s, id).await?).into_response())
}

async fn format_delete_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let team: i64 =
        sqlx::query_scalar("SELECT team_id FROM annotations_exportformat WHERE id = $1")
            .bind(id)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?
            .ok_or_else(not_found)?;
    if !member_of(&s, p.user.id, team).await? {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for managing export formats missing.",
        ));
    }
    // exports made with it keep their text; the format reference goes
    sqlx::query("UPDATE annotations_export SET format_id = NULL WHERE format_id = $1")
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    sqlx::query(
        "DELETE FROM annotations_exportformat_annotations_types WHERE exportformat_id = $1",
    )
    .bind(id)
    .execute(&s.pool)
    .await
    .map_err(db_err)?;
    sqlx::query("DELETE FROM annotations_exportformat WHERE id = $1")
        .bind(id)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_float_formatting() {
        for (f, want) in [
            (0.5, "0.5"),
            (10.0, "10.0"),
            (123456.789, "123456.789"),
            (0.0001, "0.0001"),
            (0.00001, "1e-05"),
            (1.5e-7, "1.5e-07"),
            (1e16, "1e+16"),
            (1.2345e20, "1.2345e+20"),
            (-2.25, "-2.25"),
            (0.0, "0.0"),
            (1.0 / 3.0, "0.3333333333333333"),
        ] {
            assert_eq!(py_float(f), want, "{f}");
        }
    }

    #[test]
    fn python_repr_of_json() {
        let v: Value =
            serde_json::from_str(r#"{"a": null, "b": [true, 1, 2.5], "c": "it's"}"#).unwrap();
        assert_eq!(
            py_repr(&v),
            r#"{'a': None, 'b': [True, 1, 2.5], 'c': "it's"}"#
        );
    }

    fn ann(vt: i32, v: Value) -> Ann {
        Ann {
            image: 1,
            type_name: "Mitosis".into(),
            vector_type: vt,
            vector: v.as_object().cloned().unwrap_or_default(),
            blurred: false,
            concealed: true,
            deleted: false,
            time: DateTime::parse_from_rfc3339("2025-01-02T03:04:05.5Z")
                .unwrap()
                .into(),
            last_edit_time: DateTime::parse_from_rfc3339("2025-01-02T03:04:05Z")
                .unwrap()
                .into(),
            user: "ann".into(),
            last_editor: None,
            uuid: "u-1".into(),
            meta: Value::Null,
        }
    }

    #[test]
    fn renders_box_with_geometry_and_python_numbers() {
        let f = Format {
            name_format: "export_%%exportid_%%imageset.txt".into(),
            base_format: "head %%imageset\n%%content".into(),
            image_format: None,
            annotation_format: "%%imagename|%%type|{%%vector}|%%width|%%height|%%cx|%%cy|%%relwidth|%%dia|%%frame|%%ifconcealedC%%endif%%ifnotblurredNB%%endif|%%last_editor|%%first_timepoint".into(),
            vector_format: r#""x%%count1": %%x,"y%%count1": %%y,"#.into(),
            not_in_image_format: "none %%imagename".into(),
            image_aggregation: false,
            include_blurred: true,
            include_concealed: true,
        };
        let set = SetInfo {
            name: "S".into(),
            team: "T".into(),
            location: None,
            description: None,
        };
        let img = Img {
            id: 1,
            name: "a.svs".into(),
            width: 1000,
            height: 500,
            log: String::new(),
        };
        let a = ann(1, json!({"x1": 100, "y1": 50, "x2": 200, "y2": 150}));
        let n = ann(1, json!({}));
        let (text, count, name) = render(&f, &set, &[img], &[a, n]);
        assert_eq!(count, 2);
        assert_eq!(name, "export_%%exportid_S.txt");
        assert_eq!(
            text,
            "head S\n\na.svs|Mitosis|{\"x1\": 100,\"y1\": 50,\"x2\": 200,\"y2\": 150}|100|100|150.0|100.0|0.1|100.0|1|CNB|-1|2025-01-02 03:04:05.500000+00:00\nnone a.svs\n"
        );
    }
}
