//! Pixel masks of segmentation annotations, stored as 256 x 256 PNG tiles (`annotations_segmentationtile`) exactly as Django does.
//!
//! - `GET|PUT|DELETE /api/v2/segmentation/{annotation}/tiles/{plane}/{tile_x}/{tile_y}?frame=&ph=&nf=` (the old
//!   `/annotations/api/segmentation/.../` path works too): GET answers the tile as PNG or 204 when it is empty, PUT takes a PNG
//!   (the red channel above 127 is the mask) and answers 204, DELETE answers 204.
//! - `plane` is the MPR plane of a volume: 0 axial, 1 coronal, 2 sagittal. Only axial tiles are stored (level 0, `frame` = slice);
//!   coronal and sagittal tiles are derived from them on the fly and written through (`ph` = pixel height of the rendered plane,
//!   `nf` = number of slices along its normal axis), with the voxel mapping of `annotations/views.py`.
//!
//! Reading needs read access, writing `edit_annotation` in the image set of the annotation.

use crate::{
    auth::{authenticate, require_user, Principal},
    compat::{
        engine::db_err,
        writes::{annotation_row, set_perms},
    },
    error::{ApiError, ApiResult},
    AppState,
};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use image::{ImageEncoder, ImageFormat};
use serde::Deserialize;
use sqlx::Row;
use std::collections::HashMap;

pub const T: usize = 256;
type Tile = Vec<u8>; // T * T, row-major, 0 / 1

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/segmentation/{annotation}/tiles", get(index))
        .route(
            "/api/v2/segmentation/{annotation}/tiles/{plane}/{tx}/{ty}",
            get(get_tile).put(put_tile).delete(delete_tile),
        )
}

pub fn legacy_routes() -> Router<AppState> {
    Router::new().route(
        "/annotations/api/segmentation/{annotation}/tiles/{plane}/{tx}/{ty}/",
        get(get_tile).put(put_tile).delete(delete_tile),
    )
}

#[derive(Deserialize, Default)]
struct Q {
    #[serde(default)]
    frame: i64,
    ph: Option<i64>,
    #[serde(default)]
    nf: i64,
}

// ---------------------------------------------------------------------------------------------------------
// voxel mapping (ports of the helpers of annotations/views.py)
// ---------------------------------------------------------------------------------------------------------

/// Python's `round` (halves go to the even number).
fn py_round(x: f64) -> i64 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 && (r as i64) % 2 != 0 {
        (r - x.signum()) as i64
    } else {
        r as i64
    }
}

/// The z voxel shown in row `row_abs` of a non-axial plane (Superior at the top); `ph` is the pixel height of the plane.
pub fn z_vox_for_row(row_abs: i64, nz: i64, ph: i64) -> i64 {
    if ph <= 1 {
        return (nz - 1 - row_abs).clamp(0, nz - 1);
    }
    (nz - 1 - py_round(row_abs as f64 * (nz - 1) as f64 / (ph - 1) as f64)).clamp(0, nz - 1)
}

/// The axial pixel row of a y voxel (differs from `ny_vox - 1 - y` when the in-plane spacing is anisotropic).
pub fn y_vox_to_axial_row(y_vox: i64, ny_vox: i64, py: i64) -> i64 {
    if ny_vox <= 1 {
        return 0;
    }
    py_round(((ny_vox - 1 - y_vox) * (py - 1)) as f64 / (ny_vox - 1) as f64)
}

// ---------------------------------------------------------------------------------------------------------
// tiles
// ---------------------------------------------------------------------------------------------------------

fn decode_mask(png: &[u8], red: bool) -> Option<(u32, u32, Tile)> {
    let img = image::load_from_memory_with_format(png, ImageFormat::Png).ok()?;
    let (w, h) = (img.width(), img.height());
    let mask = if red {
        img.to_rgb8()
            .pixels()
            .map(|p| u8::from(p.0[0] > 127))
            .collect()
    } else {
        img.to_luma8()
            .pixels()
            .map(|p| u8::from(p.0[0] > 127))
            .collect()
    };
    Some((w, h, mask))
}

fn encode_mask(mask: &[u8], w: u32, h: u32) -> Vec<u8> {
    let gray: Vec<u8> = mask.iter().map(|v| if *v > 0 { 255 } else { 0 }).collect();
    let mut out = Vec::new();
    image::codecs::png::PngEncoder::new(&mut out)
        .write_image(&gray, w, h, image::ExtendedColorType::L8)
        .expect("png of a mask");
    out
}

