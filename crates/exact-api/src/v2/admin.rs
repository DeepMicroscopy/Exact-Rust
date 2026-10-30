//! Teams, memberships and user administration (v2).
//!
//! Teams: `POST /api/v2/teams` (the creator becomes admin), `PATCH` / `DELETE /api/v2/teams/{id}` (team admins; deleting
//! releases the team's image sets: public and locked, as when the last member leaves), `PUT /api/v2/teams/{id}/members/{user}`
//! (`{"is_admin"}`; team admins; any member may promote while the team has no admin), `DELETE` the same (leave, or kick as
//! admin; the last member leaving deletes the team).
//!
//! Users (rules of `administration/views.py`): `PATCH /api/v2/users/{id}` (staff: names, email, username, frontend; site
//! admin: `is_active` and `read_only`; superuser: `is_staff` and `is_site_admin`), `DELETE` (site admin), `POST /api/v2/users/{id}/random-password` (site admin,
//! answers the new password once). Nobody can change or delete their own account here, and only superusers touch
//! superusers.
//!
//! Model permissions (superusers only): `GET /api/v2/admin/permissions` (the permissions that matter here, grouped by model, and the
//! presets for service accounts), `GET` / `PUT /api/v2/admin/users/{id}/permissions` (`{"permissions": ["app.codename", ...]}` replaces
//! the user's own permissions; the ones that come from groups are shown, not changed), `POST /api/v2/admin/users` (a service account
//! with a random password, answered once, optional preset / permissions and teams); a site admin may create ordinary and read-only users there
//! (names, e-mail, teams, `read_only`), permissions and presets are for superusers.

use crate::{
    auth::{authenticate, require_user, AuthKind, Principal},
    cascade,
    compat::engine::{self, db_err, snake_keys, Ctx},
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::put,
    Json, Router,
};
use exact_auth::hashers::make_password;
use exact_db::users;
use serde_json::{json, Map, Value};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/v2/teams/{id}/members/{user}",
            put(member_put).delete(member_delete),
        )
        .route("/api/v2/admin/me", axum::routing::get(admin_me))
        .route(
            "/api/v2/admin/users/{id}/profile",
            axum::routing::get(user_profile),
        )
        .route(
            "/api/v2/users/{id}/random-password",
            axum::routing::post(random_password),
        )
        .route(
            "/api/v2/admin/permissions",
            axum::routing::get(permission_catalog),
        )
        .route("/api/v2/admin/users", axum::routing::post(user_create))
        .route("/api/v2/admin/roles", axum::routing::get(roles))
        .route(
            "/api/v2/admin/users/{id}/permissions",
            axum::routing::get(user_permissions_get).put(user_permissions_put),
        )
}

fn field_err(field: &str, msg: &str) -> ApiError {
    ApiError {
        status: StatusCode::BAD_REQUEST,
        body: json!({"detail": "Validation failed.", "errors": {field: [msg]}}),
    }
}

fn forbidden(msg: &str) -> ApiError {
    ApiError::detail(StatusCode::FORBIDDEN, msg)
}

fn object(body: &[u8]) -> ApiResult<Map<String, Value>> {
    if body.is_empty() {
        return Ok(Map::new());
    }
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(m)) => Ok(m),
        Ok(_) => Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Expected a JSON object.",
        )),
        Err(e) => Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("JSON parse error - {e}"),
        )),
    }
}

fn flag(v: Option<&Value>) -> Option<bool> {
    v.map(|v| {
        matches!(v, Value::Bool(true)) || matches!(v, Value::String(t) if t == "true" || t == "1")
    })
}

