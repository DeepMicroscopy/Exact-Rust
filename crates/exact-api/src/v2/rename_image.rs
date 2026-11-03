//! Renaming an image: `POST /api/v2/images/{id}/rename {"name": "..."}`.
//!
//! `Image.name` is the name of the original file; the file the viewers read is `filename` and stays as it is. If the original is a
//! separate file next to it (a converted image) it is renamed too. Needs `delete_images` in an unlocked set, like moving does.
//! The extension must stay (it tells the file type), and images whose files are found by their name (z-stacks, frames, MRXS / VSI
//! slides with a data folder) and server generated images cannot be renamed.

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
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;

pub fn v2_routes() -> Router<AppState> {
    Router::new().route("/api/v2/images/{id}/rename", post(rename))
}

fn ext(name: &str) -> String {
    std::path::Path::new(name)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Why `name` is not an acceptable new name, if it is not.
fn bad_name(name: &str, old: &str) -> Option<&'static str> {
    if name.is_empty() || name.len() > 250 {
        return Some("The name must have 1 to 250 characters.");
    }
    if name.contains(['/', '\\', '\0'])
        || name == "."
        || name.starts_with("..")
        || name.starts_with('.')
    {
        return Some("The name must not contain slashes and must not start with a dot.");
    }
    if ext(name) != ext(old) {
        return Some("The file extension has to stay the same.");
    }
    None
}

async fn rename(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let row = sqlx::query("SELECT i.name, i.filename, i.depth, i.frames, i.image_type, i.image_set_id, st.path, st.image_lock FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id WHERE i.id = $1")
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    let (old, filename, depth, frames, kind, set_id, path, locked): (
        String,
        String,
        i32,
        i32,
        i32,
        i64,
        Option<String>,
        bool,
    ) = (
        row.get(0),
        row.get(1),
        row.get(2),
        row.get(3),
        row.get(4),
        row.get(5),
        row.get(6),
        row.get(7),
    );
    let allowed = match set_row(&s, set_id).await? {
        Some(r) => perms(&s, &p, &r).await?.delete_images,
        None => false,
    };
    if !allowed {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "You are not allowed to rename images of this image set.",
        ));
    }
    let conflict = |m: &str| ApiError::detail(StatusCode::CONFLICT, m.to_string());
    if locked {
        return Err(conflict("The images of this image set are locked."));
    }
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    if let Some(m) = bad_name(&name, &old) {
        return Err(ApiError::detail(StatusCode::BAD_REQUEST, m));
    }
    if kind == 1 || depth > 1 || frames > 1 || matches!(ext(&old).as_str(), "mrxs" | "vsi") {
        return Err(conflict("This kind of image (server generated, z-stack, frames, MRXS or VSI slide) cannot be renamed."));
    }
    if name == old {
        return Ok(Json(json!({"id": id, "name": name})));
    }
    let clash: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM images_image WHERE image_set_id = $1 AND id <> $2 AND (name = $3 OR filename = $3))")
        .bind(set_id)
        .bind(id)
        .bind(&name)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    if clash {
        return Err(conflict("Another image of this image set has this name."));
    }
    // a separate original file goes along (the file of the viewers, `filename`, is not touched)
    let dir = s.slides.root().join(path.unwrap_or_default());
    let (from, to) = (dir.join(&old), dir.join(&name));
    let moved = old != filename && from.is_file();
    if moved {
        if to.exists() {
            return Err(conflict(
                "A file with this name exists in the folder of the image set.",
            ));
        }
        std::fs::rename(&from, &to)
            .map_err(|e| ApiError::from(exact_core::Error::Internal(e.to_string())))?;
    }
    let done = sqlx::query("UPDATE images_image SET name = $2 WHERE id = $1")
        .bind(id)
        .bind(&name)
        .execute(&s.pool)
        .await;
    if let Err(e) = done {
        if moved {
            let _ = std::fs::rename(&to, &from);
        }
        return Err(db_err(e));
    }
    Ok(Json(json!({"id": id, "name": name})))
}

#[cfg(test)]
mod tests {
    use super::bad_name;

    #[test]
    fn names_keep_their_extension_and_stay_in_the_folder() {
        assert_eq!(bad_name("b.tiff", "a.tiff"), None);
        assert_eq!(bad_name("B.TIFF", "a.tiff"), None);
        assert!(bad_name("b.png", "a.tiff").is_some());
        assert!(bad_name("../b.tiff", "a.tiff").is_some());
        assert!(bad_name("x/b.tiff", "a.tiff").is_some());
        assert!(bad_name(".b.tiff", "a.tiff").is_some());
        assert!(bad_name("", "a.tiff").is_some());
    }
}
