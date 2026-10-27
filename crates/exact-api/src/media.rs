//! File fields (`MEDIA_ROOT`, served at `/media/`): storage like Django's `FileSystemStorage`, and the parsing of request
//! bodies that carry files (`multipart/form-data`) next to plain fields (`application/x-www-form-urlencoded` and JSON too).

use crate::{
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    http::{header, HeaderMap, StatusCode},
};
use serde_json::{Map, Value};
use std::path::{Component, Path};

pub struct Upload {
    pub field: String,
    pub filename: String,
    pub data: Bytes,
}

/// Fields of a request body (values of non-JSON bodies are strings) and the uploaded files.
pub struct Payload {
    pub fields: Map<String, Value>,
    pub files: Vec<Upload>,
    /// the body was a form: all values are strings, JSON fields arrive as JSON text
    pub form: bool,
}

fn bad(msg: impl Into<String>) -> ApiError {
    ApiError::detail(StatusCode::BAD_REQUEST, msg)
}

pub async fn parse_body(headers: &HeaderMap, body: &Bytes) -> ApiResult<Payload> {
    let ctype = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if ctype.starts_with("multipart/form-data") {
        let boundary = multer::parse_boundary(ctype)
            .map_err(|e| bad(format!("Multipart form parse error - {e}")))?;
        let stream = futures_util::stream::once(futures_util::future::ready(
            Ok::<_, std::io::Error>(body.clone()),
        ));
        let mut mp = multer::Multipart::new(stream, boundary);
        let mut out = Payload {
            fields: Map::new(),
            files: vec![],
            form: true,
        };
        while let Some(field) = mp
            .next_field()
            .await
            .map_err(|e| bad(format!("Multipart form parse error - {e}")))?
        {
            let name = field.name().unwrap_or("").to_string();
            let filename = field.file_name().map(|f| f.to_string());
            let data = field
                .bytes()
                .await
                .map_err(|e| bad(format!("Multipart form parse error - {e}")))?;
            match filename {
                Some(f) if !f.is_empty() => out.files.push(Upload {
                    field: name,
                    filename: f,
                    data,
                }),
                Some(_) => {}
                None => {
                    out.fields.insert(
                        name,
                        Value::String(String::from_utf8_lossy(&data).into_owned()),
                    );
                }
            }
        }
        return Ok(out);
    }
    if ctype.starts_with("application/x-www-form-urlencoded") {
        let fields = form_urlencoded::parse(body)
            .map(|(k, v)| (k.into_owned(), Value::String(v.into_owned())))
            .collect();
        return Ok(Payload {
            fields,
            files: vec![],
            form: true,
        });
    }
    let fields = if body.is_empty() {
        Map::new()
    } else {
        match serde_json::from_slice::<Value>(body) {
            Ok(Value::Object(m)) => m,
            Ok(_) => return Err(bad("Expected a JSON object.")),
            Err(e) => return Err(bad(format!("JSON parse error - {e}"))),
        }
    };
    Ok(Payload {
        fields,
        files: vec![],
        form: false,
    })
}

/// Django's `get_valid_filename`: spaces become underscores, everything but letters, digits, `-`, `_`, `.` is dropped.
pub fn valid_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let cleaned: String = base
        .replace(' ', "_")
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
        .collect();
    if cleaned.is_empty() || cleaned == "." || cleaned == ".." {
        "upload".to_string()
    } else {
        cleaned
    }
}

/// Stores `data` as `dir/filename` below `MEDIA_ROOT`; an existing file is never overwritten (`name_AbC1234.ext`, as
/// Django does). Returns the path relative to `MEDIA_ROOT` (what the column holds).
pub async fn store(s: &AppState, dir: &str, filename: &str, data: &[u8]) -> ApiResult<String> {
    let rel_dir = Path::new(dir);
    if rel_dir
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(bad("invalid storage path"));
    }
    let root = s.media_root.join(rel_dir);
    let io = |e: std::io::Error| {
        ApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot store the file: {e}"),
        )
    };
    tokio::fs::create_dir_all(&root).await.map_err(io)?;
    let name = valid_name(filename);
    let mut candidate = name.clone();
    while tokio::fs::try_exists(root.join(&candidate))
        .await
        .unwrap_or(false)
    {
        let suffix: String = uuid::Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(7)
            .collect();
        let p = Path::new(&name);
        let stem = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        candidate = match p.extension() {
            Some(e) => format!("{stem}_{suffix}.{}", e.to_string_lossy()),
            None => format!("{stem}_{suffix}"),
        };
    }
    tokio::fs::write(root.join(&candidate), data)
        .await
        .map_err(io)?;
    Ok(format!("{}/{}", dir.trim_end_matches('/'), candidate))
}

pub async fn remove(s: &AppState, rel: &str) {
    if !rel.contains("..") && !rel.starts_with('/') {
        let _ = tokio::fs::remove_file(s.media_root.join(rel)).await;
    }
}
