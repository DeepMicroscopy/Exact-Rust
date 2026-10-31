"""Registration plugin: DeeperHistReg (Wodzinski et al., winner of ACROBAT 2023): rigid/affine alignment by SIFT and
SuperPoint/SuperGlue matching, optionally followed by a deformable registration (instance optimisation).

DeeperHistReg reads image files itself, which EXACT's slides are not always (VSI, CZI, ...). The plugin therefore renders an
overview of both slides with EXACT's own readers, registers the overviews and keeps the result as a `DhrTransform`
(helpers/dhr_transform.py): the displacement field with the paddings and scales that lead from slide pixels to it. The matrix
sent to the server is the homography that fits that transform best (all the web UI and exact-sync need for a rigid or affine
result); the transform itself goes along as the registration's file, so that the server converts points through the full
deformation, as it does with the quad tree of qt-wsi-registration. `registration_error` is how far, on average, the matrix is
from the deformable result (target pixels); it is 0 for the rigid and affine modes.
"""
import json
import pathlib
import pickle
import subprocess
import sys
import tempfile
import time

import numpy as np

HELPERS = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HELPERS))
from queue_plugin import RegistrationPlugin, RegistrationResult, param  # noqa: E402
from dhr_transform import DhrTransform  # noqa: E402
from plugins_common import open_slide  # noqa: E402


def render(slide, box, edge):
    """The region `box` = (x, y, w, h) of the slide (level 0 pixels) as a PIL image with its longer side `edge` pixels (or its
    own size when that is smaller). Returns the image and the slide pixels per image pixel (x, y)."""
    from PIL import Image

    x, y, w, h = box
    want = min(edge / max(w, h), 1.0)
    level = 0
    for i, down in enumerate(slide.level_downsamples):  # the coarsest level that still has enough pixels
        if down <= 1.0 / want:
            level = i
    down = slide.level_downsamples[level]
    region = slide.read_region((int(x), int(y)), level, (max(1, round(w / down)), max(1, round(h / down))))
    rgb = Image.new("RGB", region.size, (255, 255, 255))
    rgb.paste(region, mask=region.split()[3] if region.mode == "RGBA" else None)
    size = (max(1, round(w * want)), max(1, round(h * want)))
    if rgb.size != size:
        rgb = rgb.resize(size, Image.LANCZOS)
    return rgb, (w / size[0], h / size[1])


def tissue_box(slide, margin=0.03):
    """Where the tissue is, as (x, y, w, h) in slide pixels: a scan is mostly glass, and registering the whole of it leaves the
    tissue a few hundred pixels of the overview. Found on a coarse overview as everything that is darker than the glass
    (255 - grey > 6 holds for H&E and for very pale IHC); the whole slide when nothing is found."""
    import numpy as np
    from PIL import ImageFilter

    w, h = slide.dimensions
    coarse, (sx, sy) = render(slide, (0, 0, w, h), 1024)
    grey = np.asarray(coarse.convert("L").filter(ImageFilter.MedianFilter(3)), dtype=np.int16)
    ys, xs = np.where(255 - grey > 6)
    if len(xs) < 50:
        return 0, 0, w, h
    x0, x1, y0, y1 = xs.min() * sx, (xs.max() + 1) * sx, ys.min() * sy, (ys.max() + 1) * sy
    mx, my = (x1 - x0) * margin, (y1 - y0) * margin
    x0, y0 = max(0, x0 - mx), max(0, y0 - my)
    x1, y1 = min(w, x1 + mx), min(h, y1 + my)
    return x0, y0, x1 - x0, y1 - y0


class DeeperHistReg(RegistrationPlugin):
    name = "DeeperHistReg"
    author = "Marek Wodzinski"
    package = "deeperhistreg"
    abouturl = "https://github.com/MWod/DeeperHistReg"
    parameters = [
        param("mode", "choice", "affine", "Mode", "Affine finds a rigid or affine alignment; deformable adds a non-rigid registration "
              "(slower, needs a GPU for large slides).", choices=["affine", "deformable"]),
        param("transform_type", "choice", "rigid", "Initial transform", "Rigid: rotation and shift. Affine also scales and shears.", choices=["rigid", "affine"]),
        param("thumbnail_size", "int", 4096, "Overview size", "Longer edge in pixels of the overviews the two slides are rendered to.", min=512, max=16384),
        param("registration_size", "int", 2048, "Registration size", "Longer edge in pixels the alignment is computed on.", min=256, max=8192),
        param("device", "choice", "auto", "Device", "auto uses the GPU when there is one.", choices=["auto", "cpu", "cuda:0"]),
        param("sift", "bool", True, "SIFT + RANSAC", "Match SIFT keypoints (robust, no GPU needed)."),
        param("superglue", "bool", True, "SuperPoint + SuperGlue", "Match learned keypoints (finds more in faint stains)."),
        param("angle_step", "int", 60, "Angle step", "Degrees between the start rotations that are tried (smaller is slower).", min=5, max=180),
    ]

    def unavailable(self):
        # not imported here: the registration runs in a process of its own (dhr_run.py), the plugin only has to know it can
        import importlib.util

        for module in ("deeperhistreg", "torch"):
            if importlib.util.find_spec(module) is None:
                return f"{module} is not installed in this Python; pip install deeperhistreg"
        return None

    def register(self, source_path, target_path, params, ctx):
        if not (params["sift"] or params["superglue"]):
            raise ValueError("Switch on SIFT or SuperGlue: one of them must find the keypoints.")
        started = time.time()
        source_slide, target_slide = open_slide(source_path, ctx.exact_dir), open_slide(target_path, ctx.exact_dir)
        edge = int(params["thumbnail_size"])
        with tempfile.TemporaryDirectory(prefix="exact-dhr-") as tmp:
            box_src, box_tgt = tissue_box(source_slide), tissue_box(target_slide)
            src, scale_src = render(source_slide, box_src, edge)
            tgt, scale_tgt = render(target_slide, box_tgt, edge)
            src.save(f"{tmp}/source.png")
            tgt.save(f"{tmp}/target.png")
            with open(f"{tmp}/params.json", "w") as f:
                json.dump(params, f)
            ctx.log(f"tissue at {[round(v) for v in box_src]} and {[round(v) for v in box_tgt]}, overviews {src.size} and {tgt.size}")
            # a process of its own, see dhr_run.py; the output is the worker's log
            run = subprocess.run([sys.executable, str(HELPERS / "dhr_run.py"), tmp], capture_output=True, text=True)
            ctx.log(run.stdout[-2000:])
            if run.returncode:
                raise RuntimeError(f"DeeperHistReg failed (exit {run.returncode}):\n{run.stderr[-3000:]}")
            field = np.load(f"{tmp}/field.npy")
            pads = json.load(open(f"{tmp}/padding.json"))
        transform = DhrTransform(field, pads["pad_source"], pads["pad_target"], pads["ratio"], scale_src, scale_tgt, box_src[:2], box_tgt[:2])
        matrix, error = transform.affine(source_slide.dimensions)
        return RegistrationResult(matrix={f"t_{i}{j}": float(matrix[i][j]) for i in range(3) for j in range(3)}, error=error,
                                  runtime=int(time.time() - started), file=pickle.dumps(transform))


PLUGINS = [DeeperHistReg()]
