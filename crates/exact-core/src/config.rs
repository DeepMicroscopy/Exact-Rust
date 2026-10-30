//! Runtime configuration, read from the same `SQL_*`/`UPLOAD_*` environment variables as the
//! Django deployment so existing env files keep working.

use crate::{Error, Result};
use std::{collections::HashMap, path::PathBuf};

#[derive(Debug, Clone)]
pub struct Config {
    pub db_host: String,
    pub db_port: u16,
    pub db_name: String,
    pub db_user: String,
    pub db_password: String,
    pub listen: String,
    /// Root folder with the image set folders (`exact_<team>_<set>`); read-only for the server.
    pub image_path: PathBuf,
    pub media_root: PathBuf,
    /// Django `TIME_ZONE`: the API emits naive local datetimes in this zone (Django runs with USE_TZ=False).
    pub time_zone: String,
    pub cookie_secure: bool,
    /// WebAuthn relying party (Django `FIDO_SERVER_ID` / `FIDO_SERVER_NAME`); must equal production's so enrolled passkeys keep working.
    pub fido_rp_id: String,
    pub fido_rp_name: String,
    pub session_seconds: i64,
    pub db_connect_timeout_secs: u64,
    /// `EXACT_SLOW_SQL_MS`: every database statement that takes longer is logged (as a warning, with its text); unset = off.
    pub slow_sql_ms: Option<u64>,
    /// `EXACT_WELCOME_NOTICE`: a sentence shown at the top of the "what's new" greeting (e.g. that this is a beta on a copy of production); unset = none.
    pub welcome_notice: Option<String>,
    /// How long a successful Basic-auth password check is remembered in memory (0 = never).
    pub auth_cache_seconds: u64,
    /// Built frontend (`frontend/dist`) served with SPA fallback; unset/missing = API only.
    pub static_dir: Option<PathBuf>,
    /// Server-owned caches (thumbnails); never the image folders, which stay read-only.
    pub cache_dir: PathBuf,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        Self::from_map(&std::env::vars().collect())
    }

    pub fn from_map(env: &HashMap<String, String>) -> Result<Self> {
        let get = |k: &str, d: &str| env.get(k).cloned().unwrap_or_else(|| d.to_string());
        let db_port = get("SQL_PORT", "5432")
            .parse()
            .map_err(|_| Error::Config("SQL_PORT must be a number".into()))?;
        Ok(Self {
            db_host: get("SQL_HOST", "127.0.0.1"),
            db_port,
            db_name: get("SQL_DATABASE", "exact"),
            db_user: get("SQL_USER", "exact"),
            db_password: get("SQL_PASSWORD", "exact"),
            listen: get("EXACT_LISTEN", "127.0.0.1:8002"),
            image_path: get("IMAGE_PATH", "./images").into(),
            media_root: get("MEDIA_ROOT", "./media").into(),
            time_zone: get("TIME_ZONE", "Europe/Berlin"),
            fido_rp_id: get("FIDO_SERVER_ID", "localhost"),
            fido_rp_name: get("FIDO_SERVER_NAME", "EXACT"),
            cookie_secure: matches!(get("EXACT_COOKIE_SECURE", "0").as_str(), "1" | "true"),
            auth_cache_seconds: get("AUTH_CACHE_SECONDS", "300").parse().unwrap_or(300),
            cache_dir: get("EXACT_CACHE_DIR", "./cache").into(),
            static_dir: Some(PathBuf::from(get("EXACT_STATIC_DIR", "frontend/dist")))
                .filter(|p| p.join("index.html").is_file()),
            db_connect_timeout_secs: get("DB_CONNECT_TIMEOUT", "10").parse().unwrap_or(10),
            slow_sql_ms: get("EXACT_SLOW_SQL_MS", "").parse().ok().filter(|&n| n > 0),
            welcome_notice: Some(get("EXACT_WELCOME_NOTICE", "")).filter(|s| !s.trim().is_empty()),
            session_seconds: get("SESSION_COOKIE_AGE", "1209600")
                .parse()
                .unwrap_or(1_209_600),
        })
    }

    /// Database URL without logging the password.
    pub fn database_url(&self) -> String {
        format!(
            "postgres://{}:{}@{}:{}/{}",
            self.db_user, self.db_password, self.db_host, self.db_port, self.db_name
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_django() {
        let c = Config::from_map(&HashMap::new()).unwrap();
        assert_eq!(
            (c.db_host.as_str(), c.db_port, c.db_name.as_str()),
            ("127.0.0.1", 5432, "exact")
        );
    }

    #[test]
    fn reads_django_env_names() {
        let env = HashMap::from([
            ("SQL_DATABASE".to_string(), "x".to_string()),
            ("SQL_PORT".into(), "5433".into()),
        ]);
        let c = Config::from_map(&env).unwrap();
        assert_eq!((c.db_name.as_str(), c.db_port), ("x", 5433));
        assert!(
            Config::from_map(&HashMap::from([("SQL_PORT".to_string(), "x".to_string())])).is_err()
        );
    }
}
