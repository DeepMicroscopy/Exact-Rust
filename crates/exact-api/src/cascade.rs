//! Deletion with Django's `on_delete=CASCADE` semantics. Django's foreign keys carry no `ON DELETE` clause, so rows that
//! point at a deleted row have to be removed (or have their reference cleared) by the application.
//!
//! The referencing foreign keys are read from the catalog; every one cascades except the `SET_NULL` ones listed here
//! (the models of the tables a deletion of an image set / image / annotation reaches).

use crate::{compat::engine::db_err, error::ApiResult};
use sqlx::{Postgres, Row, Transaction};

/// `(table, column)` pairs declared `on_delete=SET_NULL` in Django.
const SET_NULL: &[(&str, &str)] = &[
    ("images_auxiliaryfile", "associated_to_image_id"),
    ("images_image", "crop_source_id"),
    ("images_imageset", "creator_id"),
    ("images_image", "creator_id"),
    ("images_auxiliaryfile", "creator_id"),
    ("annotations_annotation", "user_id"),
    ("annotations_annotation", "last_editor_id"),
    ("images_imageset", "main_annotation_type_id"),
    ("images_imageset", "team_id"),
    ("tools_tool", "team_id"),
    ("processing_pluginresult", "job_id"),
    ("processing_pluginjob", "creator_id"),
    ("images_screeningmode", "user_id"),
    ("annotations_verification", "user_id"),
    ("annotations_logimageaction", "user_id"),
    ("annotations_annotationtype", "product_id"),
    ("administration_product", "creator_id"),
    ("administration_product", "team_id"),
];

/// Deletes the rows `ids` of `table` (primary key `id`) and everything that depends on them. Returns the number of rows
/// removed per table.
pub async fn delete_rows(
    tx: &mut Transaction<'_, Postgres>,
    table: &str,
    ids: &[i64],
) -> ApiResult<Vec<(String, u64)>> {
    let mut counts = vec![];
    delete_inner(tx, table, ids, 0, false, &mut counts).await?;
    Ok(counts)
}

/// Deletion of users: every nullable reference to the user (creator, last editor, ...) is cleared, every mandatory one
/// (tokens, passkeys, memberships, preferences, sessions) is deleted with the user, which is what the models declare.
pub async fn delete_users(
    tx: &mut Transaction<'_, Postgres>,
    ids: &[i64],
) -> ApiResult<Vec<(String, u64)>> {
    let mut counts = vec![];
    delete_inner(tx, "users_user", ids, 0, true, &mut counts).await?;
    Ok(counts)
}

fn delete_inner<'a>(
    tx: &'a mut Transaction<'_, Postgres>,
    table: &'a str,
    ids: &'a [i64],
    depth: usize,
    nullable_clears: bool,
    counts: &'a mut Vec<(String, u64)>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = ApiResult<()>> + Send + 'a>> {
    Box::pin(async move {
        if ids.is_empty() || depth > 12 {
            return Ok(());
        }
        let refs = sqlx::query(
            "SELECT c.conrelid::regclass::text, quote_ident(a.attname), a.attname, NOT a.attnotnull, \
                    EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.conrelid AND x.attname = 'id' AND NOT x.attisdropped) \
             FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1] \
             WHERE c.contype = 'f' AND c.confrelid = $1::regclass AND array_length(c.conkey, 1) = 1",
        )
        .bind(table)
        .fetch_all(&mut **tx)
        .await
        .map_err(db_err)?;
        for r in refs {
            let (child, quoted, plain, nullable, has_id): (String, String, String, bool, bool) =
                (r.get(0), r.get(1), r.get(2), r.get(3), r.get(4));
            if (nullable_clears && nullable)
                || SET_NULL.iter().any(|(t, c)| *t == child && *c == plain)
            {
                sqlx::query(&format!(
                    "UPDATE {child} SET {quoted} = NULL WHERE {quoted} = ANY($1)"
                ))
                .bind(ids)
                .execute(&mut **tx)
                .await
                .map_err(db_err)?;
                continue;
            }
            if !has_id {
                // a table keyed otherwise (sessions): nothing refers to it, its rows go with the referenced row
                sqlx::query(&format!("DELETE FROM {child} WHERE {quoted} = ANY($1)"))
                    .bind(ids)
                    .execute(&mut **tx)
                    .await
                    .map_err(db_err)?;
                continue;
            }
            let child_ids: Vec<i64> = sqlx::query_scalar(&format!(
                "SELECT id::bigint FROM {child} WHERE {quoted} = ANY($1)"
            ))
            .bind(ids)
            .fetch_all(&mut **tx)
            .await
            .map_err(db_err)?;
            if child == table {
                // self reference (none of the cascading ones today): do not loop on the rows being deleted
                let rest: Vec<i64> = child_ids.into_iter().filter(|i| !ids.contains(i)).collect();
                delete_inner(tx, &child, &rest, depth + 1, nullable_clears, counts).await?;
            } else {
                delete_inner(tx, &child, &child_ids, depth + 1, nullable_clears, counts).await?;
            }
        }
        let n = sqlx::query(&format!("DELETE FROM {table} WHERE id = ANY($1)"))
            .bind(ids)
            .execute(&mut **tx)
            .await
            .map_err(db_err)?
            .rows_affected();
        counts.push((table.to_string(), n));
        Ok(())
    })
}
