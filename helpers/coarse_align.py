"""The first, rough alignment of two slides, which `refine_affine` then makes exact: a matrix (3x3, source slide pixels -> target slide
pixels, level 0) good enough that the two sections lie on top of each other to within a few percent of their size.

- `deeperhistreg_affine`: DeeperHistReg (SIFT and SuperPoint/SuperGlue matching, winner of ACROBAT 2023) on overviews of the tissue; it
  finds matching features also in faint and very differently stained sections. Runs in a process of its own (dhr_run.py).
- `sift_affine`: SIFT matches on structure images (so H&E against an immunostain matches) with RANSAC, for machines without
  DeeperHistReg; when too few matches survive, a search over rotations by phase correlation.
"""
import json
import pathlib
import subprocess
import sys
import tempfile

import cv2
import numpy as np

HELPERS = pathlib.Path(__file__).resolve().parent


def _overview_to_slide(box, scale):
    """3x3: overview pixels -> slide pixels."""
    return np.array([[scale[0], 0, box[0]], [0, scale[1], box[1]], [0, 0, 1]], dtype=np.float64)


def dhr_available():
    import importlib.util

    return all(importlib.util.find_spec(m) is not None for m in ("deeperhistreg", "torch"))


def deeperhistreg_affine(src_slide, tgt_slide, box_src, box_tgt, params, log=print):
    """DeeperHistReg on tissue overviews of `edge` = params["thumbnail_size"] pixels; the matrix is the affine map that fits its
    result best over the source tissue (DhrTransform.affine)."""
    from dhr_transform import DhrTransform
    from plugins_common import render

    edge = int(params["thumbnail_size"])
    with tempfile.TemporaryDirectory(prefix="exact-dhr-") as tmp:
        src, scale_src = render(src_slide, box_src, edge)
        tgt, scale_tgt = render(tgt_slide, box_tgt, edge)
        src.save(f"{tmp}/source.png")
        tgt.save(f"{tmp}/target.png")
        dhr = {"mode": "affine", "transform_type": params.get("transform_type", "affine"), "registration_size": int(params["registration_size"]),
               "device": params.get("device", "auto"), "sift": True, "superglue": True, "angle_step": int(params["angle_step"])}
        pathlib.Path(f"{tmp}/params.json").write_text(json.dumps(dhr))
        log(f"DeeperHistReg on overviews of {src.size} and {tgt.size}")
        run = subprocess.run([sys.executable, str(HELPERS / "dhr_run.py"), tmp], capture_output=True, text=True)
        log(run.stdout[-1500:])
        if run.returncode:
            raise RuntimeError(f"DeeperHistReg failed (exit {run.returncode}):\n{run.stderr[-3000:]}")
        field = np.load(f"{tmp}/field.npy")
        pads = json.load(open(f"{tmp}/padding.json"))
    transform = DhrTransform(field, pads["pad_source"], pads["pad_target"], pads["ratio"], scale_src, scale_tgt, box_src[:2], box_tgt[:2])
    matrix, err = transform.affine(box_src)
    return np.asarray(matrix, dtype=np.float64), err


def _structure_u8(rgb):
    from refine_affine import structure

    f, _ = structure(rgb, 1.2)
    return (f * 255).astype(np.uint8)


def sift_affine(src_slide, tgt_slide, box_src, box_tgt, params, log=print):
    """SIFT on structure images of the tissue overviews, similarity transform by RANSAC; the rotation search when that finds too little."""
    from plugins_common import render

    edge = min(int(params["thumbnail_size"]), 3000)
    src, s_scale = render(src_slide, box_src, edge)
    tgt, t_scale = render(tgt_slide, box_tgt, edge)
    a, b = _structure_u8(np.asarray(src)), _structure_u8(np.asarray(tgt))
    to_src, to_tgt = _overview_to_slide(box_src, s_scale), _overview_to_slide(box_tgt, t_scale)
    sift = cv2.SIFT_create(nfeatures=12000, contrastThreshold=0.02)
    ka, da = sift.detectAndCompute(a, None)
    kb, db = sift.detectAndCompute(b, None)
    if da is not None and db is not None and len(ka) >= 8 and len(kb) >= 8:
        knn = cv2.BFMatcher(cv2.NORM_L2).knnMatch(da, db, k=2)
        good = [m for m, n in (p for p in knn if len(p) == 2) if m.distance < 0.8 * n.distance]
        if len(good) >= 12:
            pa = np.float32([ka[m.queryIdx].pt for m in good])
            pb = np.float32([kb[m.trainIdx].pt for m in good])
            w, inl = cv2.estimateAffinePartial2D(pa, pb, method=cv2.RANSAC, ransacReprojThreshold=max(3.0, edge / 400), maxIters=10000, confidence=0.9999)
            if w is not None and int(inl.sum()) >= 12:
                log(f"SIFT: {int(inl.sum())} of {len(good)} matches agree")
                m = to_tgt @ np.vstack([w, [0, 0, 1]]) @ np.linalg.inv(to_src)
                return m, float("nan")
        log(f"SIFT: only {len(good)} matches, searching rotations")
    return rotation_search(a, b, to_src, to_tgt, int(params.get("angle_step", 30)), log), float("nan")


def rotation_search(a, b, to_src, to_tgt, step, log=print):
    """The rotation (about the centre of the overview, every `step` degrees) and shift that make the structure images correlate best."""
    h, w = b.shape
    size = max(h, w, *a.shape) * 2
    win = cv2.createHanningWindow((size, size), cv2.CV_32F)

    def canvas(img, angle):
        m = cv2.getRotationMatrix2D((img.shape[1] / 2, img.shape[0] / 2), angle, 1.0)
        m[:, 2] += [(size - img.shape[1]) / 2, (size - img.shape[0]) / 2]
        return cv2.warpAffine(img.astype(np.float32) / 255, m, (size, size)), m

    tc, tm = canvas(b, 0)
    best = (-1.0, None)
    for angle in range(0, 360, max(5, step)):
        sc, sm = canvas(a, angle)
        (dx, dy), resp = cv2.phaseCorrelate(tc, sc, win)  # the source content at x + d is the target's at x
        if resp > best[0]:
            best = (resp, (angle, dx, dy, sm))
    angle, dx, dy, sm = best[1]
    log(f"rotation search: {angle} degrees, peak {best[0]:.3f}")
    # overview pixel p of the source -> sm p (canvas) -> canvas position minus d is the target canvas position -> tm^-1 -> target overview
    shift = np.array([[1, 0, -dx], [0, 1, -dy], [0, 0, 1]])
    a_to_b = np.linalg.inv(np.vstack([tm, [0, 0, 1]])) @ shift @ np.vstack([sm, [0, 0, 1]])
    return to_tgt @ a_to_b @ np.linalg.inv(to_src)
