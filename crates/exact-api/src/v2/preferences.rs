//! Personal settings of the account: `GET /api/v2/me/preferences` -> `{"legacy_navigation": bool}` and `PUT /api/v2/me/preferences` with
//! any of the keys (the others stay as they are). Stored in `exact_rust_user_flags.prefs`. The settings are self-service, so read-only
//! accounts may change them; somebody who impersonates an account reads its settings but does not change them.
//!
//! - `legacy_navigation` (default false): navigate slides as the old EXACT did: a click on the background zooms in (Shift + click out),
//!   a drag always moves the slide.
//! - `auto_overlay` (default false): when an image has exactly one registered image to overlay, show it as soon as the image opens.

use crate::{
    auth::{authenticate, authenticate_account, require_user, AuthKind},
    compat::engine::db_err,
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    extract::State,
    http::{HeaderMap, Method, StatusCode},
    routing::get,
    Json, Router,
};
use serde_json::{json, Map, Value};

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v2/me/preferences", get(read).put(write))
}

/// The settings that exist, with their defaults.
fn defaults() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("legacy_navigation".into(), json!(false));
    m.insert("auto_overlay".into(), json!(false));
    m
}

/// The stored settings laid over the defaults (keys that no longer exist are dropped).
fn with_defaults(stored: &Value) -> Value {
    let mut out = defaults();
    if let Some(o) = stored.as_object() {
        for (k, v) in o {
            if let Some(d) = out.get(k) {
                if std::mem::discriminant(d) == std::mem::discriminant(v) {
                    out.insert(k.clone(), v.clone());
                }
            }
        }
    }
    Value::Object(out)
}

async fn stored(s: &AppState, user: i64) -> ApiResult<Value> {
    let v: Option<Value> =
        sqlx::query_scalar("SELECT prefs FROM exact_rust_user_flags WHERE user_id = $1")
            .bind(user)
            .fetch_optional(&s.pool)
            .await
            .map_err(db_err)?;
    Ok(v.unwrap_or_else(|| json!({})))
}

async fn read(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    Ok(Json(with_defaults(&stored(&s, p.user.id).await?)))
}

async fn write(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate_account(&s, &headers, &Method::PUT).await?)?;
    let known = defaults();
    let Some(o) = body.as_object() else {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Expected an object.",
        ));
    };
    let mut change = Map::new();
    for (k, v) in o {
        match known.get(k) {
            None => {
                return Err(ApiError::detail(
                    StatusCode::BAD_REQUEST,
                    format!("Unknown setting {k}."),
                ))
            }
            Some(d) if std::mem::discriminant(d) != std::mem::discriminant(v) => {
                return Err(ApiError::detail(
                    StatusCode::BAD_REQUEST,
                    format!("Wrong type for {k}."),
                ))
            }
            Some(_) => {
                change.insert(k.clone(), v.clone());
            }
        }
    }
    let impersonating = matches!(
        p.kind,
        AuthKind::Session {
            impersonator: Some(_),
            ..
        }
    );
    if !impersonating && !change.is_empty() {
        sqlx::query(
            "INSERT INTO exact_rust_user_flags (user_id, read_only, prefs) VALUES ($1, false, $2)
             ON CONFLICT (user_id) DO UPDATE SET prefs = exact_rust_user_flags.prefs || $2",
        )
        .bind(p.user.id)
        .bind(Value::Object(change))
        .execute(&s.pool)
        .await
        .map_err(db_err)?;
    }
    Ok(Json(with_defaults(&stored(&s, p.user.id).await?)))
}

#[cfg(test)]
mod tests {
    use super::with_defaults;
    use serde_json::json;

    #[test]
    fn stored_settings_lie_over_the_defaults() {
        assert_eq!(
            with_defaults(&json!({})),
            json!({"legacy_navigation": false, "auto_overlay": false})
        );
        assert_eq!(
            with_defaults(&json!({"legacy_navigation": true, "gone": 1})),
            json!({"legacy_navigation": true, "auto_overlay": false})
        );
        assert_eq!(
            with_defaults(&json!({"legacy_navigation": "yes"})),
            json!({"legacy_navigation": false, "auto_overlay": false})
        );
    }
}
