//! Passkey (WebAuthn) login and management. Credentials live in the `django-passkeys` table, so keys enrolled
//! under Django keep working. Login failures are deliberately uniform (no hint which part was wrong).

use super::switch_session;
use crate::{
    auth::{authenticate, authenticate_account, require_user, AuthKind, Principal},
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::Response,
    routing::{get, patch, post},
    Json, Router,
};
use exact_auth::{
    tokens::random_token,
    webauthn::{self, b64u, unb64u, Assertion},
};
use exact_db::{challenges, passkeys, users};
use serde::Deserialize;
use serde_json::{json, Value};

const LOGIN: &str = "passkey-login";
const REGISTER: &str = "passkey-register";
const TIMEOUT_MS: u32 = 60_000;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/auth/passkey/begin", post(login_begin))
        .route("/api/v2/auth/passkey/finish", post(login_finish))
        .route("/api/v2/auth/passkeys", get(list))
        .route("/api/v2/auth/passkeys/register/begin", post(register_begin))
        .route(
            "/api/v2/auth/passkeys/register/finish",
            post(register_finish),
        )
        .route("/api/v2/auth/passkeys/{id}", patch(update).delete(remove))
}

fn failed() -> ApiError {
    ApiError::detail(StatusCode::UNAUTHORIZED, "Passkey login failed.")
}

fn passkey_json(p: &passkeys::Passkey) -> Value {
    json!({"id": p.id, "name": p.name, "platform": p.platform, "enabled": p.enabled,
           "added_on": p.added_on.to_rfc3339(), "last_used": p.last_used.map(|d| d.to_rfc3339()), "credential_id": p.credential_id})
}

#[derive(Deserialize, Default)]
struct BeginBody {
    username: Option<String>,
}

/// Starts a login. Without a username a discoverable-credential (usernameless) flow is offered; with one the
/// user's enabled keys are listed. An unknown username yields the same response shape as a known one.
async fn login_begin(State(s): State<AppState>, body: Bytes) -> ApiResult<Json<Value>> {
    let req: BeginBody = serde_json::from_slice(&body).unwrap_or_default();
    let mut allow = vec![];
    if let Some(u) = req.username.as_deref().filter(|u| !u.is_empty()) {
        if let Some(user) = users::user_by_username(&s.pool, u).await? {
            allow = passkeys::list_for_user(&s.pool, user.id)
                .await?
                .into_iter()
                .filter(|p| p.enabled)
                .map(|p| json!({"type": "public-key", "id": p.credential_id}))
                .collect();
        }
    }
    let (state, challenge) = (random_token(40), b64u(random_token(32).as_bytes()));
    challenges::create(&s.pool, &state, &challenge, LOGIN, None).await?;
    Ok(Json(json!({"state": state, "publicKey": {
        "challenge": challenge, "rpId": s.fido_rp_id, "timeout": TIMEOUT_MS,
        "userVerification": "preferred", "allowCredentials": allow}})))
}

#[derive(Deserialize)]
struct Credential {
    id: String,
    response: CredResponse,
}

#[derive(Deserialize)]
struct CredResponse {
    #[serde(rename = "authenticatorData")]
    authenticator_data: Option<String>,
    #[serde(rename = "clientDataJSON")]
    client_data_json: String,
    signature: Option<String>,
    #[serde(rename = "attestationObject")]
    attestation_object: Option<String>,
}

#[derive(Deserialize)]
struct FinishBody {
    state: String,
    credential: Credential,
    name: Option<String>,
}

async fn login_finish(State(s): State<AppState>, Json(b): Json<FinishBody>) -> ApiResult<Response> {
    let Some((challenge, _)) = challenges::take(&s.pool, &b.state, LOGIN).await? else {
        return Err(failed());
    };
    let Some(pk) = passkeys::by_credential_id(&s.pool, &b.credential.id)
        .await?
        .filter(|p| p.enabled)
    else {
        return Err(failed());
    };
    let (Some(ad), Some(sig)) = (
        b.credential.response.authenticator_data.as_deref(),
        b.credential.response.signature.as_deref(),
    ) else {
        return Err(failed());
    };
    let parsed = (|| -> Result<_, webauthn::WebauthnError> {
        let cred = webauthn::parse_stored_token(&pk.token)?;
        let (ad, cd, sig) = (
            unb64u(ad)?,
            unb64u(&b.credential.response.client_data_json)?,
            unb64u(sig)?,
        );
        webauthn::verify_assertion(
            &s.fido_rp_id,
            &challenge,
            &cred,
            &Assertion {
                authenticator_data: &ad,
                client_data_json: &cd,
                signature: &sig,
            },
        )
    })();
    if let Err(e) = parsed {
        tracing::info!(credential = %pk.id, "passkey assertion rejected: {e}");
        return Err(failed());
    }
    let Some(user) = users::user_by_id(&s.pool, pk.user_id)
        .await?
        .filter(|u| u.is_active)
    else {
        return Err(failed());
    };
    passkeys::touch(&s.pool, pk.id).await?;
    users::touch_last_login(&s.pool, user.id).await?;
    switch_session(&s, None, &user, None).await
}