async fn serialized(
    s: &AppState,
    p: &Principal,
    headers: &HeaderMap,
    spec: &str,
    id: i64,
) -> ApiResult<Value> {
    let ctx = Ctx {
        s,
        viewer: p.viewer(),
        host: headers
            .get(header::HOST)
            .and_then(|h| h.to_str().ok())
            .unwrap_or("localhost")
            .to_string(),
        v2: true,
    };
    engine::serialize_ids(&ctx, crate::compat::specs::by_name(spec), &[id])
        .await?
        .into_iter()
        .next()
        .map(snake_keys)
        .ok_or_else(|| ApiError::not_found("Not found."))
}

// ---------------------------------------------------------------------------------------------------------
// teams
// ---------------------------------------------------------------------------------------------------------

struct TeamAccess {
    member: bool,
    admin: bool,
}

async fn team_access(s: &AppState, p: &Principal, team: i64) -> ApiResult<Option<TeamAccess>> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users_team WHERE id = $1)")
        .bind(team)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    if !exists {
        return Ok(None);
    }
    if let AuthKind::Token(scope) = &p.kind {
        if scope.team_ids.as_ref().is_some_and(|t| !t.contains(&team)) {
            return Ok(Some(TeamAccess {
                member: false,
                admin: false,
            }));
        }
    }
    let m: Option<bool> = sqlx::query_scalar(
        "SELECT is_admin FROM users_teammembership WHERE team_id = $1 AND user_id = $2",
    )
    .bind(team)
    .bind(p.user.id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Some(TeamAccess {
        member: m.is_some(),
        admin: m == Some(true),
    }))
}

fn team_name(d: &Map<String, Value>, required: bool) -> ApiResult<Option<String>> {
    match d.get("name") {
        None if required => Err(field_err("name", "This field is required.")),
        None => Ok(None),
        Some(Value::String(t)) if (3..=30).contains(&t.chars().count()) => Ok(Some(t.clone())),
        Some(_) => Err(field_err(
            "name",
            "A name of 3 to 30 characters is required.",
        )),
    }
}

async fn name_taken(s: &AppState, name: &str, except: Option<i64>) -> ApiResult<bool> {
    sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM users_team WHERE name = $1 AND ($2::bigint IS NULL OR id <> $2))")
        .bind(name)
        .bind(except)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)
}

pub async fn team_create(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    let d = object(&body)?;
    let name = team_name(&d, true)?.unwrap_or_default();
    let website = match d.get("website") {
        None => String::new(),
        Some(Value::String(t)) if t.chars().count() <= 100 => t.clone(),
        Some(_) => return Err(field_err("website", "At most 100 characters.")),
    };
    if name_taken(&s, &name, None).await? {
        return Err(field_err("name", "A team with this name already exists."));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let id: i64 =
        sqlx::query_scalar("INSERT INTO users_team (name, website) VALUES ($1, $2) RETURNING id")
            .bind(&name)
            .bind(&website)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_err)?;
    sqlx::query(
        "INSERT INTO users_teammembership (is_admin, team_id, user_id) VALUES (true, $1, $2)",
    )
    .bind(id)
    .bind(p.user.id)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok((
        StatusCode::CREATED,
        Json(serialized(&s, &p, &headers, "Team", id).await?),
    )
        .into_response())
}

pub async fn team_patch(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PATCH).await?)?;
    let access = team_access(&s, &p, id).await?;
    let access = access
        .filter(|a| a.member)
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if !access.admin {
        return Err(forbidden("Only team admins can change the team."));
    }
    let d = object(&body)?;
    let name = team_name(&d, false)?;
    if let Some(n) = &name {
        if name_taken(&s, n, Some(id)).await? {
            return Err(field_err("name", "A team with this name already exists."));
        }
    }
    let website = match d.get("website") {
        None => None,
        Some(Value::String(t)) if t.chars().count() <= 100 => Some(t.clone()),
        Some(_) => return Err(field_err("website", "At most 100 characters.")),
    };
    sqlx::query("UPDATE users_team SET name = COALESCE($2, name), website = COALESCE($3, website) WHERE id = $1")
        .bind(id)
        .bind(name)
        .bind(website)
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(Json(serialized(&s, &p, &headers, "Team", id).await?).into_response())
}

