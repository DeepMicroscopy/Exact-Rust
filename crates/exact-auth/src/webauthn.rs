//! Minimal WebAuthn relying party: verifies passkey registrations and assertions and reads the credential
//! format stored by `django-passkeys` (`websafe(AttestedCredentialData)`), so enrolled passkeys keep working.
//!
//! Matches the Django deployment (python-fido2 `Fido2Server` defaults): attestation statements are not
//! verified (we ask for `none`), user verification is requested but not enforced, and no signature counter
//! is checked (the Django table has no column for it). ES256 and RS256 credentials are supported.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ciborium::Value;
use p256::ecdsa::{signature::Verifier as _, Signature, VerifyingKey};
use rsa::{pkcs1v15::VerifyingKey as RsaVerifyingKey, BigUint, RsaPublicKey};
use sha2::{Digest, Sha256};
use std::io::Cursor;

#[derive(Debug, thiserror::Error)]
#[error("{0}")]
pub struct WebauthnError(pub String);

type Result<T> = std::result::Result<T, WebauthnError>;

fn err<T>(m: impl Into<String>) -> Result<T> {
    Err(WebauthnError(m.into()))
}

pub const FLAG_UP: u8 = 0x01;
pub const FLAG_UV: u8 = 0x04;
pub const FLAG_AT: u8 = 0x40;

#[derive(Debug, Clone)]
pub enum PublicKey {
    Es256(VerifyingKey),
    Rs256(RsaPublicKey),
}

#[derive(Debug, Clone)]
pub struct CredentialData {
    pub aaguid: [u8; 16],
    pub credential_id: Vec<u8>,
    pub public_key: PublicKey,
}

pub fn b64u(b: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(b)
}

pub fn unb64u(s: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(s.trim_end_matches('='))
        .map_err(|_| WebauthnError("invalid base64url".into()))
}

fn int(v: &Value) -> Option<i128> {
    v.as_integer().map(i128::from)
}

fn cose_get(map: &[(Value, Value)], key: i128) -> Option<&Value> {
    map.iter()
        .find(|(k, _)| int(k) == Some(key))
        .map(|(_, v)| v)
}

fn cose_bytes(map: &[(Value, Value)], key: i128) -> Result<Vec<u8>> {
    match cose_get(map, key) {
        Some(Value::Bytes(b)) => Ok(b.clone()),
        _ => err("malformed COSE key"),
    }
}

fn parse_cose_key(v: &Value) -> Result<PublicKey> {
    let Value::Map(m) = v else {
        return err("COSE key is not a map");
    };
    let alg = cose_get(m, 3).and_then(int);
    match (cose_get(m, 1).and_then(int), alg) {
        (Some(2), Some(-7)) => {
            if cose_get(m, -1).and_then(int) != Some(1) {
                return err("unsupported curve");
            }
            let (x, y) = (cose_bytes(m, -2)?, cose_bytes(m, -3)?);
            if x.len() != 32 || y.len() != 32 {
                return err("malformed EC key");
            }
            let mut point = vec![0x04];
            point.extend(x);
            point.extend(y);
            VerifyingKey::from_sec1_bytes(&point)
                .map(PublicKey::Es256)
                .map_err(|_| WebauthnError("invalid EC point".into()))
        }
        (Some(3), Some(-257)) => {
            let (n, e) = (cose_bytes(m, -1)?, cose_bytes(m, -2)?);
            RsaPublicKey::new(BigUint::from_bytes_be(&n), BigUint::from_bytes_be(&e))
                .map(PublicKey::Rs256)
                .map_err(|_| WebauthnError("invalid RSA key".into()))
        }
        _ => err(format!(
            "unsupported credential algorithm {alg:?} (ES256 and RS256 are supported)"
        )),
    }
}

