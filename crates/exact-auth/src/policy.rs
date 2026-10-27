//! Password policy equal to the Django deployment's `AUTH_PASSWORD_VALIDATORS`: attribute similarity,
//! minimum length 8, not a common password (Django's list), not entirely numeric.

use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

const COMMON: &str = include_str!("common-passwords.txt");
pub const MIN_LENGTH: usize = 8;
const MAX_SIMILARITY: f64 = 0.7;

fn common() -> &'static HashSet<&'static str> {
    static SET: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SET.get_or_init(|| COMMON.lines().collect())
}

/// Python `difflib.SequenceMatcher.quick_ratio()`: an upper bound of the similarity from character counts.
fn quick_ratio(a: &str, b: &str) -> f64 {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let total = a.len() + b.len();
    if total == 0 {
        return 1.0;
    }
    let mut avail: HashMap<char, i64> = HashMap::new();
    for c in &b {
        *avail.entry(*c).or_default() += 1;
    }
    let mut matches = 0usize;
    for c in &a {
        let n = avail.entry(*c).or_default();
        if *n > 0 {
            matches += 1;
        }
        *n -= 1;
    }
    2.0 * matches as f64 / total as f64
}

/// Splits like Python `re.split(r"\W+", value)` + the whole value.
fn parts(value: &str) -> Vec<String> {
    let mut v: Vec<String> = value
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .filter(|p| !p.is_empty())
        .map(str::to_string)
        .collect();
    v.push(value.to_string());
    v
}

/// Returns the error messages (Django wording); empty = acceptable.
pub fn validate_password(password: &str, user_attrs: &[&str]) -> Vec<String> {
    let mut errors = vec![];
    let lower = password.to_lowercase();
    for attr in user_attrs.iter().filter(|a| !a.is_empty()) {
        let attr_l = attr.to_lowercase();
        if parts(&attr_l)
            .iter()
            .any(|p| quick_ratio(&lower, p) >= MAX_SIMILARITY)
        {
            errors.push("The password is too similar to the user's information.".to_string());
            break;
        }
    }
    if password.chars().count() < MIN_LENGTH {
        errors.push(format!(
            "This password is too short. It must contain at least {MIN_LENGTH} characters."
        ));
    }
    if common().contains(lower.trim()) {
        errors.push("This password is too common.".to_string());
    }
    if !password.is_empty() && password.chars().all(|c| c.is_ascii_digit()) {
        errors.push("This password is entirely numeric.".to_string());
    }
    errors
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected results come from Django 4.2's own validators (see PLAN.md §5d).
    #[test]
    fn django_cases() {
        let ok = |pw: &str, attrs: &[&str]| validate_password(pw, attrs).is_empty();
        assert!(ok("correct horse battery", &["alice"]));
        assert!(ok("alice-wonderland", &["alice", "alice@example.org"]));
        assert!(ok("alicealice1", &["alice"]));
        assert!(ok("Tr0ub4dor&3xyz", &["alice"]));
        assert!(ok("violet-harbour-2026!", &["rt_inv_ab12cd34"]));
        assert_eq!(validate_password("short", &[]).len(), 1);
        assert!(validate_password("password", &[])
            .iter()
            .any(|e| e.contains("common")));
        let numeric = validate_password("12345678901", &[]);
        assert!(
            numeric.iter().any(|e| e.contains("common"))
                && numeric.iter().any(|e| e.contains("numeric"))
        );
        assert!(
            validate_password("alice2026", &["alice", "alice@example.org"])
                .iter()
                .any(|e| e.contains("similar"))
        );
        assert!(validate_password("rt_inv_ab12cd34x", &["rt_inv_ab12cd34"])
            .iter()
            .any(|e| e.contains("similar")));
    }

    #[test]
    fn quick_ratio_is_difflib() {
        assert!((quick_ratio("abcd", "bcde") - 0.75).abs() < 1e-9);
        assert_eq!(quick_ratio("", ""), 1.0);
    }
}
