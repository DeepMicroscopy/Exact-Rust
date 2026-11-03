//! `GET /api/v2/images/{id}/related` lists the images linked to this one: registrations (either direction), the image it
//! was cropped from, and the crops made from it. Only images of the user's teams are listed; an image the user cannot
//! see is a 404 as everywhere.

use crate::{
    auth::{authenticate, require_user, Principal},
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
use serde_json::{json, Value};
use sqlx::Row;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v2/images/{id}/related", get(related))
}

/// 404 unless one of the user's teams owns the image's set.
async fn visible(s: &AppState, p: &Principal, id: i64) -> ApiResult<()> {
    let v = p.viewer();
    let ok: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE i.id = $1 AND st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $2 \
           AND ($3::bigint[] IS NULL OR team_id = ANY($3))))",
    )
    .bind(id)
    .bind(v.id)
    .bind(v.token_teams)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    if ok {
        Ok(())
    } else {
        Err(ApiError::not_found("No Image matches the given query."))
    }
}

fn entry(r: &sqlx::postgres::PgRow, kind: &str) -> Value {
    json!({"id": r.get::<i64, _>(0), "name": r.get::<String, _>(1), "set": r.get::<i64, _>(2), "set_name": r.get::<String, _>(3), "kind": kind})
}

async fn related(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    visible(&s, &p, id).await?;
    let v = p.viewer();
    const VISIBLE: &str = "st.team_id IN (SELECT team_id FROM users_teammembership WHERE user_id = $2 AND ($3::bigint[] IS NULL OR team_id = ANY($3)))";
    let (pool, uid, teams) = (&s.pool, v.id, v.token_teams.clone());
    let q = |sql: String| {
        let teams = teams.clone();
        async move {
            sqlx::query(&sql)
                .bind(id)
                .bind(uid)
                .bind(teams)
                .fetch_all(pool)
                .await
        }
    };
    // registrations in both directions; `registered_to`: this image is the source and the other one the target
    let registered_to = q(format!(
        "SELECT i.id::bigint, i.name, st.id::bigint, st.name FROM images_imageregistration r \
         JOIN images_image i ON i.id = r.target_image_id JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE r.source_image_id = $1 AND {VISIBLE} ORDER BY st.name, i.name"
    ))
    .await
    .map_err(db_err)?;
    let registered_from = q(format!(
        "SELECT i.id::bigint, i.name, st.id::bigint, st.name FROM images_imageregistration r \
         JOIN images_image i ON i.id = r.source_image_id JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE r.target_image_id = $1 AND {VISIBLE} ORDER BY st.name, i.name"
    ))
    .await
    .map_err(db_err)?;
    let crop_of = q(format!(
        "SELECT i.id::bigint, i.name, st.id::bigint, st.name FROM images_image c \
         JOIN images_image i ON i.id = c.crop_source_id JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE c.id = $1 AND {VISIBLE}"
    ))
    .await
    .map_err(db_err)?;
    let crops = q(format!(
        "SELECT i.id::bigint, i.name, st.id::bigint, st.name FROM images_image i \
         JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE i.crop_source_id = $1 AND {VISIBLE} ORDER BY st.name, i.name"
    ))
    .await
    .map_err(db_err)?;
    // segmentation files linked to this volume (visible() has checked the image): `id` is the volume, so that the entry opens it
    let files = sqlx::query(
        "SELECT i.id::bigint, lv.name, st.id::bigint, st.name, lv.id FROM exact_rust_linked_volume lv \
         JOIN images_image i ON i.id = lv.image_id JOIN images_imageset st ON st.id = i.image_set_id \
         WHERE lv.image_id = $1 ORDER BY lv.name",
    )
    .bind(id)
    .fetch_all(pool)
    .await
    .map_err(db_err)?;
    let mut out: Vec<Value> = Vec::new();
    out.extend(crop_of.iter().map(|r| entry(r, "crop_of")));
    out.extend(crops.iter().map(|r| entry(r, "crop")));
    out.extend(registered_to.iter().map(|r| entry(r, "registered_to")));
    out.extend(registered_from.iter().map(|r| entry(r, "registered_from")));
    out.extend(files.iter().map(|r| {
        let mut e = entry(r, "segmentation");
        e["file"] = json!(r.get::<i64, _>(4)); // the segmentation file, so that the entry can open the volume with this one shown
        e
    }));
    Ok(Json(out).into_response())
}