/// Image sets of a team that ends are released: public and locked (as `leave_team` does for the last member).
async fn end_team(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, team: i64) -> ApiResult<()> {
    sqlx::query("UPDATE images_imageset SET public = true, image_lock = true WHERE team_id = $1")
        .bind(team)
        .execute(&mut **tx)
        .await
        .map_err(db_err)?;
    cascade::delete_rows(tx, "users_team", &[team]).await?;
    Ok(())
}

pub async fn team_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let access = team_access(&s, &p, id).await?;
    let access = access
        .filter(|a| a.member || p.user.is_superuser)
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if !access.admin && !p.user.is_superuser {
        return Err(forbidden("Only team admins can delete the team."));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    end_team(&mut tx, id).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn member_put(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((team, user)): Path<(i64, i64)>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PUT).await?)?;
    let access = team_access(&s, &p, team).await?;
    let access = access
        .filter(|a| a.member)
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let d = object(&body)?;
    let is_admin = flag(d.get("is_admin"));
    let admins: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM users_teammembership WHERE team_id = $1 AND is_admin",
    )
    .bind(team)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    // any member may grant admin while nobody is admin; otherwise only admins manage members
    let may_promote_only = admins == 0 && is_admin == Some(true);
    if !access.admin && !may_promote_only {
        return Err(forbidden("Only team admins can manage the members."));
    }
    if is_admin == Some(false) && user == p.user.id {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "You can not revoke your own admin privileges.",
        ));
    }
    if !users::user_by_id(&s.pool, user).await?.is_some() {
        return Err(ApiError::not_found("User not found."));
    }
    let updated = sqlx::query("UPDATE users_teammembership SET is_admin = COALESCE($3, is_admin) WHERE team_id = $1 AND user_id = $2")
        .bind(team)
        .bind(user)
        .bind(is_admin)
        .execute(&s.pool)
        .await
        .map_err(db_err)?
        .rows_affected();
    let created = updated == 0;
    if created {
        sqlx::query(
            "INSERT INTO users_teammembership (is_admin, team_id, user_id) VALUES ($3, $1, $2)",
        )
        .bind(team)
        .bind(user)
        .bind(is_admin.unwrap_or(false))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    }
    let status = if created {
        StatusCode::CREATED
    } else {
        StatusCode::OK
    };
    let admin_now: bool = sqlx::query_scalar(
        "SELECT is_admin FROM users_teammembership WHERE team_id = $1 AND user_id = $2",
    )
    .bind(team)
    .bind(user)
    .fetch_one(&s.pool)
    .await
    .map_err(db_err)?;
    Ok((
        status,
        Json(json!({"team": team, "user": user, "is_admin": admin_now})),
    )
        .into_response())
}

