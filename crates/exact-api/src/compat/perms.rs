//! `ImageSet.get_perms(user)` of EXACT: what a user may do in an image set.

use super::engine::db_err;
use crate::{
    auth::{AuthKind, Principal},
    error::ApiResult,
    AppState,
};
use sqlx::Row;

#[derive(Clone, Copy, Default, Debug)]
pub struct Perms {
    pub read: bool,
    pub verify: bool,
    pub annotate: bool,
    pub create_export: bool,
    pub delete_annotation: bool,
    pub delete_export: bool,
    pub delete_set: bool,
    pub delete_images: bool,
    pub edit_annotation: bool,
    pub edit_set: bool,
}

pub struct SetRow {
    pub id: i64,
    pub team_id: Option<i64>,
    pub creator_id: Option<i64>,
    pub public: bool,
    pub public_collaboration: bool,
    pub collaboration_type: i32,
}

pub async fn set_row(s: &AppState, id: i64) -> ApiResult<Option<SetRow>> {
    let r = sqlx::query("SELECT id, team_id, creator_id, public, public_collaboration, collaboration_type FROM images_imageset WHERE id = $1")
        .bind(id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
    Ok(r.map(|r| SetRow {
        id: r.get(0),
        team_id: r.get(1),
        creator_id: r.get(2),
        public: r.get(3),
        public_collaboration: r.get(4),
        collaboration_type: r.get(5),
    }))
}

/// All permissions of the principal in the image set. A token restricted to other teams has none.
pub async fn perms(s: &AppState, p: &Principal, set: &SetRow) -> ApiResult<Perms> {
    let mut out = Perms::default();
    if let (Some(team), AuthKind::Token(scope)) = (set.team_id, &p.kind) {
        if scope.team_ids.as_ref().is_some_and(|t| !t.contains(&team)) {
            return Ok(out);
        }
    }
    if let Some(team) = set.team_id {
        let membership = sqlx::query(
            "SELECT is_admin FROM users_teammembership WHERE team_id = $1 AND user_id = $2",
        )
        .bind(team)
        .bind(p.user.id)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
        let (member, admin) = match membership {
            Some(r) => (true, r.get::<bool, _>(0)),
            None => (false, false),
        };
        let all = |o: &mut Perms| {
            o.verify = true;
            o.annotate = true;
            o.create_export = true;
            o.delete_annotation = true;
            o.delete_export = true;
            o.edit_annotation = true;
            o.edit_set = true;
            o.read = true;
        };
        if admin {
            all(&mut out);
            out.delete_set = true;
            out.delete_images = true;
        }
        if member {
            all(&mut out);
        }
        if set.creator_id == Some(p.user.id) {
            all(&mut out);
            out.delete_set = true;
            out.delete_images = true;
        }
    }
    if set.public {
        out.read = true;
        out.create_export = true;
        if set.public_collaboration {
            out.verify = true;
            out.annotate = true;
            out.delete_annotation = true;
            out.edit_annotation = true;
        }
    }
    Ok(out)
}

/// Permissions in the image set of an image (none if the image does not exist).
pub async fn set_perms_of_image(s: &AppState, p: &Principal, image_id: i64) -> ApiResult<Perms> {
    let set: Option<i64> =
        sqlx::query_scalar("SELECT image_set_id FROM images_image WHERE id = $1")
            .bind(image_id)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?;
    match set {
        Some(set) => match set_row(s, set).await? {
            Some(row) => perms(s, p, &row).await,
            None => Ok(Perms::default()),
        },
        None => Ok(Perms::default()),
    }
}
