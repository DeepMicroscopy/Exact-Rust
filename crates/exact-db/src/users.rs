//! Users, teams, memberships, personal access tokens and Django model permissions
//! (tables of the Django `users` and `auth` apps; read through the existing schema).

use crate::internal;
use chrono::{DateTime, Utc};
use exact_core::Result;
use sqlx::{PgPool, Postgres, QueryBuilder};
use std::collections::HashMap;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DbUser {
    pub id: i64,
    pub password: String,
    pub last_login: Option<DateTime<Utc>>,
    pub is_superuser: bool,
    pub username: String,
    pub is_staff: bool,
    pub is_active: bool,
    /// May look, not change (`exact_rust_user_flags`): every write is refused for the account.
    pub read_only: bool,
}

const USER_COLS: &str = "id, password, last_login, is_superuser, username, is_staff, is_active, \
     COALESCE((SELECT f.read_only FROM exact_rust_user_flags f WHERE f.user_id = users_user.id), false) AS read_only";

pub async fn user_by_username(pool: &PgPool, username: &str) -> Result<Option<DbUser>> {
    sqlx::query_as(&format!(
        "SELECT {USER_COLS} FROM users_user WHERE username = $1"
    ))
    .bind(username)
    .fetch_optional(pool)
    .await
    .map_err(internal)
}

pub async fn user_by_id(pool: &PgPool, id: i64) -> Result<Option<DbUser>> {
    sqlx::query_as(&format!("SELECT {USER_COLS} FROM users_user WHERE id = $1"))
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(internal)
}

/// Sets or clears the read-only flag of a user.
pub async fn set_read_only(pool: &PgPool, id: i64, read_only: bool) -> Result<()> {
    sqlx::query(
        "INSERT INTO exact_rust_user_flags (user_id, read_only) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET read_only = $2",
    )
    .bind(id)
    .bind(read_only)
    .execute(pool)
    .await
    .map_err(internal)?;
    Ok(())
}