async fn member_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((team, user)): Path<(i64, i64)>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    let access = team_access(&s, &p, team).await?;
    let access = access
        .filter(|a| a.member)
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if user != p.user.id && !access.admin {
        return Err(forbidden(
            "You do not have the permission to kick other users from this team.",
        ));
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let n = sqlx::query("DELETE FROM users_teammembership WHERE team_id = $1 AND user_id = $2")
        .bind(team)
        .bind(user)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?
        .rows_affected();
    if n == 0 {
        return Err(ApiError::not_found("The user is not in the team."));
    }
    let left: i64 =
        sqlx::query_scalar("SELECT count(*) FROM users_teammembership WHERE team_id = $1")
            .bind(team)
            .fetch_one(&mut *tx)
            .await
            .map_err(db_err)?;
    if left == 0 {
        end_team(&mut tx, team).await?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

// ---------------------------------------------------------------------------------------------------------
// users
// ---------------------------------------------------------------------------------------------------------

/// Guards shared by the user endpoints: the target exists, is not the caller, and a superuser is only touched by superusers.
async fn target(
    s: &AppState,
    p: &Principal,
    id: i64,
    self_message: &str,
    superuser_message: &str,
) -> ApiResult<users::DbUser> {
    let t = users::user_by_id(&s.pool, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if t.id == p.user.id {
        return Err(ApiError::detail(StatusCode::BAD_REQUEST, self_message));
    }
    if t.is_superuser && !p.user.is_superuser {
        return Err(forbidden(superuser_message));
    }
    Ok(t)
}

pub async fn user_patch(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PATCH).await?)?;
    if !p.user.is_staff {
        return Err(forbidden("Staff permission required."));
    }
    let d = object(&body)?;
    let t = users::user_by_id(&s.pool, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    if t.is_superuser && !p.user.is_superuser {
        return Err(forbidden("Only superusers may modify superusers."));
    }
    let text = |k: &str, max: usize| -> ApiResult<Option<String>> {
        match d.get(k) {
            None => Ok(None),
            Some(Value::String(v)) if v.trim().chars().count() <= max => {
                Ok(Some(v.trim().to_string()))
            }
            Some(_) => Err(field_err(k, &format!("At most {max} characters."))),
        }
    };
    let (first, last, email, username) = (
        text("first_name", 150)?,
        text("last_name", 150)?,
        text("email", 254)?,
        text("username", 150)?,
    );
    if email
        .as_ref()
        .is_some_and(|e| !e.is_empty() && !e.contains('@'))
    {
        return Err(field_err("email", "Invalid email address."));
    }
    if username.as_ref().is_some_and(|u| u.is_empty()) {
        return Err(field_err("username", "This field may not be blank."));
    }
    if let Some(u) = &username {
        let taken: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM users_user WHERE username = $1 AND id <> $2)",
        )
        .bind(u)
        .bind(id)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
        if taken {
            return Err(field_err(
                "username",
                "A user with that username already exists.",
            ));
        }
    }
    let frontend = match d.get("frontend") {
        None => None,
        Some(Value::Number(n)) if matches!(n.as_i64(), Some(1..=3)) => n.as_i64(),
        Some(_) => return Err(field_err("frontend", "Must be 1, 2 or 3.")),
    };
    let active = flag(d.get("is_active"));
    let staff = flag(d.get("is_staff"));
    let site_admin_flag = flag(d.get("is_site_admin"));
    let read_only_flag = flag(d.get("read_only"));
    if read_only_flag.is_some() {
        if id == p.user.id {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "You cannot change your own read-only status.",
            ));
        }
        if !users::is_site_admin(&s.pool, p.user.id).await? {
            return Err(forbidden("Site admin permission required."));
        }
    }
    if site_admin_flag.is_some() {
        if id == p.user.id {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "You cannot change your own administrator status here.",
            ));
        }
        if !p.user.is_superuser {
            return Err(forbidden("Only superusers may make users administrators."));
        }
    }
    if active.is_some() {
        if id == p.user.id {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "You cannot deactivate your own account.",
            ));
        }
        if !users::is_site_admin(&s.pool, p.user.id).await? {
            return Err(forbidden("Site admin permission required."));
        }
        if active == Some(false) && users::is_site_admin(&s.pool, id).await? {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "You cannot deactivate site admin accounts.",
            ));
        }
    }
    if staff.is_some() {
        if id == p.user.id {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "You cannot change your own staff status here.",
            ));
        }
        if !p.user.is_superuser {
            return Err(forbidden("Only superusers may change staff status."));
        }
    }
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    sqlx::query(
        "UPDATE users_user SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name), \
         email = COALESCE($4, email), username = COALESCE($5, username), is_active = COALESCE($6, is_active), \
         is_staff = COALESCE($7, is_staff) WHERE id = $1",
    )
    .bind(id)
    .bind(first)
    .bind(last)
    .bind(email)
    .bind(username)
    .bind(active)
    .bind(staff)
    .execute(&mut *tx)
    .await
    .map_err(db_err)?;
    if let Some(f) = frontend {
        sqlx::query("UPDATE users_userpreferences SET frontend = $2 WHERE user_id = $1")
            .bind(id)
            .bind(f as i32)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    if let Some(r) = read_only_flag {
        sqlx::query(
            "INSERT INTO exact_rust_user_flags (user_id, read_only) VALUES ($1, $2)
             ON CONFLICT (user_id) DO UPDATE SET read_only = $2",
        )
        .bind(id)
        .bind(r)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    }
    if let Some(a) = site_admin_flag {
        sqlx::query(
            "INSERT INTO users_userpreferences (user_id, frontend, is_site_admin) VALUES ($1, 2, $2)
             ON CONFLICT (user_id) DO UPDATE SET is_site_admin = $2",
        )
        .bind(id)
        .bind(a)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(Json(serialized(&s, &p, &headers, "User", id).await?).into_response())
}

/// `GET /api/v2/admin/roles` (site admins): the ids of the users who are site admins and of those who are read only (neither flag is part of
/// the user resource).
async fn roles(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    site_admin(&s, &p).await?;
    let ids: Vec<i64> = sqlx::query_scalar(
        "SELECT user_id FROM users_userpreferences WHERE is_site_admin ORDER BY user_id",
    )
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let read_only: Vec<i64> = sqlx::query_scalar(
        "SELECT user_id FROM exact_rust_user_flags WHERE read_only ORDER BY user_id",
    )
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(Json(json!({"site_admin_ids": ids, "read_only_ids": read_only})).into_response())
}

async fn site_admin(s: &AppState, p: &Principal) -> ApiResult<()> {
    if users::is_site_admin(&s.pool, p.user.id).await? {
        Ok(())
    } else {
        Err(forbidden("Site admin permission required."))
    }
}

pub async fn user_delete(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    site_admin(&s, &p).await?;
    target(
        &s,
        &p,
        id,
        "You cannot delete your own account.",
        "Only superusers may delete superusers.",
    )
    .await?;
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    cascade::delete_users(&mut tx, &[id]).await?;
    tx.commit().await.map_err(db_err)?;
    Ok(StatusCode::NO_CONTENT.into_response())
}

/// `GET /api/v2/admin/me`: what the administration screens may offer this user.
async fn admin_me(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let site = users::is_site_admin(&s.pool, p.user.id).await?;
    let teams = users::admin_team_ids(&s.pool, p.user.id).await?;
    // the model permissions that decide who may edit products and annotation types (Django's `DjangoModelPermissions`)
    let mut perms = Map::new();
    for (app, codename) in [
        ("administration", "add_product"),
        ("administration", "change_product"),
        ("administration", "delete_product"),
        ("annotations", "add_annotationtype"),
        ("annotations", "change_annotationtype"),
        ("annotations", "delete_annotationtype"),
    ] {
        let has = users::has_perm(&s.pool, &p.user, app, codename).await?;
        perms.insert(codename.to_string(), Value::Bool(has));
    }
    Ok(Json(json!({"is_site_admin": site, "is_staff": p.user.is_staff, "is_superuser": p.user.is_superuser, "admin_team_ids": teams, "perms": perms})).into_response())
}

/// `GET /api/v2/admin/users/{id}/profile`: the editable personal fields of a user (the user list of the API does not
/// carry them).
async fn user_profile(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    site_admin(&s, &p).await?;
    let row: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT username, first_name, last_name, email FROM users_user WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&s.pool)
    .await
    .map_err(db_err)?;
    let (username, first_name, last_name, email) =
        row.ok_or_else(|| ApiError::not_found("Not found."))?;
    Ok(Json(json!({"id": id, "username": username, "first_name": first_name, "last_name": last_name, "email": email})).into_response())
}

