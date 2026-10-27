//! Authentication in the order of the Django deployment (DRF `DEFAULT_AUTHENTICATION_CLASSES`):
//! personal access token (`Bearer pat_…`) → HTTP Basic → session cookie. Any failing credential is an
//! immediate error (403, like DRF here); no credentials at all yields an anonymous request.

use crate::{error::ApiError, AppState};
use axum::http::{header, HeaderMap, Method};
use base64::{engine::general_purpose::STANDARD, Engine};
use exact_auth::{hashers::verify_password, tokens};
use exact_db::users::{self, DbUser};
use std::collections::BTreeSet;

/// Remembers successful Basic-auth password checks for a short time, so API clients that send credentials with every
/// request do not pay for 600 000 PBKDF2 rounds each time (the single biggest cost of a typical API call).
///
/// The key is an HMAC-like digest of (per-process random secret, username, password), so nothing reusable is kept in
/// memory, and each entry stores the password hash it was verified against: changing the password (or a different
/// hash) invalidates it immediately.
#[derive(Clone)]
pub struct AuthCache {
    secret: [u8; 32],
    entries: Option<moka::sync::Cache<[u8; 32], String>>,
}

impl AuthCache {
    pub fn new(ttl_seconds: u64) -> Self {
        use rand::RngCore;
        let mut secret = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut secret);
        let entries = (ttl_seconds > 0).then(|| {
            moka::sync::Cache::builder()
                .max_capacity(10_000)
                .time_to_live(std::time::Duration::from_secs(ttl_seconds))
                .build()
        });
        Self { secret, entries }
    }

    fn key(&self, username: &str, password: &str) -> [u8; 32] {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(self.secret);
        h.update((username.len() as u64).to_be_bytes());
        h.update(username.as_bytes());
        h.update(password.as_bytes());
        h.finalize().into()
    }

    /// True if this exact (username, password) was verified recently against this exact stored hash.
    fn hit(&self, username: &str, password: &str, stored_hash: &str) -> bool {
        self.entries
            .as_ref()
            .and_then(|c| c.get(&self.key(username, password)))
            .is_some_and(|h| h == stored_hash)
    }

    fn remember(&self, username: &str, password: &str, stored_hash: &str) {
        if let Some(c) = &self.entries {
            c.insert(self.key(username, password), stored_hash.to_string());
        }
    }
}

pub const SESSION_COOKIE: &str = "exact_session";
pub const CSRF_HEADER: &str = "x-csrf-token";

/// Restrictions of a personal access token (`users.scope` in Django).
#[derive(Debug, Clone, Default)]
pub struct TokenScope {
    pub read_only: bool,
    /// None = all teams of the user.
    pub team_ids: Option<BTreeSet<i64>>,
}

#[derive(Debug, Clone)]
pub enum AuthKind {
    Token(TokenScope),
    Basic,
    Session {
        csrf: String,
        /// Real user while an administrator impersonates `Principal::user`.
        impersonator: Option<i64>,
    },
}

#[derive(Debug, Clone)]
pub struct Principal {
    pub user: DbUser,
    pub kind: AuthKind,
}

impl Principal {
    pub fn viewer(&self) -> exact_db::users::Viewer {
        let token_teams = match &self.kind {
            AuthKind::Token(TokenScope {
                team_ids: Some(t), ..
            }) => Some(t.iter().copied().collect()),
            _ => None,
        };
        exact_db::users::Viewer {
            id: self.user.id,
            token_teams,
        }
    }
}

/// Constant-time comparison of the submitted CSRF token with the session's; empty never matches.
fn csrf_ok(sent: &str, expected: &str) -> bool {
    use subtle::ConstantTimeEq;
    !sent.is_empty() && bool::from(sent.as_bytes().ct_eq(expected.as_bytes()))
}

fn safe(m: &Method) -> bool {
    matches!(*m, Method::GET | Method::HEAD | Method::OPTIONS)
}

fn cookie<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|s| s.split(';'))
        .find_map(|kv| {
            let (k, v) = kv.trim().split_once('=')?;
            (k == name).then_some(v)
        })
}

pub async fn authenticate(
    state: &AppState,
    headers: &HeaderMap,
    method: &Method,
) -> Result<Option<Principal>, ApiError> {
    let auth = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let parts: Vec<&str> = auth.split_whitespace().collect();
    match parts.first().map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("bearer") => return token_auth(state, &parts, method).await.map(Some),
        Some("basic") => return basic_auth(state, &parts).await.map(Some),
        _ => {}
    }
    if let Some(key) = cookie(headers, SESSION_COOKIE) {
        if let Some(sess) = exact_db::sessions::lookup(&state.pool, key).await? {
            let (user_id, csrf, impersonator) = (sess.user_id, sess.csrf, sess.impersonator_id);
            if let Some(user) = users::user_by_id(&state.pool, user_id)
                .await?
                .filter(|u| u.is_active)
            {
                if !safe(method) {
                    let sent = headers
                        .get(CSRF_HEADER)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    if !csrf_ok(sent, &csrf) {
                        return Err(ApiError::auth_failed(
                            "CSRF Failed: CSRF token missing or incorrect.",
                        ));
                    }
                }
                return Ok(Some(Principal {
                    user,
                    kind: AuthKind::Session { csrf, impersonator },
                }));
            }
        }
    }
    Ok(None)
}

