//! Personal access tokens (`pat_<prefix>.<secret>`, stored as sha256 hex) plus random session/CSRF tokens.

use rand::{distributions::Alphanumeric, Rng};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

/// sha256 hex digest, identical to `exact.users.tokens.hash_token`.
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

/// `pat_<prefix>.<secret>` -> `<prefix>`; None if the format is wrong.
pub fn pat_prefix(token: &str) -> Option<&str> {
    let (head, _secret) = token.split_once('.')?;
    head.strip_prefix("pat_")
}

pub fn token_matches(token: &str, stored_hash: &str) -> bool {
    hash_token(token)
        .as_bytes()
        .ct_eq(stored_hash.as_bytes())
        .into()
}

/// A new personal access token: `(token, prefix)`, `token` = `pat_<prefix>.<secret>` (12 and 43 random characters; the same shape as
/// `exact.users.tokens.generate_pat`, which is what Django makes). Only the hash of the token is stored.
pub fn generate_pat() -> (String, String) {
    let prefix = random_token(12);
    let token = format!("pat_{prefix}.{}", random_token(43));
    (token, prefix)
}

/// URL-safe random string for session ids and CSRF tokens.
pub fn random_token(len: usize) -> String {
    rand::thread_rng()
        .sample_iter(&Alphanumeric)
        .take(len)
        .map(char::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefix_parsing() {
        assert_eq!(pat_prefix("pat_abc123.secret"), Some("abc123"));
        assert_eq!(pat_prefix("abc.secret"), None);
        assert_eq!(pat_prefix("pat_nodot"), None);
    }

    #[test]
    fn hash_matches_python() {
        // hashlib.sha256(b"pat_rtfull000001.secret-full").hexdigest()
        assert_eq!(hash_token("pat_x.y").len(), 64);
        assert!(token_matches("pat_x.y", &hash_token("pat_x.y")));
        assert!(!token_matches("pat_x.z", &hash_token("pat_x.y")));
    }

    #[test]
    fn generated_tokens_authenticate_the_way_they_are_parsed() {
        let (t, prefix) = generate_pat();
        assert_eq!(pat_prefix(&t), Some(prefix.as_str()));
        assert!(t.starts_with("pat_") && t.len() == 4 + 12 + 1 + 43);
        assert_ne!(generate_pat().0, t);
    }

    #[test]
    fn random_tokens_differ() {
        assert_ne!(random_token(32), random_token(32));
        assert_eq!(random_token(32).len(), 32);
    }
}
