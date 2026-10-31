//! Data for the 3D render of the three-plane view: the volume and the mask on a coarse grid, as raw bytes the browser puts into
//! 3D textures.
//!
//! - `GET /api/v2/images/{id}/render-volume?max=`: the grey values (display range, 0..255) averaged onto at most `max` cells along the
//!   longest side, in the axes of the mask grid (column, row, slice); the cells are about cubic in mm
//! - `GET /api/v2/segmentation/{annotation}/render-mask?max=`: the same grid, per cell how much of it is mask
//!
//! Both answer with the headers `x-dims` (`columns,rows,slices`) and `x-extent-mm` (`x,y,z`).

use crate::{
    auth::{authenticate, require_user},
    compat::writes::{image_row, set_perms},
    error::{ApiError, ApiResult},
    v2::{
        seg3d::load_entry,
        seg_jobs::open_volume,
        segmentation::annotation_for,
        volmask::{cells_to_bytes, Geometry},
    },
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use serde::Deserialize;
use std::sync::{Arc, OnceLock};

pub fn v2_routes() -> Router<AppState> {
    Router::new()
        .route("/api/v2/images/{id}/render-volume", get(volume_h))
        .route("/api/v2/segmentation/{annotation}/render-mask", get(mask_h))
}

#[derive(Deserialize)]
struct Q {
    max: Option<usize>,
}

/// Cells along each axis: the longest side gets `max`, the others in proportion to their length in mm (never more than the voxels).
pub(crate) fn render_dims(g: &Geometry, max: usize) -> (usize, usize, usize) {
    let max = max.clamp(32, 512);
    let longest = g.ext.iter().cloned().fold(0.0, f64::max).max(1e-9);
    let side =
        |len: f64, n: usize| ((len / longest * max as f64).round() as usize).clamp(1, n.max(1));
    (
        side(g.ext[0], g.w),
        side(g.ext[1], g.h),
        side(g.ext[2], g.n),
    )
}

fn answer(g: &Geometry, dims: (usize, usize, usize), body: Vec<u8>) -> Response {
    let hv = |v: String| header::HeaderValue::from_str(&v).expect("ascii");
    let mut r = Response::new(axum::body::Body::from(body));
    let h = r.headers_mut();
    h.insert(header::CONTENT_TYPE, hv("application/octet-stream".into()));
    h.insert("x-dims", hv(format!("{},{},{}", dims.0, dims.1, dims.2)));
    h.insert(
        "x-extent-mm",
        hv(format!("{},{},{}", g.ext[0], g.ext[1], g.ext[2])),
    );
    h.insert(header::CACHE_CONTROL, hv("private, max-age=600".into()));
    r
}

type Rendered = (Geometry, (usize, usize, usize), Arc<Vec<u8>>);

fn volumes() -> &'static moka::sync::Cache<(i64, usize), Rendered> {
    static C: OnceLock<moka::sync::Cache<(i64, usize), Rendered>> = OnceLock::new();
    C.get_or_init(|| {
        moka::sync::Cache::builder()
            .max_capacity(8)
            .time_to_idle(std::time::Duration::from_secs(900))
            .build()
    })
}

async fn volume_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(image): Path<i64>,
    Query(q): Query<Q>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let img = image_row(&s, image)
        .await?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    if !set_perms(&s, &p, img.set_id).await?.read {
        return Err(ApiError::not_found("No Image matches the given query."));
    }
    let max = q.max.unwrap_or(256).clamp(32, 512);
    if let Some((g, d, v)) = volumes().get(&(image, max)) {
        return Ok(answer(&g, d, v.as_ref().clone()));
    }
    let (slide, g) = open_volume(&s, image).await?;
    let dims = render_dims(&g, max);
    let (w, h, n) = (g.w, g.h, g.n);
    let vol = tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let (ow, oh, od) = dims;
        let cell = |i: usize, n: usize, o: usize| i * o / n;
        let per_axis = |n: usize, o: usize| {
            let mut c = vec![0u32; o];
            for i in 0..n {
                c[cell(i, n, o)] += 1;
            }
            c
        };
        let (cw, ch, cd) = (per_axis(w, ow), per_axis(h, oh), per_axis(n, od));
        let col: Vec<usize> = (0..w).map(|i| cell(i, w, ow)).collect();
        let mut sum = vec![0u32; ow * oh * od];
        for z in 0..n {
            let img = slide
                .read_region_plane(0, 0, 0, w as u32, h as u32, z as u32, 0)
                .map_err(|e| e.to_string())?;
            let k = cell(z, n, od);
            let raw = img.as_raw();
            let ch_n = raw.len() / (w * h).max(1);
            for r in 0..h {
                let base = (k * oh + cell(r, h, oh)) * ow;
                for (c, &oc) in col.iter().enumerate() {
                    let px = &raw[(r * w + c) * ch_n..];
                    let g = if ch_n >= 3 {
                        (px[0] as u32 * 299 + px[1] as u32 * 587 + px[2] as u32 * 114) / 1000
                    } else {
                        px[0] as u32
                    };
                    sum[base + oc] += g;
                }
            }
        }
        let out = cells_to_bytes(&sum, dims, [&cw, &ch, &cd], |s, full| (s / full) as u8);
        Ok(out)
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))?
    .map_err(|e| {
        ApiError::detail(
            StatusCode::BAD_REQUEST,
            format!("The image cannot be read: {e}"),
        )
    })?;
    let vol = Arc::new(vol);
    volumes().insert((image, max), (g.clone(), dims, vol.clone()));
    Ok(answer(&g, dims, vol.as_ref().clone()))
}

async fn mask_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(annotation): Path<i64>,
    Query(q): Query<Q>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let t = annotation_for(&s, &p, annotation, false).await?;
    let open = load_entry(&s, annotation, &t).await?;
    let e = open.lock().await;
    let g = e.geom.clone();
    let dims = render_dims(&g, q.max.unwrap_or(256));
    let body = e.vol.coverage(&g, dims);
    drop(e);
    Ok(answer(&g, dims, body))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geom() -> Geometry {
        Geometry {
            w: 400,
            h: 100,
            n: 200,
            nx: 400,
            ny: 100,
            nz: 200,
            ext: [200.0, 50.0, 100.0],
            cor: (400, 200),
            sag: (100, 200),
        }
    }

    #[test]
    fn the_cells_follow_the_lengths_in_mm() {
        assert_eq!(render_dims(&geom(), 100), (100, 25, 50));
        // never more cells than voxels
        assert_eq!(render_dims(&geom(), 512), (400, 100, 200));
    }

    #[test]
    fn a_mask_is_counted_by_how_much_of_a_cell_it_fills() {
        use crate::v2::volmask::MaskVol;
        let g = geom();
        // one slice, columns 0..4 and rows 0..4 of 4 x 4 voxels per cell (100 x 25 x 50 cells: 4 x 4 x 4 voxels each)
        let mut t = vec![0u8; 256 * 256].into_boxed_slice();
        for r in 0..2 {
            for c in 0..4 {
                t[r * 256 + c] = 1;
            }
        }
        let m = MaskVol::from_tiles([((0, 0, 0), t.try_into().unwrap())]);
        let out = m.coverage(&g, (100, 25, 50));
        // 2 of the 4 rows, one of the 4 slices: 8 of 64 voxels
        assert_eq!(out[0], 32);
        assert_eq!(out.iter().filter(|v| **v > 0).count(), 1);
    }
}