async fn load_tiles(
    s: &AppState,
    annotation: i64,
    tx: i64,
    ty: i64,
    frames: &[i64],
) -> ApiResult<HashMap<i64, Tile>> {
    let rows = sqlx::query(
        "SELECT frame, data FROM annotations_segmentationtile WHERE annotation_id = $1 AND level = 0 AND tile_x = $2 AND tile_y = $3 AND frame = ANY($4)",
    )
    .bind(annotation)
    .bind(tx as i32)
    .bind(ty as i32)
    .bind(frames.iter().map(|f| *f as i32).collect::<Vec<_>>())
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(rows
        .iter()
        .filter_map(|r| {
            let (w, h, m) = decode_mask(&r.get::<Vec<u8>, _>(1), false)?;
            (w as usize == T && h as usize == T).then(|| (r.get::<i32, _>(0) as i64, m))
        })
        .collect())
}

/// Stores an axial tile (an empty one is removed).
async fn save_axial(
    s: &AppState,
    annotation: i64,
    tx: i64,
    ty: i64,
    z: i64,
    mask: &[u8],
) -> ApiResult<()> {
    if mask.iter().all(|v| *v == 0) {
        sqlx::query("DELETE FROM annotations_segmentationtile WHERE annotation_id = $1 AND level = 0 AND tile_x = $2 AND tile_y = $3 AND frame = $4")
            .bind(annotation)
            .bind(tx as i32)
            .bind(ty as i32)
            .bind(z as i32)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
        return Ok(());
    }
    store_axial(
        s,
        annotation,
        tx,
        ty,
        z,
        &encode_mask(mask, T as u32, T as u32),
    )
    .await
}

async fn store_axial(
    s: &AppState,
    annotation: i64,
    tx: i64,
    ty: i64,
    z: i64,
    png: &[u8],
) -> ApiResult<()> {
    sqlx::query(
        "INSERT INTO annotations_segmentationtile (annotation_id, level, tile_x, tile_y, frame, data) VALUES ($1, 0, $2, $3, $4, $5) \
         ON CONFLICT (annotation_id, level, tile_x, tile_y, frame) DO UPDATE SET data = EXCLUDED.data",
    )
    .bind(annotation)
    .bind(tx as i32)
    .bind(ty as i32)
    .bind(z as i32)
    .bind(png)
    .execute(&s.pool)
    .await
    .map_err(db_err)?;
    Ok(())
}

/// Where a coronal tile (plane image of height `ph`) takes its rows from: `(axial tile row, row inside it, z of each row)`.
fn coronal_map(
    ty: i64,
    y_frame: i64,
    ny: i64,
    nz: i64,
    ph: i64,
    ny_vox: i64,
) -> (i64, usize, Vec<i64>) {
    let y_vox = (y_frame + 1).clamp(0, (ny_vox - 1).max(0));
    let row = y_vox_to_axial_row(y_vox, ny_vox, ny);
    let zs = (0..T as i64)
        .map(|r| z_vox_for_row(ty * T as i64 + r, nz, ph))
        .collect();
    (row / T as i64, (row % T as i64) as usize, zs)
}

fn sagittal_map(ty: i64, x_frame: i64, nx: i64, nz: i64, ph: i64) -> (i64, usize, Vec<i64>) {
    let x_vox = (x_frame + 1).clamp(0, (nx - 1).max(0));
    let zs = (0..T as i64)
        .map(|r| z_vox_for_row(ty * T as i64 + r, nz, ph))
        .collect();
    (
        (nx - 1 - x_vox) / T as i64,
        ((nx - 1 - x_vox) % T as i64) as usize,
        zs,
    )
}

fn unique(zs: &[i64]) -> Vec<i64> {
    let mut u = zs.to_vec();
    u.sort_unstable();
    u.dedup();
    u
}

// ---------------------------------------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------------------------------------

struct Target {
    image: i64,
}

async fn annotation_for(s: &AppState, p: &Principal, id: i64, edit: bool) -> ApiResult<Target> {
    let row = annotation_row(s, id)
        .await?
        .ok_or_else(|| ApiError::not_found("No Annotation matches the given query."))?;
    let pm = set_perms(s, p, row.set_id).await?;
    if !pm.read {
        return Err(ApiError::not_found(
            "No Annotation matches the given query.",
        ));
    }
    if row.vector_type != 8 {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Annotation is not a segmentation type.",
        ));
    }
    if edit && !pm.edit_annotation {
        return Err(ApiError::detail(
            StatusCode::FORBIDDEN,
            "permission for editing annotations in this image set missing.",
        ));
    }
    Ok(Target {
        image: row.image_id,
    })
}

