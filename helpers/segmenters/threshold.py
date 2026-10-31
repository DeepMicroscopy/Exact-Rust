"""Threshold segmentation: everything brighter (or darker) than a level, cleaned up. A classical method, no learning involved.

Good for what separates by intensity alone: bone or contrast agent in CT (use bounds in HU), tissue against air (Otsu), a bright
tracer in PET. It does not know anatomy: touching structures of the same intensity come out as one.
"""
import numpy as np

NAME = "Threshold"
AUTHOR = "EXACT"
DESCRIPTION = "Voxels above a level (or between two), found with Otsu's method or given, optionally cleaned: closing, holes filled, only the largest part kept."
INPUT = "intensity"
PARAMS = [
    {"name": "method", "type": "choice", "choices": ["otsu", "bounds"], "default": "otsu", "label": "Level", "help": "otsu: the level that best separates dark from bright voxels; bounds: the values below"},
    {"name": "lower", "type": "float", "default": 0.0, "label": "Lower bound", "help": "bounds: voxels at or above this value (HU for CT)"},
    {"name": "upper", "type": "float", "default": 100000.0, "label": "Upper bound", "help": "bounds: voxels at or below this value"},
    {"name": "invert", "type": "bool", "default": False, "label": "Take the darker side", "help": "otsu: select the voxels below the level (air, fluid) instead of above"},
    {"name": "closing", "type": "int", "default": 1, "min": 0, "max": 10, "label": "Closing (voxels)", "help": "closes gaps of this size: dilation then erosion"},
    {"name": "fill_holes", "type": "bool", "default": True, "label": "Fill holes", "help": "cavities inside the mask are filled, slice by slice"},
    {"name": "keep_largest", "type": "bool", "default": True, "label": "Only the largest part", "help": "drops every connected part but the biggest"},
]


def available():
    try:
        import scipy.ndimage  # noqa: F401
    except ImportError:
        return "scipy is not installed"
    return None


def otsu_level(volume, bins=256):
    """Otsu's level of the finite values of an array."""
    v = volume[np.isfinite(volume)]
    lo, hi = float(v.min()), float(v.max())
    if hi <= lo:
        return lo
    hist, edges = np.histogram(v, bins=bins, range=(lo, hi))
    p = hist.astype(np.float64) / hist.sum()
    centres = (edges[:-1] + edges[1:]) / 2
    w0 = np.cumsum(p)
    w1 = 1.0 - w0
    m0 = np.cumsum(p * centres)
    mt = m0[-1]
    with np.errstate(divide="ignore", invalid="ignore"):
        between = (mt * w0 - m0) ** 2 / (w0 * w1)
    between[~np.isfinite(between)] = -1
    return float(centres[int(np.argmax(between))])


def segment(volume, spacing_mm, params, progress):
    from scipy import ndimage as ndi

    progress(0.0, "Threshold")
    if params["method"] == "bounds":
        lo, hi = params["lower"], params["upper"]
        mask = (volume >= lo) & (volume <= hi)
    else:
        level = otsu_level(volume)
        progress(0.2, f"Otsu level {level:.1f}")
        mask = volume < level if params["invert"] else volume >= level
    if params["closing"] > 0 and mask.any():
        progress(0.4, "Closing")
        mask = ndi.binary_closing(mask, structure=ndi.generate_binary_structure(3, 1), iterations=int(params["closing"]))
    if params["fill_holes"] and mask.any():
        progress(0.6, "Filling holes")
        for z in range(mask.shape[0]):
            if mask[z].any():
                mask[z] = ndi.binary_fill_holes(mask[z])
    if params["keep_largest"] and mask.any():
        progress(0.8, "Largest part")
        labels, n = ndi.label(mask)  # 6-neighbourhood, as the server's own 'largest part'
        if n > 1:
            sizes = ndi.sum_labels(mask, labels, index=np.arange(1, n + 1))
            mask = labels == (int(np.argmax(sizes)) + 1)
    progress(1.0, "Done")
    return mask.astype(np.uint8)
