//! DRF-shaped error responses: `{"detail": "..."}`.

use axum::{
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub body: Value,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn detail(status: StatusCode, msg: impl Into<String>) -> Self {
        Self {
            status,
            body: json!({ "detail": msg.into() }),
        }
    }
    /// DRF answers authentication problems with 403 here (the first authenticator has no
    /// `WWW-Authenticate` challenge, so 401 is coerced to 403).
    pub fn auth_failed(msg: impl Into<String>) -> Self {
        Self::detail(StatusCode::FORBIDDEN, msg)
    }
    pub fn not_authenticated() -> Self {
        Self::auth_failed("Authentication credentials were not provided.")
    }
    pub fn permission_denied() -> Self {
        Self::detail(
            StatusCode::FORBIDDEN,
            "You do not have permission to perform this action.",
        )
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self::detail(StatusCode::NOT_FOUND, msg)
    }
    pub fn validation(field: &str, msg: &str) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            body: json!({ field: [msg] }),
        }
    }
    /// Django's default HTML 404 page, which it serves for URLs that are not routed at all.
    pub fn not_found_page() -> Self {
        Self {
            status: StatusCode::NOT_FOUND,
            body: Value::String(NOT_FOUND_PAGE.into()),
        }
    }
    pub fn is_page(&self) -> bool {
        self.body.as_str() == Some(NOT_FOUND_PAGE)
    }
    pub fn not_implemented(what: &str) -> Self {
        Self::detail(
            StatusCode::NOT_IMPLEMENTED,
            format!("{what} is not implemented yet in exact-rust"),
        )
    }
}

impl From<exact_core::Error> for ApiError {
    fn from(e: exact_core::Error) -> Self {
        match e {
            exact_core::Error::NotFound => Self::not_found("Not found."),
            exact_core::Error::Forbidden => Self::permission_denied(),
            exact_core::Error::Invalid(m) => Self::detail(StatusCode::BAD_REQUEST, m),
            exact_core::Error::Conflict(m) => Self::detail(StatusCode::CONFLICT, m),
            other => {
                tracing::error!("internal error: {other}");
                Self::detail(StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.")
            }
        }
    }
}

const NOT_FOUND_PAGE: &str = "\n<!doctype html>\n<html lang=\"en\">\n<head>\n  <title>Not Found</title>\n</head>\n<body>\n  <h1>Not Found</h1><p>The requested resource was not found on this server.</p>\n</body>\n</html>\n";

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        if self.body.as_str() == Some(NOT_FOUND_PAGE) {
            return (
                self.status,
                [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                NOT_FOUND_PAGE,
            )
                .into_response();
        }
        (self.status, Json(self.body)).into_response()
    }
}

/// Adds the `Allow` header DRF sends on every response of a view.
pub fn with_allow(mut r: Response, allow: &'static str) -> Response {
    r.headers_mut()
        .insert(header::ALLOW, header::HeaderValue::from_static(allow));
    r
}
