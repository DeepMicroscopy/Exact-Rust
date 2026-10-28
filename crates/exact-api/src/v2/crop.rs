//! "Crop to new image": a region of an image becomes a new pyramidal image in an image set.
//!
//! - `POST /api/v2/images/{id}/crop` `{"x", "y", "w", "h", "frame"?, "image_set"}`: answers 201 with the new image (v2 shape).
//! - legacy `GET /images/api/image/crop/{id}/{x}/{y}/{z}/{w}/{h}/{set}/` (exact-sync, creates an image although it is a GET).
//! - `GET /api/v2/image-sets/writable`: the image sets the user can add images to (for the choice of the target).
//!
//! Needs `edit_set` in the source and the target set, the target must not be locked. The file is
//! `<source stem>x<x>_y<y>_z<frame>_w<w>_h<h>.tiff` in the folder of the target set; the new image remembers where it comes
//! from (`crop_source`, `crop_x`, `crop_y`, `crop_frame`). Cropping the same region into the same set twice answers 409 with
//! the existing image. Annotations are not copied.

use crate::{
    auth::{authenticate, require_user, Principal},
    compat::{
        engine::{self, db_err, snake_keys, Ctx},
        perms::{perms, set_row},
        specs,
    },
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha512};
use sqlx::Row;

pub fn legacy_routes() -> Router<AppState> {
    Router::new().route(
        "/images/api/image/crop/{id}/{x}/{y}/{z}/{w}/{h}/{set}/",
        get(legacy_crop),
    )
}

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/images/{id}/crop", post(v2_crop))
        .route("/api/v2/image-sets/writable", get(writable_sets))
}

/// Pixels a crop may have (memory is flat, time and disk are not).
fn max_pixels() -> u64 {
    std::env::var("CROP_MAX_PIXELS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(400_000_000)
}

fn bad(field: &str, msg: &str) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({"detail": "Validation failed.", "errors": {field: [msg]}}),
    }
}

struct Source {
    set_id: i64,
    path: String,
    filename: String,
    width: i64,
    height: i64,
    mpp: f64,
    objective: f64,
}

