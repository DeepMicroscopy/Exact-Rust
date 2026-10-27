//! Stored pyramid level offsets (`images_pyramidregistration`, shared with EXACT/Django).

use crate::internal;
use exact_core::Result;
use sqlx::{PgPool, Row};

pub struct Stored {
    pub offsets: Vec<(f64, f64)>,
    pub algorithm: i16,
    pub file_size: i64,
    pub file_mtime: i64,
}

pub async fn get(pool: &PgPool, image_id: i64) -> Result<Option<Stored>> {
    let r = sqlx::query("SELECT offsets, algorithm, file_size, file_mtime FROM images_pyramidregistration WHERE image_id = $1")
        .bind(image_id)
        .fetch_optional(pool)
        .await
        .map_err(internal)?;
    Ok(r.and_then(|r| {
        let raw: serde_json::Value = r.get("offsets");
        let offsets = raw
            .as_array()?
            .iter()
            .map(|p| Some((p.get(0)?.as_f64()?, p.get(1)?.as_f64()?)))
            .collect::<Option<Vec<_>>>()?;
        Some(Stored {
            offsets,
            algorithm: r.get("algorithm"),
            file_size: r.get("file_size"),
            file_mtime: r.get("file_mtime"),
        })
    }))
}

pub async fn put(
    pool: &PgPool,
    image_id: i64,
    offsets: &[(f64, f64)],
    algorithm: i16,
    file_size: i64,
    file_mtime: i64,
) -> Result<()> {
    let json = serde_json::Value::Array(
        offsets
            .iter()
            .map(|o| serde_json::json!([o.0, o.1]))
            .collect(),
    );
    sqlx::query(
        "INSERT INTO images_pyramidregistration (image_id, offsets, algorithm, file_size, file_mtime, updated) \
         VALUES ($1, $2, $3, $4, $5, now()) \
         ON CONFLICT (image_id) DO UPDATE SET offsets = $2, algorithm = $3, file_size = $4, file_mtime = $5, updated = now()",
    )
    .bind(image_id)
    .bind(json)
    .bind(algorithm)
    .bind(file_size)
    .bind(file_mtime)
    .execute(pool)
    .await
    .map_err(internal)?;
    Ok(())
}