async fn dims(s: &AppState, image: i64) -> ApiResult<(i64, i64, i64)> {
    let r = sqlx::query("SELECT width, height, frames FROM images_image WHERE id = $1")
        .bind(image)
        .fetch_one(&s.pool)
        .await
        .map_err(db_err)?;
    Ok((
        r.get::<i32, _>(0) as i64,
        r.get::<i32, _>(1) as i64,
        r.get::<i32, _>(2) as i64,
    ))
}

fn png_response(bytes: Vec<u8>) -> Response {
    ([(header::CONTENT_TYPE, "image/png")], bytes).into_response()
}

/// `GET /api/v2/segmentation/{annotation}/tiles?frame=`: which axial tiles of the slice exist (`{"tiles": [[x, y], ...]}`), so that
/// a viewer asks only for those; the rest of the mask is empty.
async fn index(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(annotation): Path<i64>,
    Query(q): Query<Q>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    annotation_for(&s, &p, annotation, false).await?;
    let rows = sqlx::query(
        "SELECT tile_x, tile_y FROM annotations_segmentationtile WHERE annotation_id = $1 AND level = 0 AND frame = $2 ORDER BY tile_y, tile_x",
    )
    .bind(annotation)
    .bind(q.frame as i32)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let tiles: Vec<[i32; 2]> = rows.iter().map(|r| [r.get(0), r.get(1)]).collect();
    Ok(axum::Json(serde_json::json!({ "tiles": tiles })).into_response())
}

async fn get_tile(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((annotation, plane, tx, ty)): Path<(i64, i64, i64, i64)>,
    Query(q): Query<Q>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let t = annotation_for(&s, &p, annotation, false).await?;
    if plane == 0 {
        let data: Option<Vec<u8>> = sqlx::query_scalar(
            "SELECT data FROM annotations_segmentationtile WHERE annotation_id = $1 AND level = 0 AND tile_x = $2 AND tile_y = $3 AND frame = $4",
        )
        .bind(annotation)
        .bind(tx as i32)
        .bind(ty as i32)
        .bind(q.frame as i32)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?;
        return Ok(match data {
            Some(d) => png_response(d),
            None => StatusCode::NO_CONTENT.into_response(),
        });
    }
    let (nx, ny, nz) = dims(&s, t.image).await?;
    let ph = q.ph.unwrap_or(nz);
    let mut out: Tile = vec![0; T * T];
    if plane == 1 {
        let ny_vox = if q.nf > 0 { q.nf } else { ny };
        let (ax_ty, ax_i, zs) = coronal_map(ty, q.frame, ny, nz, ph, ny_vox);
        let tiles = load_tiles(&s, annotation, tx, ax_ty, &unique(&zs)).await?;
        for (r, z) in zs.iter().enumerate() {
            if let Some(t) = tiles.get(z) {
                out[r * T..(r + 1) * T].copy_from_slice(&t[ax_i * T..(ax_i + 1) * T]);
            }
        }
    } else {
        let (ax_tx, ax_j, zs) = sagittal_map(ty, q.frame, nx, nz, ph);
        let tiles = load_tiles(&s, annotation, ax_tx, tx, &unique(&zs)).await?;
        for (r, z) in zs.iter().enumerate() {
            if let Some(t) = tiles.get(z) {
                for c in 0..T {
                    out[r * T + c] = t[c * T + ax_j];
                }
            }
        }
    }
    if out.iter().all(|v| *v == 0) {
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    Ok(png_response(encode_mask(&out, T as u32, T as u32)))
}

async fn put_tile(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((annotation, plane, tx, ty)): Path<(i64, i64, i64, i64)>,
    Query(q): Query<Q>,
    body: Bytes,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::PUT).await?)?;
    let t = annotation_for(&s, &p, annotation, true).await?;
    if body.is_empty() {
        return Err(ApiError::detail(StatusCode::BAD_REQUEST, "Empty body."));
    }
    let (w, h, mask) = decode_mask(&body, true)
        .ok_or_else(|| ApiError::detail(StatusCode::BAD_REQUEST, "Could not decode PNG."))?;
    if plane == 0 {
        store_axial(&s, annotation, tx, ty, q.frame, &encode_mask(&mask, w, h)).await?;
        return Ok(StatusCode::NO_CONTENT.into_response());
    }
    if w as usize != T || h as usize != T {
        return Err(ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Tiles of the coronal and sagittal planes are 256 x 256 pixels.",
        ));
    }
    let (nx, ny, nz) = dims(&s, t.image).await?;
    let ph = q.ph.unwrap_or(nz);
    if plane == 1 {
        let ny_vox = if q.nf > 0 { q.nf } else { ny };
        let (ax_ty, ax_i, zs) = coronal_map(ty, q.frame, ny, nz, ph, ny_vox);
        let mut tiles = load_tiles(&s, annotation, tx, ax_ty, &unique(&zs)).await?;
        // several rows of the plane can share one z: their union is written
        let mut rows: HashMap<i64, Vec<u8>> = HashMap::new();
        for (r, z) in zs.iter().enumerate() {
            let row = &mask[r * T..(r + 1) * T];
            rows.entry(*z)
                .and_modify(|e| e.iter_mut().zip(row).for_each(|(a, b)| *a = (*a).max(*b)))
                .or_insert_with(|| row.to_vec());
        }
        for (z, row) in rows {
            let mut arr = tiles.remove(&z).unwrap_or_else(|| vec![0; T * T]);
            arr[ax_i * T..(ax_i + 1) * T].copy_from_slice(&row);
            save_axial(&s, annotation, tx, ax_ty, z, &arr).await?;
        }
    } else {
        let (ax_tx, ax_j, zs) = sagittal_map(ty, q.frame, nx, nz, ph);
        let mut tiles = load_tiles(&s, annotation, ax_tx, tx, &unique(&zs)).await?;
        let mut cols: HashMap<i64, Vec<u8>> = HashMap::new();
        for (r, z) in zs.iter().enumerate() {
            let row = &mask[r * T..(r + 1) * T];
            cols.entry(*z)
                .and_modify(|e| e.iter_mut().zip(row).for_each(|(a, b)| *a = (*a).max(*b)))
                .or_insert_with(|| row.to_vec());
        }
        for (z, col) in cols {
            let mut arr = tiles.remove(&z).unwrap_or_else(|| vec![0; T * T]);
            for (c, v) in col.iter().enumerate() {
                arr[c * T + ax_j] = *v;
            }
            save_axial(&s, annotation, ax_tx, tx, z, &arr).await?;
        }
    }
    Ok(StatusCode::NO_CONTENT.into_response())
}

