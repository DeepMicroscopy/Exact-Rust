//! `POST /api/v1/users/teams/`, `PUT` and `PATCH /api/v1/users/teams/{id}/` as the Django `TeamViewset` does them (EXACT PR 169):
//! the name is the only field a client writes; `members`, `image_sets`, `product_set` and `memberships` are read-only and ignored.
//! A team's creator becomes its admin. Permissions are Django's model permissions (`add_team`, `change_team`), the team has to be
//! one of the caller's. Deleting a team is not offered here (use `DELETE /api/v2/teams/{id}`).

use super::{
    engine,
    rest_writes::{body_value, object},
    specs,
};
use crate::{
    auth::Principal,
    error::{ApiError, ApiResult},
    page::Flex,
    AppState,
};
use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Map, Value};

fn ctx<'a>(s: &'a AppState, p: &Principal, headers: &HeaderMap) -> engine::Ctx<'a> {
    engine::Ctx {
        s,
        viewer: p.viewer(),
        host: headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string(),
        v2: false,
    }
}

fn bad(field: &str, msgs: Vec<String>) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({ field: msgs }),
    }
}

/// The name as the serializer validates it (`CharField` with the model's validators: 3 to 30 characters, unique).
async fn name_of(
    s: &AppState,
    d: &Map<String, Value>,
    required: bool,
    own: Option<i64>,
) -> ApiResult<Option<String>> {
    let name = match d.get("name") {
        None if required => return Err(bad("name", vec!["This field is required.".into()])),
        None => return Ok(None),
        Some(Value::Null) => return Err(bad("name", vec!["This field may not be null.".into()])),
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(_) => return Err(bad("name", vec!["Not a valid string.".into()])),
    };
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(bad("name", vec!["This field may not be blank.".into()]));
    }
    let n = name.chars().count();
    let mut errs = vec![];
    if n < 3 {
        errs.push("Ensure this field has at least 3 characters.".to_string());
    }
    // the model's validator says 30, DRF takes the field's `max_length` of 100 (a longer name is accepted by Django)
    if n > 100 {
        errs.push("Ensure this field has no more than 100 characters.".to_string());
    }
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM users_team WHERE name = $1 AND ($2::bigint IS NULL OR id <> $2))",
    )
    .bind(&name)
    .bind(own)
    .fetch_one(&s.pool)
    .await
    .map_err(engine::db_err)?;
    if taken {
        errs.push("team with this team name already exists.".to_string());
    }
    if errs.is_empty() {
        Ok(Some(name))
    } else {
        Err(bad("name", errs))
    }
}

async fn shown(s: &AppState, p: &Principal, headers: &HeaderMap, id: i64) -> ApiResult<Value> {
    let spec = specs::by_name("Team");
    engine::serialize_ids(&ctx(s, p, headers), spec, &[id])
        .await?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::not_found("Not found."))
}

pub async fn create(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    body: &[u8],
) -> ApiResult<Response> {
    let d = object(body_value(body)?)?;
    let name = name_of(s, &d, true, None).await?.unwrap_or_default();
    let mut tx = s.pool.begin().await.map_err(engine::db_err)?;
    let id: i64 =
        sqlx::query_scalar("INSERT INTO users_team (name, website) VALUES ($1, '') RETURNING id")
            .bind(&name)
            .fetch_one(&mut *tx)
            .await
            .map_err(engine::db_err)?;
    // the creator becomes admin
    sqlx::query(
        "INSERT INTO users_teammembership (is_admin, team_id, user_id) VALUES (true, $1, $2)",
    )
    .bind(id)
    .bind(p.user.id)
    .execute(&mut *tx)
    .await
    .map_err(engine::db_err)?;
    tx.commit().await.map_err(engine::db_err)?;
    // Django answers with the data of the serializer, before it adds the creator
    let mut v = shown(s, p, headers, id).await?;
    if let Some(o) = v.as_object_mut() {
        for k in ["members", "memberships"] {
            if o.contains_key(k) {
                o.insert(k.into(), json!([]));
            }
        }
    }
    Ok((StatusCode::CREATED, Json(v)).into_response())
}

pub async fn update(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    id: i64,
    body: &[u8],
    partial: bool,
) -> ApiResult<Response> {
    // the team has to be one of the caller's
    let (_, found) = engine::list(
        &ctx(s, p, headers),
        specs::by_name("Team"),
        &[],
        &Flex::default(),
        1,
        0,
        Some(id),
    )
    .await?;
    if found.is_empty() {
        return Err(ApiError::not_found("No Team matches the given query."));
    }
    let d = object(body_value(body)?)?;
    if let Some(name) = name_of(s, &d, !partial, Some(id)).await? {
        sqlx::query("UPDATE users_team SET name = $2 WHERE id = $1")
            .bind(id)
            .bind(name)
            .execute(&s.pool)
            .await
            .map_err(engine::db_err)?;
    }
    Ok(Json(shown(s, p, headers, id).await?).into_response())
}