async fn random_password(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    site_admin(&s, &p).await?;
    target(
        &s,
        &p,
        id,
        "You cannot set a random password for your own account.",
        "Only superusers may change passwords for superusers.",
    )
    .await?;
    let password = exact_auth::tokens::random_token(24);
    sqlx::query("UPDATE users_user SET password = $2 WHERE id = $1")
        .bind(id)
        .bind(make_password(&password))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(Json(json!({"password": password})).into_response())
}

// ---------------------------------------------------------------------------------------------------------
// model permissions and service accounts
// ---------------------------------------------------------------------------------------------------------

/// The apps whose permissions are offered. `view_*` is left out: reading is not decided by a model permission here.
const PERMISSION_APPS: [&str; 4] = ["administration", "annotations", "images", "processing"];

struct Preset {
    id: &'static str,
    label: &'static str,
    description: &'static str,
    permissions: &'static [&'static str],
}

const PRESETS: &[Preset] = &[
    Preset {
        id: "registration_worker",
        label: "Registration worker",
        description: "helpers/queue_worker.py: announces its registration plugin, takes registration jobs and stores the registrations. Add the account to the teams whose images it should serve.",
        permissions: &[
            "processing.add_plugin",
            "processing.change_pluginjob",
            "images.change_imageregistration",
        ],
    },
    Preset {
        id: "analysis_worker",
        label: "Analysis worker (ML plugin)",
        description: "A QueueRunner or exact-sync script: announces its plugin, takes analysis jobs, reports progress and stores results and annotations. Adjust the list if your plugin does more. Add the account to the teams whose images it should serve.",
        permissions: &[
            "processing.add_plugin",
            "processing.change_pluginjob",
            "processing.add_pluginresult",
            "processing.add_pluginresultentry",
            "processing.add_pluginresultannotation",
            "processing.add_pluginresultbitmap",
            "annotations.add_annotation",
        ],
    },
];