/// Parses `aaguid(16) | credIdLen(2) | credId | COSE key` and returns the data together with the number of
/// bytes it occupied (authenticator data may carry extensions after it).
pub fn parse_credential_data_prefix(bytes: &[u8]) -> Result<(CredentialData, usize)> {
    if bytes.len() < 18 {
        return err("credential data too short");
    }
    let aaguid: [u8; 16] = bytes[..16].try_into().expect("slice of 16");
    let id_len = u16::from_be_bytes([bytes[16], bytes[17]]) as usize;
    if id_len == 0 || id_len > 1023 || bytes.len() < 18 + id_len {
        return err("invalid credential id length");
    }
    let credential_id = bytes[18..18 + id_len].to_vec();
    let mut cur = Cursor::new(&bytes[18 + id_len..]);
    let key: Value =
        ciborium::from_reader(&mut cur).map_err(|_| WebauthnError("malformed COSE key".into()))?;
    let used = 18 + id_len + cur.position() as usize;
    Ok((
        CredentialData {
            aaguid,
            credential_id,
            public_key: parse_cose_key(&key)?,
        },
        used,
    ))
}

/// The value stored in `passkeys_userpasskey.token`: websafe base64 of the credential data bytes.
pub fn parse_stored_token(token: &str) -> Result<CredentialData> {
    let bytes = unb64u(token)?;
    let (d, used) = parse_credential_data_prefix(&bytes)?;
    if used != bytes.len() {
        return err("trailing bytes in stored credential");
    }
    Ok(d)
}

/// python-fido2 `verify_rp_id`: https origins on the RP ID or a subdomain of it (never of a public suffix);
/// `http://localhost` and `http://*.localhost` are accepted for development.
pub fn verify_rp_id(rp_id: &str, origin: &str) -> bool {
    if rp_id.is_empty() {
        return false;
    }
    let Some((scheme, rest)) = origin.split_once("://") else {
        return false;
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let host = if let Some(stripped) = host_port.strip_prefix('[') {
        stripped.split(']').next().unwrap_or("")
    } else {
        host_port.split(':').next().unwrap_or("")
    };
    let host = host.to_ascii_lowercase();
    let secure = scheme == "https"
        || (scheme == "http" && (host == "localhost" || host.ends_with(".localhost")));
    if !secure {
        return false;
    }
    if host == rp_id {
        return true;
    }
    // like python-fido2: only suffixes that are actually on the public suffix list count
    let is_public_suffix = psl::suffix(rp_id.as_bytes())
        .is_some_and(|s| s.is_known() && s.as_bytes() == rp_id.as_bytes());
    host.ends_with(&format!(".{rp_id}")) && !is_public_suffix
}

struct ClientData {
    challenge: String,
}

fn check_client_data(
    json: &[u8],
    expected_type: &str,
    expected_challenge: &str,
    rp_id: &str,
) -> Result<ClientData> {
    let v: serde_json::Value = serde_json::from_slice(json)
        .map_err(|_| WebauthnError("malformed clientDataJSON".into()))?;
    if v["type"] != expected_type {
        return err("wrong clientData type");
    }
    let challenge = v["challenge"].as_str().unwrap_or("").to_string();
    if challenge.is_empty() || challenge != expected_challenge {
        return err("challenge mismatch");
    }
    if !verify_rp_id(rp_id, v["origin"].as_str().unwrap_or("")) {
        return err("origin not allowed for this relying party");
    }
    Ok(ClientData { challenge })
}

#[derive(Debug, Clone, Copy)]
pub struct AuthData {
    pub flags: u8,
    pub sign_count: u32,
}

fn check_auth_data(auth_data: &[u8], rp_id: &str) -> Result<AuthData> {
    if auth_data.len() < 37 {
        return err("authenticator data too short");
    }
    if auth_data[..32] != Sha256::digest(rp_id.as_bytes())[..] {
        return err("rpIdHash mismatch");
    }
    let flags = auth_data[32];
    if flags & FLAG_UP == 0 {
        return err("user presence flag not set");
    }
    Ok(AuthData {
        flags,
        sign_count: u32::from_be_bytes(auth_data[33..37].try_into().expect("slice of 4")),
    })
}

fn verify_signature(key: &PublicKey, message: &[u8], signature: &[u8]) -> Result<()> {
    match key {
        PublicKey::Es256(k) => {
            let sig = Signature::from_der(signature)
                .map_err(|_| WebauthnError("malformed signature".into()))?;
            k.verify(message, &sig)
                .map_err(|_| WebauthnError("signature invalid".into()))
        }
        PublicKey::Rs256(k) => {
            let sig = rsa::pkcs1v15::Signature::try_from(signature)
                .map_err(|_| WebauthnError("malformed signature".into()))?;
            RsaVerifyingKey::<Sha256>::new(k.clone())
                .verify(message, &sig)
                .map_err(|_| WebauthnError("signature invalid".into()))
        }
    }
}

pub struct Assertion<'a> {
    pub authenticator_data: &'a [u8],
    pub client_data_json: &'a [u8],
    pub signature: &'a [u8],
}

