"""Helper for the Rust server: converts points through the pickled quad tree of a registration (`qt-wsi-registration`).

    registration_helper.py convert <pickle file>        reads [[x, y], ...] as JSON on stdin, prints the converted points
    registration_helper.py grid <pickle file> <width> <height> [--invert]
                                                        prints the registration as a grid (see `grid`), for the viewer

Needs `qt-wsi-registration` in the Python it runs with (REGISTRATION_PYTHON) and REGISTRATION_EXACT_DIR in the server's environment.
The server starts it only for registrations that have a pickle (`images_imageregistration.file`); registrations that
have just a matrix are converted by the server itself.
"""
import json
import os
import pickle
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # `python -I` does not: dhr_transform is unpickled from here

# the pickled tree holds EXACT's slide objects (`util.slide_server`, ...): they unpickle only with EXACT's code on the path
# (`python -I` ignores PYTHONPATH, hence REGISTRATION_EXACT_DIR: the `exact` folder of an EXACT checkout)
if os.environ.get("REGISTRATION_EXACT_DIR"):
    sys.path.insert(0, os.environ["REGISTRATION_EXACT_DIR"])


GRID_CELLS = 24  # cells per side of the grid the viewer warps the overlay with
FLAT = 2.0  # a registration that stays this close (pixels) to its best affine map needs no warp


def grid(qt, width, height, invert):
    """The registration as `{"xs": [...], "ys": [...], "dst": [[[x, y], ...], ...]}`: for the grid points `(xs[j], ys[i])` of the
    source image the point `dst[i][j]` of the target image (`invert`: of the target image the point of the source image, so that
    the grid is in the pixels of the image that is looked at). None when the registration is an affine map anyway."""
    import numpy as np

    xs = np.linspace(0, width, GRID_CELLS + 1)
    ys = np.linspace(0, height, GRID_CELLS + 1)
    gx, gy = np.meshgrid(xs, ys)
    src = np.stack([gx.ravel(), gy.ravel()], axis=1)
    out = np.asarray(qt.transform_boxes([[x, y, 0, 0] for x, y in src]), dtype=np.float64)[:, :2]
    a = np.hstack([src, np.ones((len(src), 1))])
    coef, *_ = np.linalg.lstsq(a, out, rcond=None)
    if np.abs(a @ coef - out).max() < FLAT:
        return None
    if not invert:
        return {"xs": xs.tolist(), "ys": ys.tolist(), "dst": out.reshape(len(ys), len(xs), 2).tolist()}
    from scipy.interpolate import griddata

    # a regular grid over where the source image lands; every point of it gets the source point that maps there
    txs = np.linspace(out[:, 0].min(), out[:, 0].max(), GRID_CELLS + 1)
    tys = np.linspace(out[:, 1].min(), out[:, 1].max(), GRID_CELLS + 1)
    tx, ty = np.meshgrid(txs, tys)
    back = np.empty((len(tys) * len(txs), 2))
    for c in (0, 1):
        back[:, c] = griddata(out, src[:, c], (tx.ravel(), ty.ravel()), method="linear")
    gaps = np.isnan(back).any(axis=1)
    if gaps.any():  # outside the hull of the mapped points: the inverse of the affine fit continues it
        m = np.eye(3)
        m[:2, :] = coef.T
        inv = np.linalg.inv(m)
        t = np.stack([tx.ravel()[gaps], ty.ravel()[gaps], np.ones(gaps.sum())], axis=1)
        back[gaps] = (t @ inv.T)[:, :2]
    return {"xs": txs.tolist(), "ys": tys.tolist(), "dst": back.reshape(len(tys), len(txs), 2).tolist()}


def main() -> int:
    if len(sys.argv) >= 5 and sys.argv[1] == "grid":
        with open(sys.argv[2], "rb") as f:
            qt = pickle.load(f)
        json.dump(grid(qt, float(sys.argv[3]), float(sys.argv[4]), "--invert" in sys.argv[5:]), sys.stdout)
        return 0
    if len(sys.argv) != 3 or sys.argv[1] != "convert":
        print(__doc__, file=sys.stderr)
        return 2
    with open(sys.argv[2], "rb") as f:
        qt = pickle.load(f)
    points = json.load(sys.stdin)
    boxes = qt.transform_boxes([[x, y, 0, 0] for x, y in points])
    json.dump([[float(b[0]), float(b[1])] for b in boxes], sys.stdout)
    return 0


if __name__ == "__main__":
    sys.exit(main())