async fn superuser(s: &AppState, headers: &HeaderMap, method: &Method) -> ApiResult<Principal> {
    let p = require_user(authenticate(s, headers, method).await?)?;
    if !p.user.is_superuser {
        return Err(forbidden("Superuser permission required."));
    }
    Ok(p)
}

/// `app.codename` of every permission on offer, with what the interface needs to list them.
async fn catalog_rows(s: &AppState) -> ApiResult<Vec<(String, String, String, String)>> {
    let apps: Vec<String> = PERMISSION_APPS.iter().map(|a| a.to_string()).collect();
    sqlx::query_as(
        "SELECT ct.app_label, ct.model, p.codename, p.name
           FROM auth_permission p JOIN django_content_type ct ON ct.id = p.content_type_id
          WHERE ct.app_label = ANY($1) AND left(p.codename, 5) <> 'view_'
          ORDER BY ct.app_label, ct.model, p.codename",
    )
    .bind(&apps)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)
}

async fn permission_catalog(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    superuser(&s, &headers, &Method::GET).await?;
    let permissions: Vec<Value> = catalog_rows(&s)
        .await?
        .into_iter()
        .map(|(app, model, codename, name)| json!({"key": format!("{app}.{codename}"), "app": app, "model": model, "codename": codename, "name": name}))
        .collect();
    let presets: Vec<Value> = PRESETS
        .iter()
        .map(|p| json!({"id": p.id, "label": p.label, "description": p.description, "permissions": p.permissions}))
        .collect();
    Ok(Json(json!({"permissions": permissions, "presets": presets})).into_response())
}

