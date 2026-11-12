"""Registration plugin: DeeperHistReg (or SIFT) for the rough alignment, then a classical refinement on the slides themselves.

The feature based methods are robust (they find the right section pair of any stain) but work on an overview, where one pixel is
many micrometres: the matrix is typically a few pixels of the overview off, which is hundreds of pixels at full resolution. This plugin
keeps their robustness and adds the accuracy:

1. **Rough alignment** by DeeperHistReg (SuperPoint/SuperGlue and SIFT, good also for faint stains) on overviews of the tissue; where
   DeeperHistReg is not installed, SIFT on structure images with RANSAC (and a search over rotations when that finds too little).
2. **Pyramid** (helpers/refine_affine.py): from a few hundred pixels to several thousand across the tissue, the enhanced correlation
   coefficient (ECC) of stain independent structure images corrects the affine matrix, every level starting from the one before.
3. **Tiles**: at the finest level the shift of overlapping tiles is measured by phase correlation and a robust affine fit over them
   corrects the matrix again, a few recursions; tiles where the sections really differ are outliers and do not count.

Every step is kept only if the two slides then agree better. The result is the affine matrix (no deformation file), and the
registration error is the median shift that the tiles still show after it, in target pixels.
"""
import pathlib
import sys
import time

import numpy as np

HELPERS = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HELPERS))
import refine_affine as ra  # noqa: E402
from queue_plugin import RegistrationPlugin, RegistrationResult, param  # noqa: E402
from plugins_common import open_slide  # noqa: E402


class MultiStageRegistration(RegistrationPlugin):
    name = "Multi-stage registration (features + refinement)"
    author = "DeepMicroscopy"
    package = "refine_affine"
    abouturl = "https://github.com/DeepMicroscopy/Exact-Rust"
    parameters = [
        param("initial", "choice", "auto", "Rough alignment", "DeeperHistReg when it is installed on the worker, else SIFT; pick one to force it.",
              choices=["auto", "deeperhistreg", "sift"]),
        param("transform_type", "choice", "affine", "Rough transform", "DeeperHistReg's initial transform: rigid (rotation, shift) or affine.", choices=["rigid", "affine"]),
        param("thumbnail_size", "int", 4096, "Overview size", "Longer edge in pixels of the overviews of the rough alignment.", min=512, max=16384),
        param("registration_size", "int", 2048, "Registration size", "DeeperHistReg: longer edge in pixels the alignment is computed on (lower it on 'CUDA out of memory').", min=256, max=8192),
        param("device", "choice", "auto", "Device", "DeeperHistReg: auto uses the GPU when there is one.", choices=["auto", "cpu", "cuda:0"]),
        param("angle_step", "int", 60, "Angle step", "Degrees between the start rotations that are tried (smaller is slower).", min=5, max=180),
        param("refine", "bool", True, "Refine", "Improve the rough matrix on the slides themselves (off: the rough alignment alone)."),
        param("refine_size", "int", 4096, "Refinement resolution", "Longer side in pixels of the tissue at the finest refinement level; higher is more exact and slower.", min=1024, max=8192),
        param("tile_size", "int", 192, "Tile size", "Side in pixels of the tiles whose shifts are measured at the finest level.", min=64, max=512),
        param("rounds", "int", 3, "Recursions", "How often the tiles are measured again on the improved matrix.", min=1, max=8),
    ]

    def unavailable(self):
        try:
            import cv2  # noqa: F401
        except Exception as e:  # noqa: BLE001
            return f"{e.__class__.__name__}: {e}; pip install opencv-python-headless"
        return None

    def register(self, source_path, target_path, params, ctx):
        import coarse_align

        started = time.time()
        src_slide, tgt_slide = open_slide(source_path, ctx.exact_dir), open_slide(target_path, ctx.exact_dir)
        box_src, box_tgt = ra.tissue_bounds(ra.SlideReader(src_slide)), ra.tissue_bounds(ra.SlideReader(tgt_slide))
        ctx.log(f"tissue at {[round(v) for v in box_src]} and {[round(v) for v in box_tgt]}")
        method = params["initial"]
        if method == "auto":
            method = "deeperhistreg" if coarse_align.dhr_available() else "sift"
        if method == "deeperhistreg" and not coarse_align.dhr_available():
            raise ValueError("DeeperHistReg is not installed in this Python (pip install deeperhistreg); choose SIFT or auto.")
        coarse = coarse_align.deeperhistreg_affine if method == "deeperhistreg" else coarse_align.sift_affine
        m0, coarse_error = coarse(src_slide, tgt_slide, box_src, box_tgt, params, ctx.log)
        ctx.log(f"rough alignment ({method}) done after {time.time() - started:.0f} s")
        m, error = m0, coarse_error
        if params["refine"]:
            opt = ra.Options(work_edge=int(params["refine_size"]), tile=int(params["tile_size"]), rounds=int(params["rounds"]))
            m, report = ra.refine(ra.SlideReader(src_slide), ra.SlideReader(tgt_slide), m0, box_tgt, opt, ctx.log)
            for step in report.steps:
                ctx.log("  " + step)
            ctx.log(f"refinement moved the corners of the source tissue by up to {corner_shift(m0, m, box_src):.0f} px")
            if np.isfinite(report.error):
                error = report.error
        if not np.isfinite(error):
            error = 0.0
        return RegistrationResult(matrix={f"t_{i}{j}": float(m[i][j]) for i in range(3) for j in range(3)}, error=float(error),
                                  runtime=int(time.time() - started), file=None)


def corner_shift(m_a, m_b, box):
    """How far (target pixels) two matrices put the corners of `box` (source pixels) apart."""
    x, y, w, h = box
    p = np.array([[x, y, 1], [x + w, y, 1], [x, y + h, 1], [x + w, y + h, 1]], dtype=np.float64).T
    return float(np.linalg.norm((np.asarray(m_a) @ p)[:2] - (np.asarray(m_b) @ p)[:2], axis=0).max())


PLUGINS = [MultiStageRegistration()]
