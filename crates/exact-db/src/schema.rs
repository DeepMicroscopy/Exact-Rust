//! Schema baseline check: compares the live DB with `schema-baseline.json`
//! (tables -> columns, taken from the real dump), so drift is detected at startup/CI.

use exact_core::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::collections::BTreeMap;

pub type Tables = BTreeMap<String, BTreeMap<String, ColumnInfo>>;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ColumnInfo {
    pub data_type: String,
    pub nullable: bool,
}

pub async fn introspect(pool: &PgPool) -> Result<Tables> {
    let rows: Vec<(String, String, String, String)> = sqlx::query_as(
        "SELECT table_name::text, column_name::text, data_type::text, is_nullable::text
           FROM information_schema.columns WHERE table_schema = 'public'
          ORDER BY table_name, ordinal_position",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| Error::Internal(e.to_string()))?;
    let mut t = Tables::new();
    for (table, col, data_type, nullable) in rows {
        t.entry(table).or_default().insert(
            col,
            ColumnInfo {
                data_type,
                nullable: nullable == "YES",
            },
        );
    }
    Ok(t)
}

/// Differences as human-readable lines; empty = identical.
/// Tables the Rust server owns (additive, `exact_rust_*`); they are not part of the structure shared with EXACT.
pub fn is_rust_owned(table: &str) -> bool {
    table.starts_with("exact_rust_")
}

pub fn diff(expected: &Tables, actual: &Tables) -> Vec<String> {
    let mut out = vec![];
    for (table, cols) in expected {
        let Some(act) = actual.get(table) else {
            out.push(format!("missing table {table}"));
            continue;
        };
        for (c, info) in cols {
            match act.get(c) {
                None => out.push(format!("missing column {table}.{c}")),
                Some(a) if a != info => out.push(format!(
                    "changed column {table}.{c}: expected {info:?}, found {a:?}"
                )),
                _ => {}
            }
        }
        out.extend(
            act.keys()
                .filter(|c| !cols.contains_key(*c))
                .map(|c| format!("extra column {table}.{c}")),
        );
    }
    out.extend(
        actual
            .keys()
            .filter(|t| !expected.contains_key(*t) && !is_rust_owned(t))
            .map(|t| format!("extra table {t}")),
    );
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(cols: &[(&str, &str, bool)]) -> Tables {
        Tables::from([(
            "images_image".to_string(),
            cols.iter()
                .map(|(n, d, nl)| {
                    (
                        n.to_string(),
                        ColumnInfo {
                            data_type: d.to_string(),
                            nullable: *nl,
                        },
                    )
                })
                .collect(),
        )])
    }

    #[test]
    fn identical_has_no_diff() {
        assert!(diff(
            &t(&[("id", "integer", false)]),
            &t(&[("id", "integer", false)])
        )
        .is_empty());
    }

    #[test]
    fn reports_drift() {
        let d = diff(
            &t(&[("id", "integer", false), ("a", "text", true)]),
            &t(&[("id", "bigint", false), ("b", "text", true)]),
        );
        assert_eq!(d.len(), 3, "{d:?}");
    }
}

#[cfg(test)]
mod diff_tests {
    use super::*;

    #[test]
    fn rust_owned_tables_are_not_drift_but_other_extra_tables_are() {
        let expected = Tables::new();
        let mut actual = Tables::new();
        actual.insert("exact_rust_session".into(), Default::default());
        assert!(diff(&expected, &actual).is_empty());
        actual.insert("images_somethingnew".into(), Default::default());
        assert_eq!(
            diff(&expected, &actual),
            vec!["extra table images_somethingnew".to_string()]
        );
    }
}