async fn permission_state(s: &AppState, id: i64) -> ApiResult<Value> {
    let t = users::user_by_id(&s.pool, id)
        .await?
        .ok_or_else(|| ApiError::not_found("Not found."))?;
    let apps: Vec<String> = PERMISSION_APPS.iter().map(|a| a.to_string()).collect();
    let direct: Vec<String> = sqlx::query_scalar(
        "SELECT ct.app_label || '.' || p.codename
           FROM users_user_user_permissions up
           JOIN auth_permission p ON p.id = up.permission_id
           JOIN django_content_type ct ON ct.id = p.content_type_id
          WHERE up.user_id = $1 AND ct.app_label = ANY($2) AND left(p.codename, 5) <> 'view_'
          ORDER BY 1",
    )
    .bind(id)
    .bind(&apps)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let groups: Vec<(String, Vec<String>)> = sqlx::query_as(
        "SELECT g.name, COALESCE(array_agg(ct.app_label || '.' || p.codename ORDER BY ct.app_label, p.codename)
                                  FILTER (WHERE p.id IS NOT NULL AND ct.app_label = ANY($2) AND left(p.codename, 5) <> 'view_'), '{}')
           FROM users_user_groups ug
           JOIN auth_group g ON g.id = ug.group_id
           LEFT JOIN auth_group_permissions gp ON gp.group_id = g.id
           LEFT JOIN auth_permission p ON p.id = gp.permission_id
           LEFT JOIN django_content_type ct ON ct.id = p.content_type_id
          WHERE ug.user_id = $1
          GROUP BY g.name ORDER BY g.name",
    )
    .bind(id)
    .bind(&apps)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(json!({
        "id": t.id,
        "username": t.username,
        "is_superuser": t.is_superuser,
        "direct": direct,
        "groups": groups.into_iter().map(|(name, permissions)| json!({"name": name, "permissions": permissions})).collect::<Vec<_>>(),
    }))
}

