//! `GET /api/v2/teams/{id}/statistics`: storage, file types, image kinds and annotation types of a team (members only),
//! as `team_statistics_api` of EXACT.

use crate::{
    auth::{authenticate, require_user},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Method},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::json;
use sqlx::Row;
use std::{collections::HashMap, path::Path as FsPath};

pub fn v2_routes() -> Router<AppState> {
    Router::new().route("/api/v2/teams/{id}/statistics", get(team_h))
}

const VOLUMETRIC: &[&str] = &[
    ".nii", ".nii.gz", ".dcm", ".mha", ".mhd", ".nrrd", ".vtk", ".mgz",
];
const MOVIE: &[&str] = &[
    ".mp4", ".mov", ".avi", ".mkv", ".webm", ".mkt", ".mpg", ".mpeg",
];
const GB: f64 = 1024.0 * 1024.0 * 1024.0;

/// `os.path.splitext(name)[1].lower()`: the last dot, unless it starts the name.
fn suffix(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    match base.rfind('.') {
        Some(i) if base[..i].chars().any(|c| c != '.') => base[i..].to_lowercase(),
        _ => String::new(),
    }
}

/// Django's `_classify_image`; `.nii.gz` counts as volumetric although `splitext` only sees `.gz`.
fn classify(name: &str, depth: i32, frames: i32, w: i32, h: i32) -> &'static str {
    let ext = suffix(name);
    if VOLUMETRIC.contains(&ext.as_str()) || name.to_lowercase().ends_with(".nii.gz") {
        return "Volumetric";
    }
    if depth > 1 {
        return "Z-Stack";
    }
    if frames > 1 {
        return if MOVIE.contains(&ext.as_str()) {
            "Movie"
        } else {
            "Z-Stack"
        };
    }
    if w.min(h) >= 10000 && w.max(h) >= 100000 {
        return "Whole Slide Image";
    }
    "Regular Image"
}

/// Bytes of all files below `dir` (tiles, thumbnails and caches included), symbolic links not followed.
fn folder_bytes(dir: &FsPath) -> u64 {
    let mut total = 0;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else {
            continue;
        };
        for e in rd.flatten() {
            let Ok(t) = e.file_type() else { continue };
            if t.is_dir() {
                stack.push(e.path());
            } else if t.is_file() {
                total += e.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    total
}

async fn team_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(team): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let member: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users_teammembership WHERE team_id = $1 AND user_id = $2)",
    )
    .bind(team)
    .bind(p.user.id)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if !member {
        return Err(ApiError::not_found("Not found."));
    }
    let sets: Vec<(i64, Option<String>)> =
        sqlx::query_as("SELECT id, path FROM images_imageset WHERE team_id = $1")
            .bind(team)
            .fetch_all(&s.pool)
            .await
            .map_err(db_err)?;
    let images = sqlx::query(
        "SELECT i.name, i.width, i.height, i.depth, i.frames, st.path FROM images_image i \
         JOIN images_imageset st ON st.id = i.image_set_id WHERE st.team_id = $1",
    )
    .bind(team)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let root = s.slides.root().to_path_buf();
    let rows: Vec<(String, i32, i32, i32, i32, Option<String>)> = images
        .iter()
        .map(|r| (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4), r.get(5)))
        .collect();
    let (storage, by_ext, kinds) = tokio::task::spawn_blocking(move || {
        let storage: u64 = sets
            .iter()
            .filter_map(|(_, path)| path.as_deref())
            .map(|path| folder_bytes(&root.join(path)))
            .sum();
        let mut by_ext: HashMap<String, (u64, u64)> = HashMap::new();
        let mut kinds: HashMap<&'static str, u64> = HashMap::new();
        for (name, w, h, d, f, path) in &rows {
            let size = path
                .as_deref()
                .and_then(|p| std::fs::metadata(root.join(p).join(name)).ok())
                .map(|m| m.len())
                .unwrap_or(0);
            let ext = Some(suffix(name))
                .filter(|e| !e.is_empty())
                .unwrap_or_else(|| "(none)".into());
            let e = by_ext.entry(ext).or_default();
            e.0 += 1;
            e.1 += size;
            *kinds.entry(classify(name, *d, *f, *w, *h)).or_default() += 1;
        }
        (storage, by_ext, kinds)
    })
    .await
    .map_err(|e| ApiError::detail(axum::http::StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let mut extensions: Vec<_> = by_ext.into_iter().collect();
    extensions.sort_by(|a, b| b.1 .0.cmp(&a.1 .0).then(a.0.cmp(&b.0)));
    let annotation_types: Vec<_> = sqlx::query(
        "SELECT t.name, t.color_code, count(*) AS n FROM annotations_annotation a \
         JOIN annotations_annotationtype t ON t.id = a.annotation_type_id \
         JOIN images_image i ON i.id = a.image_id JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE st.team_id = $1 AND NOT a.deleted GROUP BY t.id, t.name, t.color_code ORDER BY n DESC, t.name",
    )
    .bind(team)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?
    .iter()
    .map(|r| (r.get::<String, _>(0), r.get::<Option<String>, _>(1), r.get::<i64, _>(2)))
    .collect();
    let image_types: Vec<_> = [
        "Whole Slide Image",
        "Regular Image",
        "Z-Stack",
        "Movie",
        "Volumetric",
    ]
    .iter()
    .filter_map(|t| kinds.get(t).map(|n| json!({"type": t, "count": n})))
    .collect();
    let round = |v: f64| (v * 1000.0).round() / 1000.0;
    Ok(Json(json!({
        "storage_gb": round(storage as f64 / GB),
        "total_images": images.len(),
        "total_annotations": annotation_types.iter().map(|a| a.2).sum::<i64>(),
        "extensions": extensions.iter().map(|(e, (n, b))| json!({"ext": e, "count": n, "size_gb": round(*b as f64 / GB)})).collect::<Vec<_>>(),
        "image_types": image_types,
        "annotation_types": annotation_types.iter().map(|(n, c, k)| json!({"name": n, "color": c, "count": k})).collect::<Vec<_>>(),
    }))
    .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn images_are_classified_like_exact() {
        assert_eq!(suffix("a.TIFF"), ".tiff");
        assert_eq!(suffix(".hidden"), "");
        assert_eq!(classify("scan.nii.gz", 1, 1, 10, 10), "Volumetric");
        assert_eq!(classify("a.mp4", 1, 20, 10, 10), "Movie");
        assert_eq!(classify("a.tif", 1, 20, 10, 10), "Z-Stack");
        assert_eq!(classify("a.svs", 1, 1, 20000, 120000), "Whole Slide Image");
        assert_eq!(classify("a.png", 1, 1, 20, 10), "Regular Image");
    }
}