async fn delete_tile(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path((annotation, plane, tx, ty)): Path<(i64, i64, i64, i64)>,
    Query(q): Query<Q>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::DELETE).await?)?;
    annotation_for(&s, &p, annotation, true).await?;
    if plane == 0 {
        sqlx::query("DELETE FROM annotations_segmentationtile WHERE annotation_id = $1 AND level = 0 AND tile_x = $2 AND tile_y = $3 AND frame = $4")
            .bind(annotation)
            .bind(tx as i32)
            .bind(ty as i32)
            .bind(q.frame as i32)
            .execute(&s.pool)
            .await
            .map_err(db_err)?;
    } // the other planes live in the axial tiles: nothing to delete
    Ok(StatusCode::NO_CONTENT.into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn python_rounding_goes_to_the_even_number() {
        assert_eq!(
            [0.5, 1.5, 2.5, -0.5, 2.4, 2.6].map(py_round),
            [0, 2, 2, 0, 2, 3]
        );
    }

    #[test]
    fn rows_of_a_plane_map_to_slices_with_the_top_at_the_last_slice() {
        // isotropic: plane height = number of slices
        assert_eq!(z_vox_for_row(0, 10, 10), 9);
        assert_eq!(z_vox_for_row(9, 10, 10), 0);
        // stretched plane (thick slices): 10 slices shown in 20 rows
        assert_eq!(z_vox_for_row(0, 10, 20), 9);
        assert_eq!(z_vox_for_row(19, 10, 20), 0);
        assert_eq!(z_vox_for_row(5, 10, 20), 9 - py_round(5.0 * 9.0 / 19.0));
        // beyond the plane it stays in range
        assert_eq!(z_vox_for_row(500, 10, 10), 0);
        assert_eq!(z_vox_for_row(3, 10, 1), 6);
    }

    #[test]
    fn y_voxels_map_to_axial_rows() {
        assert_eq!(y_vox_to_axial_row(0, 8, 8), 7);
        assert_eq!(y_vox_to_axial_row(7, 8, 8), 0);
        assert_eq!(y_vox_to_axial_row(0, 1, 8), 0);
        assert_eq!(y_vox_to_axial_row(0, 4, 8), 7);
    }

    #[test]
    fn masks_round_trip_through_png() {
        let mut m = vec![0u8; T * T];
        m[5 * T + 7] = 1;
        let png = encode_mask(&m, T as u32, T as u32);
        let (w, h, back) = decode_mask(&png, false).unwrap();
        assert_eq!((w as usize, h as usize), (T, T));
        assert_eq!(back, m);
        // a PNG sent by the viewer has the mask in the red channel
        let (_, _, red) = decode_mask(&png, true).unwrap();
        assert_eq!(red, m);
    }
}
