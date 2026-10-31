"""A skeleton for a deep-learning segmenter (nnU-Net v2 as the example; MONAI or TotalSegmentator work the same way).

**No trained model is shipped with EXACT.** This module only shows how to connect one: it is disabled (it registers nothing, users
do not see it) until nnU-Net is installed *and* a model folder is configured. Training or downloading a model, checking that it
fits your images, and deciding whether its output may be used for anything but research is up to you.

To use it:
  1. `pip install nnunetv2` in the environment of the worker (and its PyTorch build for your GPU).
  2. Put a trained nnU-Net v2 results folder (the one holding `plans.json`, `dataset.json` and `fold_*`) on the worker's machine and set
     `EXACT_NNUNET_MODEL=/path/to/Dataset001_X/nnUNetTrainer__nnUNetPlans__3d_fullres`, optionally `EXACT_NNUNET_FOLD` (default `0`),
     and `EXACT_NNUNET_LABELS` (comma separated label numbers that are the structure to mask, default: every label above 0).
  3. Adapt `segment()` where marked: nnU-Net expects the volume with the orientation, spacing and channel order it was trained
     with. The worker gives it the volume of the mask grid, (z, y, x), true values, the voxel size in mm. Resample / reorient
     here if your model needs it, and map the result back to the shape of `volume` (the mask must have exactly that shape).
  4. Restart the worker; the segmenter appears in the "Auto segment" dialog.

Copy this file under another name for every model; each module is one entry in the dialog.
"""
import os

import numpy as np

NAME = "nnU-Net (your model)"
AUTHOR = "your lab"
DESCRIPTION = "Deep-learning segmentation with an nnU-Net v2 model that you provide. Not shipped: see the notes in helpers/segmenters/nnunet_example.py."
INPUT = "intensity"
PARAMS = [
    {"name": "use_gpu", "type": "bool", "default": True, "label": "Use the GPU", "help": "off: much slower, but works without a graphics card"},
    {"name": "tta", "type": "bool", "default": False, "label": "Test-time augmentation", "help": "mirrors the input: slower, a little more accurate"},
]


def available():
    model = os.environ.get("EXACT_NNUNET_MODEL")
    if not model:
        return "EXACT_NNUNET_MODEL is not set (no model configured)"
    if not os.path.isdir(model):
        return f"EXACT_NNUNET_MODEL {model!r} is not a folder"
    try:
        import nnunetv2  # noqa: F401
    except ImportError:
        return "nnunetv2 is not installed"
    return None


def segment(volume, spacing_mm, params, progress):
    import torch
    from nnunetv2.inference.predict_from_raw_data import nnUNetPredictor

    progress(0.0, "Loading the model")
    predictor = nnUNetPredictor(
        tile_step_size=0.5,
        use_gaussian=True,
        use_mirroring=bool(params["tta"]),
        device=torch.device("cuda" if params["use_gpu"] and torch.cuda.is_available() else "cpu"),
        verbose=False,
    )
    predictor.initialize_from_trained_model_folder(
        os.environ["EXACT_NNUNET_MODEL"], use_folds=(os.environ.get("EXACT_NNUNET_FOLD", "0"),), checkpoint_name="checkpoint_final.pth"
    )
    progress(0.1, "Predicting")
    # ADAPT HERE: nnU-Net wants (channels, x, y, z) float32 plus the spacing as (z, y, x) for its own arrays; this passes the
    # grid as it is. A model trained on another orientation or resolution needs resampling before and after.
    data = volume.astype(np.float32)[None]  # one channel, (c, z, y, x)
    labels, _ = predictor.predict_single_npy_array(data, {"spacing": [float(spacing_mm[2]), float(spacing_mm[1]), float(spacing_mm[0])]}, None, None, False)
    labels = np.asarray(labels)
    wanted = os.environ.get("EXACT_NNUNET_LABELS")
    mask = np.isin(labels, [int(v) for v in wanted.split(",")]) if wanted else labels > 0
    if mask.shape != volume.shape:
        raise RuntimeError(f"the model output {mask.shape} does not fit the volume {volume.shape}: resample it in segment()")
    progress(1.0, "Done")
    return mask.astype(np.uint8)