pub async fn touch_last_login(pool: &PgPool, id: i64) -> Result<()> {
    sqlx::query("UPDATE users_user SET last_login = now() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await
        .map_err(internal)?;
    Ok(())
}

/// `UserPreferences.is_site_admin` (gates user administration and impersonation in Django).
pub async fn is_site_admin(pool: &PgPool, user_id: i64) -> Result<bool> {
    let v: Option<bool> =
        sqlx::query_scalar("SELECT is_site_admin FROM users_userpreferences WHERE user_id = $1")
            .bind(user_id)
            .fetch_optional(pool)
            .await
            .map_err(internal)?;
    Ok(v.unwrap_or(false))
}

/// Teams in which the user is a team admin.
pub async fn admin_team_ids(pool: &PgPool, user_id: i64) -> Result<Vec<i64>> {
    sqlx::query_scalar(
        "SELECT team_id FROM users_teammembership WHERE user_id = $1 AND is_admin ORDER BY team_id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(internal)
}

/// How many of the given team ids exist.
pub async fn count_teams(pool: &PgPool, ids: &[i64]) -> Result<i64> {
    sqlx::query_scalar("SELECT count(*) FROM users_team WHERE id = ANY($1)")
        .bind(ids)
        .fetch_one(pool)
        .await
        .map_err(internal)
}

// ---- personal access tokens -------------------------------------------------------------------

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct DbPat {
    pub id: i64,
    pub user_id: i64,
    pub token_hash: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub read_only: bool,
}

impl DbPat {
    /// Same rule as `PersonalAccessToken.is_active`.
    pub fn is_active(&self, now: DateTime<Utc>) -> bool {
        self.revoked_at.is_none() && self.expires_at.is_none_or(|e| e > now)
    }
}

pub async fn pats_by_prefix(pool: &PgPool, prefix: &str) -> Result<Vec<DbPat>> {
    sqlx::query_as("SELECT id, user_id, token_hash, expires_at, revoked_at, read_only FROM users_personalaccesstoken WHERE prefix = $1")
        .bind(prefix)
        .fetch_all(pool)
        .await
        .map_err(internal)
}

/// Teams a token is restricted to; empty = unrestricted.
pub async fn pat_team_ids(pool: &PgPool, pat_id: i64) -> Result<Vec<i64>> {
    sqlx::query_scalar("SELECT team_id FROM users_personalaccesstoken_teams WHERE personalaccesstoken_id = $1 ORDER BY team_id")
        .bind(pat_id)
        .fetch_all(pool)
        .await
        .map_err(internal)
}

pub async fn touch_pat(pool: &PgPool, pat_id: i64) -> Result<()> {
    sqlx::query("UPDATE users_personalaccesstoken SET last_used_at = now() WHERE id = $1")
        .bind(pat_id)
        .execute(pool)
        .await
        .map_err(internal)?;
    Ok(())
}

// ---- Django model permissions -------------------------------------------------------------------

/// `User.has_perm("app_label.codename")` for an active user: superusers have everything, others need the
/// permission directly or through a group.
pub async fn has_perm(
    pool: &PgPool,
    user: &DbUser,
    app_label: &str,
    codename: &str,
) -> Result<bool> {
    if !user.is_active {
        return Ok(false);
    }
    if user.is_superuser {
        return Ok(true);
    }
    sqlx::query_scalar(
        "SELECT EXISTS (
           SELECT 1 FROM users_user_user_permissions up
             JOIN auth_permission p ON p.id = up.permission_id
             JOIN django_content_type ct ON ct.id = p.content_type_id
            WHERE up.user_id = $1 AND ct.app_label = $2 AND p.codename = $3
           UNION ALL
           SELECT 1 FROM users_user_groups ug
             JOIN auth_group_permissions gp ON gp.group_id = ug.group_id
             JOIN auth_permission p ON p.id = gp.permission_id
             JOIN django_content_type ct ON ct.id = p.content_type_id
            WHERE ug.user_id = $1 AND ct.app_label = $2 AND p.codename = $3)",
    )
    .bind(user.id)
    .bind(app_label)
    .bind(codename)
    .fetch_one(pool)
    .await
    .map_err(internal)
}

// ---- list/retrieve for the users / teams / team_membership resources ----------------------------

#[derive(Debug, Clone, Default)]
pub struct UserFilter {
    pub id: Option<i64>,
    pub username: Option<String>,
    pub username_contains: Option<String>,
    pub is_superuser: Option<bool>,
    pub is_staff: Option<bool>,
    pub is_active: Option<bool>,
    pub team: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct TeamFilter {
    pub id: Option<i64>,
    pub name: Option<String>,
    pub name_contains: Option<String>,
    pub members: Option<i64>,
    pub image_sets: Option<i64>,
    pub memberships: Option<i64>,
}

#[derive(Debug, Clone, Default)]
pub struct MembershipFilter {
    pub id: Option<i64>,
    pub is_admin: Option<bool>,
    pub team: Option<i64>,
    pub user: Option<i64>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub is_superuser: bool,
    pub is_staff: bool,
    pub is_active: bool,
    pub last_login: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct TeamRow {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct MembershipRow {
    pub id: i64,
    pub is_admin: bool,
    pub team_id: i64,
    pub user_id: i64,
}

/// Django `contains` lookup: case-sensitive substring, wildcards escaped.
fn like_contains(s: &str) -> String {
    format!(
        "%{}%",
        s.replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    )
}

/// The requesting user as far as team visibility goes: `User.team_set` in Django is narrowed to the
/// teams of a team-restricted personal access token (see `exact.users.apps.ScopedTeamSet`).
#[derive(Debug, Clone)]
pub struct Viewer {
    pub id: i64,
    pub token_teams: Option<Vec<i64>>,
}

fn viewer_teams(qb: &mut QueryBuilder<'_, Postgres>, viewer: &Viewer) {
    qb.push("(SELECT team_id FROM users_teammembership WHERE user_id = ")
        .push_bind(viewer.id);
    if let Some(t) = &viewer.token_teams {
        qb.push(" AND team_id = ANY(")
            .push_bind(t.clone())
            .push(")");
    }
    qb.push(")");
}

/// Users sharing a team with the viewer (`User.objects.filter(team__in=user.team_set.all()).distinct()`).
pub async fn list_users(
    pool: &PgPool,
    viewer: &Viewer,
    f: &UserFilter,
    limit: i64,
    offset: i64,
) -> Result<(i64, Vec<UserRow>)> {
    let build = |qb: &mut QueryBuilder<'_, Postgres>| {
        qb.push(" FROM users_user u WHERE u.id IN (SELECT m.user_id FROM users_teammembership m WHERE m.team_id IN ");
        viewer_teams(qb, viewer);
        qb.push(")");
        if let Some(v) = f.id {
            qb.push(" AND u.id = ").push_bind(v);
        }
        if let Some(v) = &f.username {
            qb.push(" AND u.username = ").push_bind(v.clone());
        }
        if let Some(v) = &f.username_contains {
            qb.push(" AND u.username LIKE ")
                .push_bind(like_contains(v))
                .push(" ESCAPE '\\'");
        }
        if let Some(v) = f.is_superuser {
            qb.push(" AND u.is_superuser = ").push_bind(v);
        }
        if let Some(v) = f.is_staff {
            qb.push(" AND u.is_staff = ").push_bind(v);
        }
        if let Some(v) = f.is_active {
            qb.push(" AND u.is_active = ").push_bind(v);
        }
        if let Some(v) = f.team {
            qb.push(" AND u.id IN (SELECT user_id FROM users_teammembership WHERE team_id = ")
                .push_bind(v)
                .push(")");
        }
    };
    let mut c = QueryBuilder::new("SELECT count(*)");
    build(&mut c);
    let count: i64 = c
        .build_query_scalar()
        .fetch_one(pool)
        .await
        .map_err(internal)?;
    let mut q = QueryBuilder::new(
        "SELECT u.id, u.username, u.is_superuser, u.is_staff, u.is_active, u.last_login",
    );
    build(&mut q);
    q.push(" ORDER BY u.id LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    Ok((
        count,
        q.build_query_as().fetch_all(pool).await.map_err(internal)?,
    ))
}

pub async fn list_teams(
    pool: &PgPool,
    viewer: &Viewer,
    f: &TeamFilter,
    limit: i64,
    offset: i64,
) -> Result<(i64, Vec<TeamRow>)> {
    let build = |qb: &mut QueryBuilder<'_, Postgres>| {
        qb.push(" FROM users_team t WHERE t.id IN ");
        viewer_teams(qb, viewer);
        if let Some(v) = f.id {
            qb.push(" AND t.id = ").push_bind(v);
        }
        if let Some(v) = &f.name {
            qb.push(" AND t.name = ").push_bind(v.clone());
        }
        if let Some(v) = &f.name_contains {
            qb.push(" AND t.name LIKE ")
                .push_bind(like_contains(v))
                .push(" ESCAPE '\\'");
        }
        if let Some(v) = f.members {
            qb.push(" AND t.id IN (SELECT team_id FROM users_teammembership WHERE user_id = ")
                .push_bind(v)
                .push(")");
        }
        if let Some(v) = f.image_sets {
            qb.push(" AND t.id IN (SELECT team_id FROM images_imageset WHERE id = ")
                .push_bind(v)
                .push(")");
        }
        if let Some(v) = f.memberships {
            qb.push(" AND t.id IN (SELECT team_id FROM users_teammembership WHERE id = ")
                .push_bind(v)
                .push(")");
        }
    };
    let mut c = QueryBuilder::new("SELECT count(*)");
    build(&mut c);
    let count: i64 = c
        .build_query_scalar()
        .fetch_one(pool)
        .await
        .map_err(internal)?;
    let mut q = QueryBuilder::new("SELECT t.id, t.name");
    build(&mut q);
    q.push(" ORDER BY t.id LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    Ok((
        count,
        q.build_query_as().fetch_all(pool).await.map_err(internal)?,
    ))
}