async fn user_permissions_get(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> ApiResult<Response> {
    superuser(&s, &headers, &Method::GET).await?;
    Ok(Json(permission_state(&s, id).await?).into_response())
}

/// Keys of `d["permissions"]`, each one of the permissions on offer.
async fn requested_permissions(s: &AppState, d: &Map<String, Value>) -> ApiResult<Vec<String>> {
    let Some(list) = d.get("permissions") else {
        return Ok(vec![]);
    };
    let Value::Array(items) = list else {
        return Err(field_err("permissions", "Expected a list."));
    };
    let known: std::collections::HashSet<String> = catalog_rows(s)
        .await?
        .into_iter()
        .map(|(app, _, codename, _)| format!("{app}.{codename}"))
        .collect();
    let mut out: Vec<String> = vec![];
    for v in items {
        let Some(k) = v.as_str() else {
            return Err(field_err("permissions", "Expected permission names."));
        };
        if !known.contains(k) {
            return Err(field_err(
                "permissions",
                &format!("Unknown permission: {k}"),
            ));
        }
        if !out.iter().any(|o| o == k) {
            out.push(k.to_string());
        }
    }
    Ok(out)
}

async fn set_permissions(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    id: i64,
    keys: &[String],
) -> ApiResult<()> {
    let apps: Vec<String> = PERMISSION_APPS.iter().map(|a| a.to_string()).collect();
    sqlx::query(
        "DELETE FROM users_user_user_permissions up
          USING auth_permission p, django_content_type ct
          WHERE up.user_id = $1 AND p.id = up.permission_id AND ct.id = p.content_type_id
            AND ct.app_label = ANY($2) AND left(p.codename, 5) <> 'view_'",
    )
    .bind(id)
    .bind(&apps)
    .execute(&mut **tx)
    .await
    .map_err(db_err)?;
    sqlx::query(
        "INSERT INTO users_user_user_permissions (user_id, permission_id)
         SELECT $1, p.id FROM auth_permission p JOIN django_content_type ct ON ct.id = p.content_type_id
          WHERE ct.app_label || '.' || p.codename = ANY($2)
         ON CONFLICT DO NOTHING",
    )
    .bind(id)
    .bind(keys)
    .execute(&mut **tx)
    .await
    .map_err(db_err)?;
    Ok(())
}

async fn user_permissions_put(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = superuser(&s, &headers, &Method::PUT).await?;
    target(
        &s,
        &p,
        id,
        "You cannot change the permissions of your own account.",
        "Only superusers may change the permissions of superusers.",
    )
    .await?;
    let d = object(&body)?;
    let keys = requested_permissions(&s, &d).await?;
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    set_permissions(&mut tx, id, &keys).await?;
    tx.commit().await.map_err(db_err)?;
    tracing::info!(by = %p.user.username, user = id, permissions = ?keys, "permissions set");
    Ok(Json(permission_state(&s, id).await?).into_response())
}

/// A new account, for a person or for a service (a worker): active, no staff rights, a random password that is answered once, names and
/// e-mail, team memberships, the read-only flag. Site admins create accounts; permissions and presets are for superusers.
async fn user_create(
    State(s): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::POST).await?)?;
    site_admin(&s, &p).await?;
    let d = object(&body)?;
    if (d.contains_key("preset") || d.contains_key("permissions")) && !p.user.is_superuser {
        return Err(forbidden("Only superusers may give permissions."));
    }
    let username = d
        .get("username")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if username.is_empty() || username.chars().count() > 150 {
        return Err(field_err(
            "username",
            "Enter a username of at most 150 characters.",
        ));
    }
    if !username
        .chars()
        .all(|c| c.is_alphanumeric() || "@.+-_".contains(c))
    {
        return Err(field_err("username", "Letters, digits and @ . + - _ only."));
    }
    let text = |k: &str, max: usize| -> ApiResult<String> {
        let v = d
            .get(k)
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("");
        if v.chars().count() > max {
            return Err(field_err(k, &format!("At most {max} characters.")));
        }
        Ok(v.to_string())
    };
    let email = text("email", 254)?;
    let first_name = text("first_name", 150)?;
    let last_name = text("last_name", 150)?;
    let read_only = flag(d.get("read_only")).unwrap_or(false);
    let mut keys = requested_permissions(&s, &d).await?;
    if let Some(id) = d.get("preset").and_then(Value::as_str) {
        let Some(preset) = PRESETS.iter().find(|p| p.id == id) else {
            return Err(field_err("preset", "Unknown preset."));
        };
        for k in preset.permissions {
            if !keys.iter().any(|o| o == k) {
                keys.push(k.to_string());
            }
        }
    }
    let teams: Vec<i64> = match d.get("teams") {
        None => vec![],
        Some(Value::Array(a)) => a.iter().filter_map(Value::as_i64).collect(),
        Some(_) => return Err(field_err("teams", "Expected a list of team ids.")),
    };
    let password = exact_auth::tokens::random_token(24);
    let mut tx = s.pool.begin().await.map_err(db_err)?;
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO users_user (password, last_login, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined, points)
         VALUES ($1, NULL, false, $2, $4, $5, $3, false, true, now(), 0) RETURNING id",
    )
    .bind(make_password(&password))
    .bind(username)
    .bind(email)
    .bind(first_name)
    .bind(last_name)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| match e {
        sqlx::Error::Database(db) if db.is_unique_violation() => {
            field_err("username", "A user with that username already exists.")
        }
        other => db_err(other),
    })?;
    sqlx::query("INSERT INTO users_userpreferences (user_id, frontend, is_site_admin) VALUES ($1, 2, false)")
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?;
    let joined = sqlx::query("INSERT INTO users_teammembership (team_id, user_id, is_admin) SELECT t.id, $2, false FROM users_team t WHERE t.id = ANY($1)")
        .bind(&teams)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(db_err)?
        .rows_affected();
    set_permissions(&mut tx, id, &keys).await?;
    if read_only {
        sqlx::query("INSERT INTO exact_rust_user_flags (user_id, read_only) VALUES ($1, true) ON CONFLICT (user_id) DO UPDATE SET read_only = true")
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    tracing::info!(by = %p.user.username, user = %username, permissions = ?keys, teams = joined, read_only, "account created");
    Ok((
        StatusCode::CREATED,
        Json(json!({"id": id, "username": username, "password": password, "permissions": keys, "teams": joined, "read_only": read_only})),
    )
        .into_response())
}
