"""Registration plugin: VALIS (Virtual Alignment of pathoLogy Image Series; Gatenbee et al., Nature Communications 2023).

VALIS finds a rigid alignment from matched features (VGG, optionally SuperPoint) and refines it with a non-rigid registration
(optical flow); it was made for series of differently stained serial sections. This plugin registers two images: the source is
moved onto the target, which VALIS treats as the reference.

Like the DeeperHistReg plugin it works on overviews of the tissue, rendered with EXACT's own slide readers (VALIS itself reads
files through pyvips, Bio-Formats and OpenSlide, which would not open every format EXACT does). VALIS runs in a process of its own
(helpers/valis_run.py) with the Python that has `valis-wsi` installed: the environment variable `VALIS_PYTHON`, else
`reference/.venv-valis/bin/python` next to the helpers, else the worker's own Python. VALIS needs a Java runtime (Bio-Formats) and libvips.

What the server keeps: the matrix that fits the registration best, and the registration itself as a `GridTransform` (helpers/grid_transform.py):
a grid of source points with the places VALIS sends them to, so that points are converted through the full non-rigid warp.
`registration_error` is VALIS' own measure, the median distance of matched features after the registration (see `error_of`).
"""
import json
import os
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
from grid_transform import GridTransform  # noqa: E402
from plugins_common import open_slide, render, tissue_box  # noqa: E402


def valis_python():
    if os.environ.get("VALIS_PYTHON"):
        return os.environ["VALIS_PYTHON"]
    venv = HELPERS.parent / "reference" / ".venv-valis" / "bin" / "python"
    return str(venv) if venv.exists() else sys.executable


def error_of(stats, mode, overview_scale):
    """The registration error in target slide pixels from VALIS' summary row: the median distance of its matched features after the
    registration (`non_rigid_D`, `rigid_D` for the rigid mode), measured on the overviews, times the slide pixels per overview pixel.
    -1 (unknown) when the summary has none. It is the disagreement of the features VALIS itself matched: it says how consistent the
    result is, and not how far off it is where no features were found."""
    key = "non_rigid_D" if mode != "rigid" else "rigid_D"
    d = stats.get(key)
    if d is None:
        return -1.0
    d = float(d) / (stats.get("resolution") or 1.0)  # VALIS gives pixels times the pixel size of the image
    return d * overview_scale


class Valis(RegistrationPlugin):
    name = "VALIS"
    author = "Chandler Gatenbee"
    package = "valis-wsi"
    abouturl = "https://github.com/MathOnco/valis"
    parameters = [
        param("mode", "choice", "non_rigid", "Mode", "Rigid: rotation, scale and shift only. Non-rigid adds an optical-flow warp that follows the "
              "deformation of the tissue.", choices=["non_rigid", "rigid"]),
        param("image_type", "choice", "auto", "Stain", "Brightfield (H&E, IHC) or fluorescence; auto lets VALIS decide per image.", choices=["auto", "brightfield", "fluorescence"]),
        param("overview_size", "int", 4096, "Overview size", "Longer edge in pixels of the overviews the two slides are rendered to.", min=512, max=16384),
        param("processed_size", "int", 1024, "Rigid registration size", "VALIS' max_processed_image_dim_px: the size features are detected and the rigid alignment is made at "
              "(the VALIS default is 512; larger is more accurate and slower).", min=256, max=4096),
        param("non_rigid_size", "int", 2048, "Non-rigid registration size", "VALIS' max_non_rigid_registration_dim_px: the size of the non-rigid step.", min=512, max=8192),
        param("feature_detector", "choice", "default", "Feature detector", "default is VALIS' own choice; SuperPoint is learned and finds more in faint stains.",
              choices=["default", "vgg", "orb_vgg", "superpoint"]),
        param("masks", "bool", True, "Tissue masks", "Let VALIS mask the tissue (turn off if it masks too much)."),
        param("grid", "int", 64, "Warp grid", "Points per side of the grid the warp is sampled on (what the server converts through).", min=16, max=256),
    ]

    def unavailable(self):
        py = valis_python()
        # find_spec, not an import: importing valis loads PyTorch and fetches the weights of its matcher on the first use
        r = subprocess.run([py, "-c", "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('valis') else 1)"], capture_output=True, text=True)
        if r.returncode:
            return f"valis is not installed in {py}; python -m venv reference/.venv-valis && reference/.venv-valis/bin/pip install valis-wsi (or set VALIS_PYTHON)"
        return None

    def register(self, source_path, target_path, params, ctx):
        started = time.time()
        source_slide, target_slide = open_slide(source_path, ctx.exact_dir), open_slide(target_path, ctx.exact_dir)
        edge = int(params["overview_size"])
        with tempfile.TemporaryDirectory(prefix="exact-valis-") as tmp:
            tmp = pathlib.Path(tmp)
            (tmp / "slides").mkdir()
            box_src, box_tgt = tissue_box(source_slide), tissue_box(target_slide)
            src, scale_src = render(source_slide, box_src, edge)
            tgt, scale_tgt = render(target_slide, box_tgt, edge)
            src.save(tmp / "slides" / "source.png")
            tgt.save(tmp / "slides" / "target.png")
            (tmp / "params.json").write_text(json.dumps({**params, "overview": list(src.size)}))
            ctx.log(f"tissue at {[round(v) for v in box_src]} and {[round(v) for v in box_tgt]}, overviews {src.size} and {tgt.size}")
            run = subprocess.run([valis_python(), str(HELPERS / "valis_run.py"), str(tmp)], capture_output=True, text=True)
            ctx.log(run.stdout[-2000:])
            if run.returncode:
                raise RuntimeError(f"VALIS failed (exit {run.returncode}):\n{run.stderr[-3000:]}")
            mapped = np.load(tmp / "mapped.npy")  # (n, n, 2) target overview pixels
            grid = json.loads((tmp / "grid.json").read_text())
            stats = json.loads((tmp / "stats.json").read_text())
        ctx.log(f"VALIS summary: {json.dumps(stats)[:600]}")
        # overview pixels -> slide pixels, on both sides
        xs = np.asarray(grid["xs"]) * scale_src[0] + box_src[0]
        ys = np.asarray(grid["ys"]) * scale_src[1] + box_src[1]
        dst = np.stack([mapped[..., 0] * scale_tgt[0] + box_tgt[0], mapped[..., 1] * scale_tgt[1] + box_tgt[1]], axis=-1)
        transform = GridTransform(xs, ys, dst)
        matrix, _ = transform.matrix()
        error = error_of(stats, params["mode"], float(np.mean(scale_tgt)))
        return RegistrationResult(matrix={f"t_{i}{j}": float(matrix[i][j]) for i in range(3) for j in range(3)}, error=error,
                                  runtime=int(time.time() - started), file=pickle.dumps(transform))


PLUGINS = [Valis()]
