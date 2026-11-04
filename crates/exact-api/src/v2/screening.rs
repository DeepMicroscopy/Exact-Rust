//! The screening mode of the signed-in user for an image (`images_screeningmode`, one row per user and image; the old EXACT's
//! `/api/v1/images/screening_modes/` serves the same rows but needs the Django model permission, which an ordinary member lacks):
//!
//! - `GET /api/v2/images/{id}/screening` -> the mode, or `null`
//! - `PUT /api/v2/images/{id}/screening` with any of `x_resolution, y_resolution, x_steps, y_steps, current_index, screening_tiles`
//!   (all of them when none is stored yet) -> the mode
//!
//! It is the user's own progress through a slide, so it is self-service: a read-only account may keep it, somebody who impersonates an
//! account may not change it. The image has to be readable for the user.

use crate::{
    auth::{authenticate_account, require_user, AuthKind},
    compat::{engine::db_err, legacy::can_read_set},
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, Method, StatusCode},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sqlx::Row;

pub fn v2_routes() -> Router<AppState> {
    Router::new().route("/api/v2/images/{id}/screening", get(read).put(write))
}

const MAX_TILES: usize = 100_000;

async fn readable(s: &AppState, p: &crate::auth::Principal, image: i64) -> ApiResult<()> {
    let set: Option<i64> = sqlx::query_scalar("SELECT image_set_id FROM images_image WHERE id = $1")
        .bind(image)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
    match set {
        Some(set) if can_read_set(s, p, set).await? => Ok(()),
        _ => Err(ApiError::not_found("No Image matches the given query.")),
    }
}

async fn stored(s: &AppState, image: i64, user: i64) -> ApiResult<Option<Value>> {
    let row = sqlx::query("SELECT id, x_resolution, y_resolution, x_steps, y_steps, current_index, screening_tiles FROM images_screeningmode WHERE image_id = $1 AND user_id = $2")
        .bind(image)
        .bind(user)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(row.map(|r| {
        json!({"id": r.get::<i64, _>(0), "x_resolution": r.get::<i32, _>(1), "y_resolution": r.get::<i32, _>(2), "x_steps": r.get::<i32, _>(3),
               "y_steps": r.get::<i32, _>(4), "current_index": r.get::<i32, _>(5),
               "screening_tiles": r.get::<Option<Value>, _>(6).unwrap_or_else(|| json!({}))})
    }))
}

async fn read(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate_account(&s, &headers, &Method::GET).await?)?;
    readable(&s, &p, id).await?;
    Ok(Json(stored(&s, id, p.user.id).await?.unwrap_or(Value::Null)))
}

fn int(body: &Value, key: &str, min: i64) -> ApiResult<Option<i32>> {
    match body.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_i64()
            .filter(|n| (min..=i64::from(i32::MAX)).contains(n))
            .map(|n| Some(n as i32))
            .ok_or_else(|| {
                ApiError::detail(StatusCode::BAD_REQUEST, format!("{key} must be an integer >= {min}."))
            }),
    }
}

async fn write(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate_account(&s, &headers, &Method::PUT).await?)?;
    if matches!(
        p.kind,
        AuthKind::Session {
            impersonator: Some(_),
            ..
        }
    ) {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "Not available while impersonating.",
        ));
    }
    readable(&s, &p, id).await?;
    let (xr, yr) = (int(&body, "x_resolution", 1)?, int(&body, "y_resolution", 1)?);
    let (xs, ys) = (int(&body, "x_steps", 1)?, int(&body, "y_steps", 1)?);
    let cur = int(&body, "current_index", 0)?;
    let tiles = match body.get("screening_tiles") {
        None | Some(Value::Null) => None,
        Some(v) if v.as_object().is_some_and(|o| o.len() <= MAX_TILES) => Some(v.clone()),
        Some(_) => {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "screening_tiles must be an object of at most 100000 windows.",
            ))
        }
    };
    let old = stored(&s, id, p.user.id).await?;
    let (Some(xr), Some(yr), Some(xs), Some(ys), Some(tiles)) = (
        xr.or_else(|| old.as_ref().and_then(|o| o["x_resolution"].as_i64()).map(|n| n as i32)),
        yr.or_else(|| old.as_ref().and_then(|o| o["y_resolution"].as_i64()).map(|n| n as i32)),
        xs.or_else(|| old.as_ref().and_then(|o| o["x_steps"].as_i64()).map(|n| n as i32)),
        ys.or_else(|| old.as_ref().and_then(|o| o["y_steps"].as_i64()).map(|n| n as i32)),
        tiles.or_else(|| old.as_ref().map(|o| o["screening_tiles"].clone())),
    ) else {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "A new screening mode needs x_resolution, y_resolution, x_steps, y_steps and screening_tiles.",
        ));
    };
    let cur = cur
        .or_else(|| old.as_ref().and_then(|o| o["current_index"].as_i64()).map(|n| n as i32))
        .unwrap_or(0);
    if i64::from(cur) >= i64::from(xs) * i64::from(ys) {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "current_index is outside the windows.",
        ));
    }
    sqlx::query(
        "INSERT INTO images_screeningmode (image_id, user_id, x_resolution, y_resolution, x_steps, y_steps, current_index, screening_tiles)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (image_id, user_id) DO UPDATE SET x_resolution = $3, y_resolution = $4, x_steps = $5, y_steps = $6, current_index = $7, screening_tiles = $8",
    )
    .bind(id)
    .bind(p.user.id)
    .bind(xr)
    .bind(yr)
    .bind(xs)
    .bind(ys)
    .bind(cur)
    .bind(tiles)
    .execute(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(stored(&s, id, p.user.id).await?.unwrap_or(Value::Null)))
}