async fn source(s: &AppState, id: i64) -> ApiResult<Source> {
    let r = sqlx::query(
        "SELECT i.image_set_id, st.path, i.filename, i.width, i.height, i.mpp, i.\"objectivePower\" FROM images_image i \
         JOIN images_imageset st ON st.id = i.image_set_id WHERE i.id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?
    .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    Ok(Source {
        set_id: r.get(0),
        path: r.get::<Option<String>, _>(1).unwrap_or_default(),
        filename: r.get(2),
        width: r.get::<i32, _>(3) as i64,
        height: r.get::<i32, _>(4) as i64,
        mpp: r.get(5),
        objective: r.get(6),
    })
}

/// Creates the crop; returns the new image id, or `Err((409, id))` when it exists.
#[allow(clippy::too_many_arguments)]
async fn crop(
    s: &AppState,
    p: &Principal,
    image: i64,
    (x, y, w, h): (i64, i64, i64, i64),
    frame: i64,
    target_set: i64,
    legacy_codes: bool,
) -> ApiResult<i64> {
    let src = source(s, image).await?;
    let forbid = |m: &str| ApiError::detail(StatusCode::FORBIDDEN, m);
    let src_row = set_row(s, src.set_id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let src_perm = perms(s, p, &src_row).await?;
    if !src_perm.read {
        return Err(ApiError::not_found("No Image matches the given query."));
    }
    let tgt_row = set_row(s, target_set)
        .await?
        .ok_or_else(|| bad("image_set", "The image set does not exist."))?;
    let tgt_perm = perms(s, p, &tgt_row).await?;
    if !tgt_perm.read {
        return Err(bad("image_set", "The image set does not exist."));
    }
    if !tgt_perm.edit_set || !src_perm.edit_set {
        return Err(forbid("permission for editing the image sets missing."));
    }
    let (tgt_path, locked): (Option<String>, bool) =
        sqlx::query_as("SELECT path, image_lock FROM images_imageset WHERE id = $1")
            .bind(target_set)
            .fetch_one(&s.pool)
            .await
            .map_err(db_err)?;
    if locked {
        return Err(forbid("the target image set is locked."));
    }
    if w < 1 || h < 1 || x < 0 || y < 0 || x + w > src.width || y + h > src.height {
        let m = format!(
            "The region {w}x{h} at ({x}, {y}) is not inside the image ({}x{}).",
            src.width, src.height
        );
        return Err(if legacy_codes {
            forbid(&m)
        } else {
            bad("region", &m)
        });
    }
    if (w * h) as u64 > max_pixels() {
        return Err(bad(
            "region",
            &format!(
                "At most {} megapixels can be cropped.",
                max_pixels() / 1_000_000
            ),
        ));
    }
    let stem = std::path::Path::new(&src.filename)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let name = format!("{stem}x{x}_y{y}_z{frame}_w{w}_h{h}.tiff");
    let exists: Option<i64> = sqlx::query_scalar("SELECT id FROM images_image WHERE image_set_id = $1 AND (name = $2 OR filename = $2) ORDER BY id LIMIT 1")
        .bind(target_set)
        .bind(&name)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
    if let Some(id) = exists {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            body: json!({"detail": "This region was cropped into the image set before.", "existing": id}),
        });
    }
    let dir = s.slides.root().join(tgt_path.unwrap_or_default());
    tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        ApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("cannot create the folder: {e}"),
        )
    })?;
    let dst = dir.join(&name);
    let src_file = s
        .slides
        .root()
        .join(&src.path)
        .join(&src.filename)
        .to_string_lossy()
        .to_string();
    let (dst_str, mpp) = (dst.to_string_lossy().to_string(), src.mpp);
    let state = s.slides.clone();
    let done = tokio::task::spawn_blocking(move || {
        let slide = state.open_slide(&src_file).map_err(|e| e.to_string())?;
        exact_wsi::crop::crop_to_pyramid(
            slide.as_ref(),
            (x, y, w as u32, h as u32),
            frame.max(0) as u32,
            mpp,
            &dst_str,
            &|_| {},
        )
        .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if let Err(e) = done {
        let _ = tokio::fs::remove_file(&dst).await;
        return Err(ApiError::detail(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("The crop failed: {e}"),
        ));
    }
    // EXACT checksums the first 10000 bytes
    let head = {
        use tokio::io::AsyncReadExt;
        let mut f = tokio::fs::File::open(&dst)
            .await
            .map_err(|e| ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        let mut buf = vec![0u8; 10000];
        let n = f.read(&mut buf).await.unwrap_or(0);
        buf.truncate(n);
        buf
    };
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO images_image (name, filename, time, checksum, image_set_id, height, width, mpp, \"objectivePower\", image_type, channels, depth, frames, \
         \"defaultFrame\", creator_id, crop_source_id, crop_x, crop_y, crop_frame) \
         VALUES ($1, $1, now(), $2, $3, $4, $5, $6, $7, 0, 3, 1, 1, 0, $8, $9, $10, $11, $12) RETURNING id",
    )
    .bind(&name)
    .bind(Sha512::digest(&head).to_vec())
    .bind(target_set)
    .bind(h as i32)
    .bind(w as i32)
    .bind(src.mpp)
    .bind(src.objective)
    .bind(p.user.id)
    .bind(image)
    .bind(x as i32)
    .bind(y as i32)
    .bind(frame as i32)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(id)
}

async fn image_json(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    id: i64,
    v2: bool,
) -> ApiResult<Value> {
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string(),
        v2,
    };
    let v = engine::serialize_ids(&ctx, specs::by_name("Image"), &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    Ok(if v2 { snake_keys(v) } else { v })
}

fn int(d: &serde_json::Map<String, Value>, k: &str) -> ApiResult<i64> {
    d.get(k)
        .and_then(Value::as_i64)
        .ok_or_else(|| bad(k, "An integer is required."))
}

async fn v2_crop(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
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
    let region = (int(&d, "x")?, int(&d, "y")?, int(&d, "w")?, int(&d, "h")?);
    let frame = d.get("frame").and_then(Value::as_i64).unwrap_or(0);
    let target = int(&d, "image_set")?;
    let new = crop(&s, &p, id, region, frame, target, false).await?;
    Ok((
        StatusCode::CREATED,
        Json(image_json(&s, &p, &headers, new, true).await?),
    )
        .into_response())
}

async fn legacy_crop(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((id, x, y, z, w, h, set)): Path<(i64, i64, i64, i64, i64, i64, i64)>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    if let crate::auth::AuthKind::Token(t) = &p.kind {
        if t.read_only {
            return Err(ApiError::detail(
                StatusCode::FORBIDDEN,
                "This token is read-only.",
            ));
        }
    }
    let new = crop(&s, &p, id, (x, y, w, h), z, set, true).await?;
    Ok((
        StatusCode::CREATED,
        Json(image_json(&s, &p, &headers, new, false).await?),
    )
        .into_response())
}

/// Image sets of the user's teams that are not locked: `[{id, name, team, team_name}]`.
async fn writable_sets(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let v = p.viewer();
    let rows = sqlx::query(
        "SELECT st.id, st.name, t.id, t.name FROM images_imageset st JOIN users_team t ON t.id = st.team_id \
         WHERE NOT st.image_lock AND st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $1 \
           AND ($2::bigint[] IS NULL OR team_id = ANY($2))) ORDER BY t.name, st.name",
    )
    .bind(v.id)
    .bind(v.token_teams)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let out: Vec<Value> = rows
        .iter()
        .map(|r| json!({"id": r.get::<i64, _>(0), "name": r.get::<String, _>(1), "team": r.get::<i64, _>(2), "team_name": r.get::<String, _>(3)}))
        .collect();
    Ok(Json(json!({"items": out})).into_response())
}
