//! DeepZoom level geometry, matching `openslide.deepzoom.DeepZoomGenerator` (without limit_bounds).

/// (width, height) of every DeepZoom level, index 0 = 1x1 pixel level, last = full resolution.
pub fn level_dimensions(width: u64, height: u64) -> Vec<(u64, u64)> {
    let (mut w, mut h) = (width.max(1), height.max(1));
    let mut dims = vec![(w, h)];
    while w > 1 || h > 1 {
        w = w.div_ceil(2).max(1);
        h = h.div_ceil(2).max(1);
        dims.push((w, h));
    }
    dims.reverse();
    dims
}

/// Number of tiles (cols, rows) per level for a given tile size.
pub fn level_tiles(dims: &[(u64, u64)], tile_size: u64) -> Vec<(u64, u64)> {
    dims.iter()
        .map(|&(w, h)| (w.div_ceil(tile_size), h.div_ceil(tile_size)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_pixel() {
        assert_eq!(level_dimensions(1, 1), vec![(1, 1)]);
    }

    #[test]
    fn pyramid_halves_with_ceil() {
        let d = level_dimensions(1000, 500);
        assert_eq!(d.len(), 11);
        assert_eq!(d.first(), Some(&(1, 1)));
        assert_eq!(d.last(), Some(&(1000, 500)));
        assert_eq!(d[d.len() - 2], (500, 250));
        assert_eq!(d[d.len() - 3], (250, 125));
        assert_eq!(d[d.len() - 4], (125, 63));
    }

    #[test]
    fn tile_counts() {
        let d = level_dimensions(1000, 500);
        assert_eq!(*level_tiles(&d, 254).last().unwrap(), (4, 2));
    }
}