async fn token_auth(
    state: &AppState,
    parts: &[&str],
    method: &Method,
) -> Result<Principal, ApiError> {
    if parts.len() != 2 {
        return Err(ApiError::auth_failed(
            "Invalid Authorization header format.",
        ));
    }
    let token = parts[1];
    let prefix = match tokens::pat_prefix(token) {
        Some(p) if token.starts_with("pat_") => p,
        _ => return Err(ApiError::auth_failed("Invalid token format.")),
    };
    let candidates = users::pats_by_prefix(&state.pool, prefix).await?;
    let Some(pat) = candidates
        .into_iter()
        .find(|p| tokens::token_matches(token, &p.token_hash))
    else {
        return Err(ApiError::auth_failed("Invalid token."));
    };
    if !pat.is_active(chrono::Utc::now()) {
        return Err(ApiError::auth_failed("Token expired or revoked."));
    }
    if pat.read_only && !safe(method) {
        return Err(ApiError::permission_denied_msg("This token is read-only."));
    }
    // Hardening vs. Django (which accepts tokens of deactivated users): inactive users never authenticate.
    let Some(user) = users::user_by_id(&state.pool, pat.user_id)
        .await?
        .filter(|u| u.is_active)
    else {
        return Err(ApiError::auth_failed("User inactive or deleted."));
    };
    users::touch_pat(&state.pool, pat.id).await?;
    let teams: BTreeSet<i64> = users::pat_team_ids(&state.pool, pat.id)
        .await?
        .into_iter()
        .collect();
    Ok(Principal {
        user,
        kind: AuthKind::Token(TokenScope {
            read_only: pat.read_only,
            team_ids: (!teams.is_empty()).then_some(teams),
        }),
    })
}

/// Fixed hash used to equalize timing for unknown usernames (Django also hashes once in that case).
const DUMMY_HASH: &str =
    "pbkdf2_sha256$600000$dummysaltdummysalt$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

async fn basic_auth(state: &AppState, parts: &[&str]) -> Result<Principal, ApiError> {
    match parts.len() {
        1 => {
            return Err(ApiError::auth_failed(
                "Invalid basic header. No credentials provided.",
            ))
        }
        2 => {}
        _ => {
            return Err(ApiError::auth_failed(
                "Invalid basic header. Credentials string should not contain spaces.",
            ))
        }
    }
    let decoded = STANDARD
        .decode(parts[1])
        .ok()
        .and_then(|b| String::from_utf8(b).ok());
    let Some(decoded) = decoded else {
        return Err(ApiError::auth_failed(
            "Invalid basic header. Credentials not correctly base64 encoded.",
        ));
    };
    let (username, password) = decoded.split_once(':').unwrap_or((&decoded, ""));
    let user = users::user_by_username(&state.pool, username).await?;
    let ok = match &user {
        Some(u) if u.is_active && state.auth_cache.hit(username, password, &u.password) => true,
        Some(u) => {
            let ok = u.is_active && verify_password(password, &u.password);
            if ok {
                state.auth_cache.remember(username, password, &u.password);
            }
            ok
        }
        None => {
            let _ = verify_password(password, DUMMY_HASH);
            false
        }
    };
    match (ok, user) {
        (true, Some(user)) => Ok(Principal {
            user,
            kind: AuthKind::Basic,
        }),
        _ => Err(ApiError::auth_failed("Invalid username/password.")),
    }
}

/// `IsAuthenticated`
pub fn require_user(p: Option<Principal>) -> Result<Principal, ApiError> {
    p.ok_or_else(ApiError::not_authenticated)
}

/// `DjangoModelPermissions`: authenticated; unsafe methods additionally need add/change/delete permission.
pub async fn require_model_perm(
    state: &AppState,
    p: Option<Principal>,
    method: &Method,
    app: &str,
    model: &str,
) -> Result<Principal, ApiError> {
    let p = require_user(p)?;
    let action = match *method {
        Method::POST => "add",
        Method::PUT | Method::PATCH => "change",
        Method::DELETE => "delete",
        _ => return Ok(p),
    };
    if users::has_perm(&state.pool, &p.user, app, &format!("{action}_{model}")).await? {
        Ok(p)
    } else {
        Err(ApiError::permission_denied())
    }
}

impl ApiError {
    pub fn permission_denied_msg(msg: &str) -> Self {
        Self::detail(axum::http::StatusCode::FORBIDDEN, msg)
    }
}

#[cfg(test)]
mod tests {
    use super::{csrf_ok, AuthCache};

    #[test]
    fn auth_cache_is_bound_to_password_and_hash() {
        let c = AuthCache::new(60);
        assert!(!c.hit("u", "pw", "hash1"));
        c.remember("u", "pw", "hash1");
        assert!(c.hit("u", "pw", "hash1"));
        assert!(!c.hit("u", "other", "hash1"), "wrong password never hits");
        assert!(!c.hit("v", "pw", "hash1"), "other user never hits");
        assert!(
            !c.hit("u", "pw", "hash2"),
            "a changed password hash invalidates the entry"
        );
        assert!(
            !AuthCache::new(0).hit("u", "pw", "hash1"),
            "ttl 0 disables the cache"
        );
        let d = AuthCache::new(60);
        d.remember("ab", "c", "h");
        assert!(
            !d.hit("a", "bc", "h"),
            "username/password boundary is unambiguous"
        );
    }

    #[test]
    fn csrf_token_must_match_exactly() {
        assert!(csrf_ok("abc", "abc"));
        assert!(!csrf_ok("", ""));
        assert!(!csrf_ok("abd", "abc"));
        assert!(!csrf_ok("abcd", "abc"));
        assert!(!csrf_ok("", "abc"));
    }
}