pub async fn list_memberships(
    pool: &PgPool,
    viewer: &Viewer,
    f: &MembershipFilter,
    limit: i64,
    offset: i64,
) -> Result<(i64, Vec<MembershipRow>)> {
    let build = |qb: &mut QueryBuilder<'_, Postgres>| {
        qb.push(" FROM users_teammembership m WHERE m.team_id IN ");
        viewer_teams(qb, viewer);
        if let Some(v) = f.id {
            qb.push(" AND m.id = ").push_bind(v);
        }
        if let Some(v) = f.is_admin {
            qb.push(" AND m.is_admin = ").push_bind(v);
        }
        if let Some(v) = f.team {
            qb.push(" AND m.team_id = ").push_bind(v);
        }
        if let Some(v) = f.user {
            qb.push(" AND m.user_id = ").push_bind(v);
        }
    };
    let mut c = QueryBuilder::new("SELECT count(*)");
    build(&mut c);
    let count: i64 = c
        .build_query_scalar()
        .fetch_one(pool)
        .await
        .map_err(internal)?;
    let mut q = QueryBuilder::new("SELECT m.id, m.is_admin, m.team_id, m.user_id");
    build(&mut q);
    q.push(" ORDER BY m.id LIMIT ")
        .push_bind(limit)
        .push(" OFFSET ")
        .push_bind(offset);
    Ok((
        count,
        q.build_query_as().fetch_all(pool).await.map_err(internal)?,
    ))
}

