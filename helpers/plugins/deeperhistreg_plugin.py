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
import pickle
import sys
import tempfile
import time

sys.path.insert(0, __file__.rsplit("/", 2)[0])  # helpers/
from queue_plugin import RegistrationPlugin, RegistrationResult, param  # noqa: E402
from dhr_transform import DhrTransform  # noqa: E402
from plugins_common import open_slide  # noqa: E402


def overview(slide, edge):
    """The slide as a PIL image with its longer side `edge` pixels (or full size when it is smaller), and the slide pixels per
    image pixel (x, y)."""
    from PIL import Image

    w, h = slide.dimensions
    want = min(edge / max(w, h), 1.0)
    level = 0
    for i, (lw, _) in enumerate(slide.level_dimensions):  # the coarsest level that still has enough pixels
        if lw * 1.0 >= w * want:
            level = i
    lw, lh = slide.level_dimensions[level]
    region = slide.read_region((0, 0), level, (lw, lh))
    rgb = Image.new("RGB", region.size, (255, 255, 255))
    rgb.paste(region, mask=region.split()[3] if region.mode == "RGBA" else None)
    size = (max(1, round(w * want)), max(1, round(h * want)))
    if rgb.size != size:
        rgb = rgb.resize(size, Image.LANCZOS)
    return rgb, (w / size[0], h / size[1])


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
        try:
            import deeperhistreg  # noqa: F401
        except Exception as e:  # noqa: BLE001
            return f"deeperhistreg is not installed in this Python ({e.__class__.__name__}: {e}); pip install deeperhistreg"
        return None

    def parameters_for(self, p, device):
        import deeperhistreg

        deformable = p["mode"] == "deformable"
        cfg = deeperhistreg.configs.default_nonrigid_fast() if deformable else deeperhistreg.configs.default_initial()
        cfg["device"] = device
        cfg["echo"] = False
        cfg["logging_path"] = None
        cfg["save_final_images"] = False
        cfg["save_final_displacement_field"] = False
        cfg["loading_params"].update(loader="pil", source_resample_ratio=1.0, target_resample_ratio=1.0)
        cfg["saving_params"].update(final_saver="pil", final_extension=".jpg")
        cfg["preprocessing_params"]["initial_resolution"] = int(p["registration_size"])
        cfg["preprocessing_params"]["save_results"] = False
        initial = deeperhistreg.configs.default_initial()["initial_registration_params"]  # the feature based alignment, in both modes
        initial.update(save_results=False, device=device, cuda=device != "cpu", transform_type=p["transform_type"],
                       angle_step=int(p["angle_step"]), run_sift_ransac=bool(p["sift"]), run_superpoint_superglue=bool(p["superglue"]),
                       registration_size=int(p["registration_size"]))
        if not (p["sift"] or p["superglue"]):
            raise ValueError("Switch on SIFT or SuperGlue: one of them must find the keypoints.")
        cfg["run_initial_registration"] = True
        cfg["initial_registration_params"] = initial
        cfg["run_nonrigid_registration"] = deformable
        cfg["nonrigid_registration_params"]["save_results"] = False
        if deformable:
            cfg["nonrigid_registration_params"]["device"] = device
            cfg["nonrigid_registration_params"]["registration_size"] = int(p["registration_size"])
        return cfg

    def register(self, source_path, target_path, params, ctx):
        import torch
        from deeperhistreg.dhr_pipeline import full_resolution
        from deeperhistreg.dhr_utils import utils as dhr_utils

        device = params["device"]
        if device == "auto":
            device = "cuda:0" if torch.cuda.is_available() else "cpu"
        started = time.time()
        source_slide, target_slide = open_slide(source_path, ctx.exact_dir), open_slide(target_path, ctx.exact_dir)
        edge = int(params["thumbnail_size"])
        with tempfile.TemporaryDirectory(prefix="exact-dhr-") as tmp:
            src, scale_src = overview(source_slide, edge)
            tgt, scale_tgt = overview(target_slide, edge)
            src.save(f"{tmp}/source.png")
            tgt.save(f"{tmp}/target.png")
            ctx.log(f"overviews {src.size} and {tgt.size}, device {device}")
            cfg = self.parameters_for(params, device)
            cfg["case_name"] = "exact"
            pipeline = full_resolution.DeeperHistReg_FullResolution(cfg)
            pipeline.run_registration(f"{tmp}/source.png", f"{tmp}/target.png", tmp)
            field = dhr_utils.tc_df_to_np_df(pipeline.current_displacement_field)
        pads = pipeline.padding_params
        transform = DhrTransform(field, pads["pad_1"], pads["pad_2"], pads.get("initial_resample_ratio", 1.0) if pads.get("initial_resampling") else 1.0,
                                 scale_src, scale_tgt)
        matrix, error = transform.affine(source_slide.dimensions)
        return RegistrationResult(matrix={f"t_{i}{j}": float(matrix[i][j]) for i in range(3) for j in range(3)}, error=error,
                                  runtime=int(time.time() - started), file=pickle.dumps(transform))


PLUGINS = [DeeperHistReg()]