/// Verifies a `navigator.credentials.get()` response against the stored credential.
pub fn verify_assertion(
    rp_id: &str,
    expected_challenge: &str,
    cred: &CredentialData,
    a: &Assertion<'_>,
) -> Result<AuthData> {
    check_client_data(
        a.client_data_json,
        "webauthn.get",
        expected_challenge,
        rp_id,
    )?;
    let ad = check_auth_data(a.authenticator_data, rp_id)?;
    let mut message = a.authenticator_data.to_vec();
    message.extend_from_slice(&Sha256::digest(a.client_data_json));
    verify_signature(&cred.public_key, &message, a.signature)?;
    Ok(ad)
}

/// Verifies a `navigator.credentials.create()` response and returns the credential plus the exact bytes to
/// store (`websafe` of them is the `token` column).
pub fn verify_registration(
    rp_id: &str,
    expected_challenge: &str,
    client_data_json: &[u8],
    attestation_object: &[u8],
) -> Result<(CredentialData, Vec<u8>)> {
    let cd = check_client_data(
        client_data_json,
        "webauthn.create",
        expected_challenge,
        rp_id,
    )?;
    debug_assert_eq!(cd.challenge, expected_challenge);
    let obj: Value = ciborium::from_reader(attestation_object)
        .map_err(|_| WebauthnError("malformed attestationObject".into()))?;
    let Value::Map(m) = obj else {
        return err("attestationObject is not a map");
    };
    let auth_data = m
        .iter()
        .find_map(|(k, v)| (k.as_text() == Some("authData")).then_some(v))
        .and_then(|v| {
            if let Value::Bytes(b) = v {
                Some(b.clone())
            } else {
                None
            }
        })
        .ok_or_else(|| WebauthnError("authData missing".into()))?;
    let ad = check_auth_data(&auth_data, rp_id)?;
    if ad.flags & FLAG_AT == 0 {
        return err("no attested credential data");
    }
    let (cred, used) = parse_credential_data_prefix(&auth_data[37..])?;
    Ok((cred, auth_data[37..37 + used].to_vec()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Vectors made by tests/conformance/softkey.py (a software authenticator accepted by django-passkeys).
    const V: &str = include_str!("../tests/webauthn_vectors.json");

    fn v() -> serde_json::Value {
        serde_json::from_str(V).unwrap()
    }
    fn s(v: &serde_json::Value, k: &str) -> String {
        v[k].as_str().unwrap().to_string()
    }

    fn assertion_parts(v: &serde_json::Value) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
        let a = &v["assertion"]["response"];
        (
            unb64u(a["authenticatorData"].as_str().unwrap()).unwrap(),
            unb64u(a["clientDataJSON"].as_str().unwrap()).unwrap(),
            unb64u(a["signature"].as_str().unwrap()).unwrap(),
        )
    }

    #[test]
    fn stored_django_token_parses() {
        let c = parse_stored_token(&s(&v(), "token")).unwrap();
        assert_eq!(b64u(&c.credential_id), s(&v(), "credential_id"));
        assert!(matches!(c.public_key, PublicKey::Es256(_)));
    }

    #[test]
    fn valid_assertion_verifies() {
        let v = v();
        let c = parse_stored_token(&s(&v, "token")).unwrap();
        let (ad, cd, sig) = assertion_parts(&v);
        let r = verify_assertion(
            "localhost",
            &s(&v, "assertion_challenge"),
            &c,
            &Assertion {
                authenticator_data: &ad,
                client_data_json: &cd,
                signature: &sig,
            },
        )
        .unwrap();
        assert_ne!(r.flags & FLAG_UP, 0);
    }

    #[test]
    fn tampering_is_rejected() {
        let v = v();
        let c = parse_stored_token(&s(&v, "token")).unwrap();
        let (ad, cd, sig) = assertion_parts(&v);
        let ch = s(&v, "assertion_challenge");
        let check = |rp: &str, ch: &str, ad: &[u8], cd: &[u8], sig: &[u8]| {
            verify_assertion(
                rp,
                ch,
                &c,
                &Assertion {
                    authenticator_data: ad,
                    client_data_json: cd,
                    signature: sig,
                },
            )
        };
        assert!(check("localhost", &ch, &ad, &cd, &sig).is_ok());
        assert!(
            check("example.org", &ch, &ad, &cd, &sig).is_err(),
            "other relying party"
        );
        assert!(
            check("localhost", "other-challenge", &ad, &cd, &sig).is_err(),
            "challenge"
        );
        let mut bad_sig = sig.clone();
        *bad_sig.last_mut().unwrap() ^= 1;
        assert!(
            check("localhost", &ch, &ad, &cd, &bad_sig).is_err(),
            "signature"
        );
        let mut no_up = ad.clone();
        no_up[32] &= !FLAG_UP;
        assert!(
            check("localhost", &ch, &no_up, &cd, &sig).is_err(),
            "user presence"
        );
        let evil = String::from_utf8(cd.clone())
            .unwrap()
            .replace("http://localhost:8001", "https://evil.example");
        assert!(
            check("localhost", &ch, &ad, evil.as_bytes(), &sig).is_err(),
            "origin"
        );
    }

    #[test]
    fn registration_extracts_credential() {
        let v = v();
        let r = &v["registration"]["response"];
        let (cred, stored) = verify_registration(
            "localhost",
            &s(&v, "registration_challenge"),
            &unb64u(r["clientDataJSON"].as_str().unwrap()).unwrap(),
            &unb64u(r["attestationObject"].as_str().unwrap()).unwrap(),
        )
        .unwrap();
        assert_eq!(b64u(&cred.credential_id), s(&v, "credential_id"));
        assert_eq!(
            b64u(&stored),
            s(&v, "token"),
            "stored bytes are exactly what django-passkeys would store"
        );
        assert!(verify_registration(
            "localhost",
            "wrong",
            &unb64u(r["clientDataJSON"].as_str().unwrap()).unwrap(),
            &unb64u(r["attestationObject"].as_str().unwrap()).unwrap()
        )
        .is_err());
    }

    #[test]
    fn rp_id_rules_match_fido2() {
        assert!(verify_rp_id("example.org", "https://example.org"));
        assert!(verify_rp_id(
            "example.org",
            "https://exact.example.org:8443/x"
        ));
        assert!(!verify_rp_id("example.org", "http://example.org"));
        assert!(!verify_rp_id("example.org", "https://notexample.org"));
        assert!(!verify_rp_id("org", "https://example.org"), "public suffix");
        assert!(
            !verify_rp_id("co.uk", "https://example.co.uk"),
            "multi-label public suffix"
        );
        assert!(
            verify_rp_id("localhost", "https://a.localhost"),
            "not on the list"
        );
        assert!(verify_rp_id("localhost", "http://localhost:8001"));
        assert!(
            !verify_rp_id("127.0.0.1", "http://127.0.0.1:8000"),
            "IP addresses are not valid RP IDs"
        );
        assert!(!verify_rp_id("", "https://example.org"));
    }
}
