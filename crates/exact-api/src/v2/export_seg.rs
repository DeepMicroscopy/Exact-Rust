//! `GET /api/v2/images/{id}/export-segmentation?format=nrrd|nifti&types=1,2`: the masks (segmentation annotations) of a NIfTI
//! volume as one file for other programs, on the volume's own voxel grid and in its position in space:
//!
//! * `nrrd` (default): a 3D Slicer segmentation (`.seg.nrrd`), a segment per segmentation type with its name and colour; masks
//!   that overlap go to separate layers, as Slicer does, so nothing is lost
//! * `nifti`: a label map (`.nii.gz`), the segment of a type has the value of its place in the list (overlaps: the later type)
//!
//! Masks are on the volume's axial picture; the voxels take the nearest picture pixel. Needs read access to the image.

use crate::{
    auth::{authenticate, require_user},
    compat::{engine::db_err, writes::set_perms},
    error::{ApiError, ApiResult},
    v2::seg3d::mask_bytes,
    AppState,
};
use axum::{
    extract::{Path, Query, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use exact_wsi::nrrd::{display_to_voxels, write_seg, OutSegment};
use serde::Deserialize;
use sqlx::Row;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/v2/images/{id}/export-segmentation", get(export_h))
}

#[derive(Deserialize)]
struct Q {
    format: Option<String>,
    /// segmentation types to export (default: all that have a mask with voxels)
    types: Option<String>,
}

/// Puts the voxels of `mask` (non-zero) into the first layer that is free there, else into a new layer, as `label`; returns the layer.
fn place(layers: &mut Vec<Vec<u16>>, mask: &[u8], label: u16) -> usize {
    let free = |l: &Vec<u16>| !mask.iter().zip(l).any(|(m, v)| *m != 0 && *v != 0);
    let at = layers.iter().position(free).unwrap_or_else(|| {
        layers.push(vec![0u16; mask.len()]);
        layers.len() - 1
    });
    for (m, v) in mask.iter().zip(layers[at].iter_mut()) {
        if *m != 0 {
            *v = label;
        }
    }
    at
}

async fn export_h(
    State(s): State<AppState>,
    headers: HeaderMap,
    Path(image): Path<i64>,
    Query(q): Query<Q>,
) -> ApiResult<Response> {
    let p = require_user(authenticate(&s, &headers, &Method::GET).await?)?;
    let img = sqlx::query("SELECT i.filename, i.name, i.image_set_id::bigint, st.path FROM images_image i JOIN images_imageset st ON st.id = i.image_set_id WHERE i.id = $1")
        .bind(image)
        .fetch_optional(&s.pool)
        .await
        .map_err(db_err)?
        .ok_or_else(|| ApiError::not_found("No Image matches the given query."))?;
    if !set_perms(&s, &p, img.get::<i64, _>(2)).await?.read {
        return Err(ApiError::not_found("No Image matches the given query."));
    }
    let nifti = match q.format.as_deref() {
        None | Some("nrrd") => false,
        Some("nifti") => true,
        Some(_) => {
            return Err(ApiError::detail(
                StatusCode::BAD_REQUEST,
                "format is \"nrrd\" or \"nifti\".",
            ))
        }
    };
    let wanted: Option<Vec<i64>> = q
        .types
        .as_deref()
        .map(|t| t.split(',').filter_map(|v| v.trim().parse().ok()).collect());
    let path = s
        .slides
        .root()
        .join(img.get::<String, _>(3))
        .join(img.get::<String, _>(0));
    let grid = tokio::task::spawn_blocking(move || {
        exact_wsi::nifti::Nifti::open(&path.to_string_lossy())
            .ok()
            .and_then(|v| v.grid())
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))?
    .ok_or_else(|| {
        ApiError::detail(
            StatusCode::BAD_REQUEST,
            "Masks can be exported for NIfTI volumes only.",
        )
    })?;
    // the masks, a segment per type (several masks of one type are united)
    let rows = sqlx::query(
        "SELECT a.id::bigint, t.id::bigint, t.name, t.color_code FROM annotations_annotation a \
         JOIN annotations_annotationtype t ON t.id = a.annotation_type_id \
         WHERE a.image_id = $1 AND NOT a.deleted AND t.vector_type = 8 ORDER BY t.sort_order, t.name, t.id, a.id",
    )
    .bind(image)
    .fetch_all(&s.pool)
    .await
    .map_err(db_err)?;
    let (w, h) = grid.planes[0];
    let n = grid.shape[2];
    let mut layers: Vec<Vec<u16>> = Vec::new();
    let mut segments: Vec<OutSegment> = Vec::new();
    let mut at = 0;
    while at < rows.len() {
        let type_id: i64 = rows[at].get(1);
        let mut union: Option<Vec<u8>> = None;
        let mut end = at;
        while end < rows.len() && rows[end].get::<i64, _>(1) == type_id {
            end += 1;
        }
        if wanted.as_ref().is_some_and(|w| !w.contains(&type_id)) {
            at = end;
            continue;
        }
        for r in &rows[at..end] {
            let (g, bytes) = mask_bytes(&s, r.get::<i64, _>(0)).await?;
            if (g.w, g.h, g.n) != (w, h, n) {
                return Err(ApiError::detail(
                    StatusCode::BAD_REQUEST,
                    "A mask does not fit the volume's picture.",
                ));
            }
            match &mut union {
                None => union = Some(bytes),
                Some(u) => u.iter_mut().zip(&bytes).for_each(|(a, b)| *a |= *b),
            }
        }
        let name: String = rows[at].get(2);
        let color: String = rows[at].get(3);
        at = end;
        let Some(mask) = union.filter(|m| m.iter().any(|v| *v != 0)) else {
            continue;
        };
        let shape = grid.shape;
        let label = (segments.len() + 1) as u16;
        let (layer, moved) = {
            let layers_in = std::mem::take(&mut layers);
            let (layers_out, layer) = tokio::task::spawn_blocking(move || {
                let mut layers = layers_in;
                let voxels = display_to_voxels(&mask, (w, h), shape);
                let layer = place(&mut layers, &voxels, label);
                (layers, layer)
            })
            .await
            .map_err(|e| exact_core::Error::Internal(e.to_string()))?;
            (layer, layers_out)
        };
        layers = moved;
        let rgb = u32::from_str_radix(color.trim_start_matches('#'), 16).unwrap_or(0xff0000);
        segments.push(OutSegment {
            id: format!("Segment_{label}"),
            name,
            color: [(rgb >> 16) as u8, (rgb >> 8) as u8, rgb as u8],
            label: label as u32,
            layer,
        });
    }
    if segments.is_empty() {
        return Err(ApiError::not_found(
            "There is no mask with voxels in this volume.",
        ));
    }
    let base = {
        let name: String = img.get(1);
        let stem = ["nii.gz", "nii"]
            .iter()
            .find_map(|e| name.strip_suffix(&format!(".{e}")))
            .unwrap_or(&name)
            .replace(['"', '\r', '\n', '/', '\\'], "_");
        if stem.is_empty() {
            "volume".to_string()
        } else {
            stem
        }
    };
    let (shape, affine) = (grid.shape, grid.affine);
    let (bytes, ext) = tokio::task::spawn_blocking(move || {
        if nifti {
            use std::io::Write;
            // one label map: the later layer wins where masks overlap
            let mut one = vec![0u16; shape.iter().product()];
            for l in &layers {
                for (o, v) in one.iter_mut().zip(l) {
                    if *v != 0 {
                        *o = *v;
                    }
                }
            }
            let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            gz.write_all(&exact_wsi::nifti::write_labels(shape, &affine, &one))
                .expect("memory");
            (gz.finish().expect("memory"), "labels.nii.gz")
        } else {
            (
                write_seg(shape, &affine, &layers, &segments),
                "segmentation.seg.nrrd",
            )
        }
    })
    .await
    .map_err(|e| exact_core::Error::Internal(e.to_string()))?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_string()),
            (header::CONTENT_LENGTH, bytes.len().to_string()),
            (
                header::CONTENT_DISPOSITION,
                format!("attachment; filename=\"{base}-{ext}\""),
            ),
        ],
        bytes,
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlapping_masks_get_their_own_layers() {
        let mut layers = vec![];
        assert_eq!(place(&mut layers, &[1, 1, 0, 0], 1), 0);
        assert_eq!(place(&mut layers, &[0, 0, 1, 0], 2), 0); // no overlap: the same layer
        assert_eq!(place(&mut layers, &[0, 1, 1, 0], 3), 1); // overlaps both
        assert_eq!(place(&mut layers, &[0, 0, 0, 1], 4), 0);
        assert_eq!(layers, vec![vec![1, 1, 2, 4], vec![0, 3, 3, 0]]);
    }
}