/// Registration needs an interactive session (password login or an earlier passkey login).
async fn session_user(s: &AppState, headers: &HeaderMap, method: &Method) -> ApiResult<Principal> {
    let p = require_user(authenticate_account(s, headers, method).await?)?;
    if !matches!(p.kind, AuthKind::Session { .. }) {
        return Err(ApiError::auth_failed(
            "Managing passkeys requires an interactive session.",
        ));
    }
    Ok(p)
}

async fn register_begin(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let p = session_user(&s, &headers, &Method::POST).await?;
    let existing = passkeys::list_for_user(&s.pool, p.user.id).await?;
    let (state, challenge) = (random_token(40), b64u(random_token(32).as_bytes()));
    challenges::create(&s.pool, &state, &challenge, REGISTER, Some(p.user.id)).await?;
    // same user handle encoding as django-passkeys (urlsafe_b64encode(username), then websafe)
    let handle = b64u(
        base64::Engine::encode(
            &base64::engine::general_purpose::URL_SAFE,
            p.user.username.as_bytes(),
        )
        .as_bytes(),
    );
    Ok(Json(json!({"state": state, "publicKey": {
        "rp": {"id": s.fido_rp_id, "name": s.fido_rp_name},
        "user": {"id": handle, "name": p.user.username, "displayName": p.user.username},
        "challenge": challenge, "timeout": TIMEOUT_MS, "attestation": "none",
        "pubKeyCredParams": [{"type": "public-key", "alg": -7}, {"type": "public-key", "alg": -257}],
        "excludeCredentials": existing.iter().map(|k| json!({"type": "public-key", "id": k.credential_id})).collect::<Vec<_>>(),
        "authenticatorSelection": {"residentKey": "preferred", "requireResidentKey": false, "userVerification": "preferred"}}})))
}

fn platform(headers: &HeaderMap) -> &'static str {
    let ua = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let chromium = ua.contains("Chrome")
        || ua.contains("Chromium")
        || ua.contains("Edg/")
        || ua.contains("CriOS");
    if ua.contains("Safari") && !chromium {
        "Apple"
    } else if chromium && ua.contains("Mac OS X") {
        "Chrome on Apple"
    } else if ua.contains("Android") {
        "Google"
    } else if ua.contains("Windows") {
        "Microsoft"
    } else {
        "Key"
    }
}

async fn register_finish(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<FinishBody>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let p = session_user(&s, &headers, &Method::POST).await?;
    let bad = |m: &str| ApiError::detail(StatusCode::BAD_REQUEST, m);
    let Some((challenge, Some(uid))) = challenges::take(&s.pool, &b.state, REGISTER).await? else {
        return Err(bad("The registration request expired, please try again."));
    };
    if uid != p.user.id {
        return Err(bad("The registration request expired, please try again."));
    }
    let r = &b.credential.response;
    let att = r
        .attestation_object
        .as_deref()
        .ok_or_else(|| bad("attestationObject missing"))?;
    let (cred, stored) = webauthn::unb64u(&r.client_data_json)
        .and_then(|cd| webauthn::verify_registration(&s.fido_rp_id, &challenge, &cd, &unb64u(att)?))
        .map_err(|e| {
            tracing::info!("passkey registration rejected: {e}");
            bad("The passkey could not be verified.")
        })?;
    if b64u(&cred.credential_id) != b.credential.id.trim_end_matches('=') {
        return Err(bad("The passkey could not be verified."));
    }
    let token = b64u(&stored);
    if token.len() > 255 || b.credential.id.len() > 255 {
        return Err(bad("This passkey is too large to be stored."));
    }
    let plat = platform(&headers);
    let name = b
        .name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .unwrap_or(plat);
    passkeys::insert(
        &s.pool,
        p.user.id,
        &name.chars().take(255).collect::<String>(),
        plat,
        &b.credential.id,
        &token,
    )
    .await?;
    let created = passkeys::by_credential_id(&s.pool, &b.credential.id)
        .await?
        .map(|k| passkey_json(&k));
    Ok((StatusCode::CREATED, Json(created.unwrap_or(Value::Null))))
}

async fn list(State(s): State<AppState>, headers: HeaderMap) -> ApiResult<Json<Value>> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    Ok(Json(Value::Array(
        passkeys::list_for_user(&s.pool, p.user.id)
            .await?
            .iter()
            .map(passkey_json)
            .collect(),
    )))
}

#[derive(Deserialize)]
struct Update {
    name: Option<String>,
    enabled: Option<bool>,
}

async fn update(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i32>,
    Json(b): Json<Update>,
) -> ApiResult<Json<Value>> {
    let p = session_user(&s, &headers, &Method::PATCH).await?;
    if !passkeys::update(
        &s.pool,
        p.user.id,
        id,
        b.name.as_deref().map(str::trim),
        b.enabled,
    )
    .await?
    {
        return Err(ApiError::not_found("Not found."));
    }
    let k = passkeys::list_for_user(&s.pool, p.user.id)
        .await?
        .into_iter()
        .find(|k| k.id == id);
    Ok(Json(k.as_ref().map(passkey_json).unwrap_or(Value::Null)))
}

async fn remove(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i32>,
) -> ApiResult<StatusCode> {
    let p = session_user(&s, &headers, &Method::DELETE).await?;
    if passkeys::delete(&s.pool, p.user.id, id).await? {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::not_found("Not found."))
    }
}
