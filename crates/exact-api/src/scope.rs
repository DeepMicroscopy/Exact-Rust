//! What a limited personal access token may do. A token has the scope "look" always (every GET); on top of it a token can be given any of
//!
//! - `jobs`: queue, restart and cancel analyses, registrations and segmentations (and register by points),
//! - `annotate`: create, change, verify and delete annotations and their files, edit segmentations, screening progress,
//! - `images`: upload, rename, move, crop and delete images, create and change image sets (tags, products, settings, files).
//!
//! A token without scopes (all tokens EXACT made) is not limited. A limited one is refused every write that is not named here, which
//! includes everything that manages accounts, teams, annotation types, products, plugins and workers: those need an unlimited token.
//! The check is one layer over the whole router, because it needs the path and the method, which the authentication does not see.

use crate::{error::ApiError, AppState};
use axum::{
    extract::{Request, State},
    http::{header, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use exact_auth::tokens;

pub const SCOPES: [&str; 3] = ["jobs", "annotate", "images"];

/// The scope a write to this path needs; `None`: no scope allows it.
pub fn needed(method: &Method, path: &str) -> Option<&'static str> {
    let p = path.trim_matches('/');
    let seg: Vec<&str> = p.split('/').collect();
    let post = *method == Method::POST;
    Some(match seg.as_slice() {
        // jobs
        ["api", "v2", "images", _, "analyze" | "register" | "auto-segment"] if post => "jobs",
        ["api", "v2", "jobs", _, _, "restart"] if post => "jobs",
        ["api", "v2", "jobs", _, _] if *method == Method::DELETE => "jobs",
        ["api", "v2", "registrations", ..] => "jobs",
        ["api", "v1", "images", "images", _, "register_images"] => "jobs",
        ["api", "v1", "images", "registration", ..] => "jobs",
        // annotations
        ["api", "v2", "annotations", ..]
        | ["api", "v2", "annotation-media-files", ..]
        | ["api", "v2", "segmentation", ..]
        | ["api", "v2", "images", _, "screening" | "convert-to-segmentation"]
        | ["api", "v1", "annotations", "annotations", ..]
        | ["annotations", "api", ..] => "annotate",
        // images and image sets
        ["api", "v2", "image-sets", ..]
        | ["api", "v2", "auxiliary-files", ..]
        | ["api", "v2", "linked-volumes", ..]
        | ["api", "v2", "images", _]
        | ["api", "v2", "images", _, "move" | "rename" | "crop" | "linked-volumes"]
        | ["api", "v1", "images", ..]
        | ["images", "api", ..]
        | ["images", "image", ..] => "images",
        _ => return None,
    })
}

/// Whether a token with these scopes may make this request.
pub fn allows(scopes: &[String], method: &Method, path: &str) -> bool {
    if matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return true;
    }
    needed(method, path).is_some_and(|n| scopes.iter().any(|s| s == n))
}

/// Middleware: a request with a limited token that goes beyond its scopes is refused (403) before anything runs. Requests without a
/// token, with an unlimited one, with one that does not check out (the authentication answers those), and every read pass.
pub async fn enforce(State(s): State<AppState>, req: Request, next: Next) -> Response {
    if matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(req).await;
    }
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            let (kind, t) = v.split_once(' ')?;
            kind.eq_ignore_ascii_case("bearer").then(|| t.trim().to_string())
        });
    let Some(prefix) = token.as_deref().and_then(tokens::pat_prefix) else {
        return next.run(req).await;
    };
    let rows: Vec<(String, Vec<String>)> = sqlx::query_as(
        "SELECT p.token_hash, sc.scopes FROM users_personalaccesstoken p
         JOIN exact_rust_token_scope sc ON sc.token_id = p.id WHERE p.prefix = $1",
    )
    .bind(prefix)
    .fetch_all(&s.pool)
    .await
    .unwrap_or_default();
    let token = token.unwrap_or_default();
    if let Some((_, scopes)) = rows.iter().find(|(h, _)| tokens::token_matches(&token, h)) {
        if !allows(scopes, req.method(), req.uri().path()) {
            return ApiError::detail(
                StatusCode::FORBIDDEN,
                "This token is limited and may not do this.",
            )
            .into_response();
        }
    }
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(scopes: &[&str], m: Method, p: &str) -> bool {
        allows(&scopes.iter().map(|s| s.to_string()).collect::<Vec<_>>(), &m, p)
    }

    #[test]
    fn reading_is_always_allowed() {
        assert!(ok(&[], Method::GET, "/api/v2/anything"));
        assert!(ok(&["jobs"], Method::GET, "/api/v1/images/images/"));
    }

    #[test]
    fn a_jobs_token_queues_jobs_and_nothing_else() {
        let j = ["jobs"];
        assert!(ok(&j, Method::POST, "/api/v2/images/5/register"));
        assert!(ok(&j, Method::POST, "/api/v2/images/5/analyze"));
        assert!(ok(&j, Method::POST, "/api/v2/images/5/auto-segment"));
        assert!(ok(&j, Method::POST, "/api/v2/jobs/plugin/9/restart"));
        assert!(ok(&j, Method::DELETE, "/api/v2/jobs/plugin/9"));
        assert!(ok(&j, Method::POST, "/api/v2/registrations/manual"));
        assert!(ok(&j, Method::POST, "/api/v1/images/images/5/register_images/"));
        assert!(!ok(&j, Method::POST, "/api/v2/annotations"));
        assert!(!ok(&j, Method::PATCH, "/api/v2/images/5"));
        assert!(!ok(&j, Method::POST, "/api/v2/image-sets/3/images"));
        // worker routes, accounts, tokens and configuration are for nobody who is limited
        for p in ["/api/v2/jobs/claim", "/api/v2/plugin-jobs/3/complete", "/api/v2/registration-jobs/3/fail", "/api/v2/plugins/register",
                  "/api/v2/users/3", "/api/v2/teams/1/members/4", "/api/v2/me/tokens", "/api/v2/me/preferences", "/api/v2/annotation-types",
                  "/api/v2/products/1", "/api/v2/admin/users"] {
            assert!(!ok(&SCOPES, Method::POST, p), "{p}");
            assert!(!ok(&SCOPES, Method::DELETE, p), "{p}");
        }
    }

    #[test]
    fn annotate_and_images_are_separate() {
        assert!(ok(&["annotate"], Method::POST, "/api/v2/annotations"));
        assert!(ok(&["annotate"], Method::PATCH, "/api/v2/annotations/7"));
        assert!(ok(&["annotate"], Method::POST, "/api/v1/annotations/annotations/"));
        assert!(ok(&["annotate"], Method::POST, "/annotations/api/annotation/create/"));
        assert!(!ok(&["annotate"], Method::POST, "/api/v2/image-sets/3/images"));
        assert!(ok(&["images"], Method::POST, "/api/v2/image-sets/3/images"));
        assert!(ok(&["images"], Method::POST, "/images/image/upload/3/"));
        assert!(ok(&["images"], Method::DELETE, "/api/v2/images/5"));
        assert!(ok(&["images"], Method::DELETE, "/api/v2/auxiliary-files/5"));
        assert!(ok(&["images"], Method::POST, "/api/v2/images/5/move"));
        assert!(!ok(&["images"], Method::POST, "/api/v2/annotations"));
        assert!(!ok(&["images"], Method::POST, "/api/v2/images/5/register"));
    }
}