// ---- related id lists (batched per page) ---------------------------------------------------------

async fn id_map(pool: &PgPool, sql: &str, ids: &[i64]) -> Result<HashMap<i64, Vec<i64>>> {
    let rows: Vec<(i64, i64)> = sqlx::query_as(sql)
        .bind(ids)
        .fetch_all(pool)
        .await
        .map_err(internal)?;
    let mut m: HashMap<i64, Vec<i64>> = HashMap::new();
    for (k, v) in rows {
        m.entry(k).or_default().push(v);
    }
    Ok(m)
}

/// user id -> team ids (`team_set`)
pub async fn team_ids_of_users(pool: &PgPool, users: &[i64]) -> Result<HashMap<i64, Vec<i64>>> {
    id_map(pool, "SELECT user_id, team_id FROM users_teammembership WHERE user_id = ANY($1) ORDER BY team_id", users).await
}

/// team id -> member user ids
pub async fn members_of_teams(pool: &PgPool, teams: &[i64]) -> Result<HashMap<i64, Vec<i64>>> {
    id_map(pool, "SELECT team_id, user_id FROM users_teammembership WHERE team_id = ANY($1) ORDER BY user_id", teams).await
}

pub async fn memberships_of_teams(pool: &PgPool, teams: &[i64]) -> Result<HashMap<i64, Vec<i64>>> {
    id_map(
        pool,
        "SELECT team_id, id FROM users_teammembership WHERE team_id = ANY($1) ORDER BY id",
        teams,
    )
    .await
}

pub async fn image_sets_of_teams(pool: &PgPool, teams: &[i64]) -> Result<HashMap<i64, Vec<i64>>> {
    id_map(
        pool,
        "SELECT team_id, id FROM images_imageset WHERE team_id = ANY($1) ORDER BY id",
        teams,
    )
    .await
}

pub async fn products_of_teams(pool: &PgPool, teams: &[i64]) -> Result<HashMap<i64, Vec<i64>>> {
    id_map(
        pool,
        "SELECT team_id, id FROM administration_product WHERE team_id = ANY($1) ORDER BY id",
        teams,
    )
    .await
}

pub async fn users_by_ids(pool: &PgPool, ids: &[i64]) -> Result<Vec<UserRow>> {
    sqlx::query_as("SELECT id, username, is_superuser, is_staff, is_active, last_login FROM users_user WHERE id = ANY($1) ORDER BY id")
        .bind(ids)
        .fetch_all(pool)
        .await
        .map_err(internal)
}

pub async fn teams_by_ids(pool: &PgPool, ids: &[i64]) -> Result<Vec<TeamRow>> {
    sqlx::query_as("SELECT id, name FROM users_team WHERE id = ANY($1) ORDER BY id")
        .bind(ids)
        .fetch_all(pool)
        .await
        .map_err(internal)
}

pub async fn memberships_by_ids(pool: &PgPool, ids: &[i64]) -> Result<Vec<MembershipRow>> {
    sqlx::query_as("SELECT id, is_admin, team_id, user_id FROM users_teammembership WHERE id = ANY($1) ORDER BY id")
        .bind(ids)
        .fetch_all(pool)
        .await
        .map_err(internal)
}
