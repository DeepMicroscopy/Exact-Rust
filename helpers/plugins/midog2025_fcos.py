"""Image analysis plugin: the MIDOG 2025 baseline mitotic figure detector (FCOS, ResNeXt-50 backbone).

A port of the QueueRunner plugin `plugin-midog2025.py` of the MIDOG 2025 reference algorithm (Ammeling, Aubreville et al.), made
to run next to the server: it reads the image file directly (no download), keeps the model in memory between jobs and stores
the result in one request. What it does is the reference's: tissue mask on a thumbnail, overlapping 1024 px patches of the tissue at
full resolution, FCOS per patch, one non-maximum suppression over the whole image. What differs, and why:

* the model is built once and weights are read from the checkpoint's `state_dict` without PyTorch Lightning (nor the
  ImageNet weights the reference downloads to overwrite them straight away);
* patches are read by a few threads ahead of the GPU, and a patch that the clipping at the image border produced twice is run once
  (the reference runs it twice);
* images that have no 16x/32x pyramid level (plain TIFF/PNG/JPEG) work (the reference stops with a NameError), and images
  smaller than a patch are padded instead of read at a negative offset;
* the tissue test is a fraction of tissue (the reference compares a 0/255 mean with 0.1: any tissue pixel passed, which is
  what `tissue_threshold` = 0.001 keeps);
* only the mitotic figure class is stored (the reference stores whatever label the model returns).

Setup: put the checkpoint (`FCOS_x50.ckpt` of the reference) where `MIDOG25_CHECKPOINT` points (default `/models/FCOS_x50.ckpt`,
else next to this file in `../models/`). The architecture is fixed by that checkpoint (config `MIDOG25_FCOS_x50.yaml`).
"""
import concurrent.futures as futures
import os
import pathlib
import sys
import threading
import time

sys.path.insert(0, __file__.rsplit("/", 2)[0])  # helpers/, for queue_plugin when run from anywhere
from plugins_common import open_slide  # noqa: E402
from queue_plugin import AnalysisResult, ImageAnalysisPlugin, param  # noqa: E402

PATCH = 1024  # what the checkpoint was trained on; the model is built for it
HERE = pathlib.Path(__file__).resolve().parent
LABEL_MITOTIC_FIGURE = 1  # FCOS with num_classes = 2: class 0 is the background, never positive in training


def checkpoint_path():
    for c in (os.environ.get("MIDOG25_CHECKPOINT"), "/models/FCOS_x50.ckpt", str(HERE.parent / "models" / "FCOS_x50.ckpt")):
        if c and os.path.isfile(c):
            return c
    return None


def build_model(det_thresh):
    """The reference's `make_fcos_model` for FCOS_x50 (resnext50_32x4d, FPN levels 1-4, one anchor of 8..128 px per level)."""
    from torchvision.models import resnet
    from torchvision.models.detection.anchor_utils import AnchorGenerator
    from torchvision.models.detection.backbone_utils import _resnet_fpn_extractor
    from torchvision.models.detection.fcos import FCOS
    from torchvision.ops.feature_pyramid_network import LastLevelMaxPool

    backbone = _resnet_fpn_extractor(resnet.resnext50_32x4d(weights=None), trainable_layers=5, returned_layers=[1, 2, 3, 4],
                                     extra_blocks=LastLevelMaxPool())
    sizes = ((8,), (16,), (32,), (64,), (128,))
    return FCOS(backbone, 2, anchor_generator=AnchorGenerator(sizes, ((1.0,),) * len(sizes)), min_size=PATCH, max_size=PATCH,
                center_sampling_radius=1.5, score_thresh=det_thresh, nms_thresh=0.6, detections_per_img=300, topk_candidates=1000)


def load_model(path, device):
    import torch

    model = build_model(0.548)
    # a trusted file of the reference (a Lightning checkpoint holds more than tensors, so no weights_only)
    state = torch.load(path, map_location="cpu", weights_only=False)["state_dict"]
    state = {k[len("model."):]: v for k, v in state.items() if k.startswith("model.")}
    missing, unexpected = model.load_state_dict(state, strict=False)
    if missing or unexpected:  # the reference loads with strict=False and would run on with random layers
        raise RuntimeError(f"the checkpoint does not fit the model: missing {missing[:3]}, unexpected {unexpected[:3]}")
    return model.eval().to(device)


def overview(slide, target_ds=32):
    """The slide as a small RGB array and its downsample factor: from the pyramid level closest to `target_ds` from below, or - for
    an image without pyramid - read in strips and shrunk."""
    import cv2
    import numpy as np

    downs = [float(d) for d in slide.level_downsamples]
    level = max((i for i, d in enumerate(downs) if d <= target_ds * 1.01), key=lambda i: downs[i])
    w, h = slide.level_dimensions[level]
    ds = downs[level]
    step = 2048
    if ds >= target_ds / 2 or w * h <= 4096 * 4096:
        rgba = np.array(slide.read_region((0, 0), level, (w, h)))
        out = np.where(rgba[..., 3:4] == 0, 255, rgba[..., :3]).astype(np.uint8) if rgba.shape[2] == 4 else rgba[..., :3]
        return out, ds
    # a large image without a coarse level: strips, each shrunk with area averaging
    shrink = int(round(target_ds / ds))
    out = np.full((h // shrink + 1, w // shrink + 1, 3), 255, np.uint8)
    for y in range(0, h, step):
        rows = min(step, h - y)
        strip = np.array(slide.read_region((0, int(y * ds)), level, (w, rows)).convert("RGB"))
        small = cv2.resize(strip, (max(1, w // shrink), max(1, rows // shrink)), interpolation=cv2.INTER_AREA)
        y0 = y // shrink
        out[y0:y0 + small.shape[0], :small.shape[1]] = small
    return out, ds * shrink


def tissue_map(slide):
    """Binary tissue map (Otsu, then closing) at about 1/32 resolution, and its downsample: the reference's `create_active_map`."""
    import cv2
    import numpy as np

    rgb, ds = overview(slide)
    gray = cv2.cvtColor(np.ascontiguousarray(rgb), cv2.COLOR_RGB2GRAY)
    _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    elem = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    return cv2.erode(cv2.dilate(thresh, elem), elem) > 0, ds


def patch_grid(width, height, size, overlap):
    """Upper left corners of the patches that cover the image; at the right and bottom border the last patch is moved inwards, the
    corners that become equal by that are kept once."""
    stride = max(1, int(size * (1 - overlap)))
    seen, out = set(), []
    for y in range(0, height, stride):
        for x in range(0, width, stride):
            c = (max(0, min(x, width - size)), max(0, min(y, height - size)))
            if c not in seen:
                seen.add(c)
                out.append(c)
    return out


class Midog2025Fcos(ImageAnalysisPlugin):
    name = "MIDOG 2025 Baseline FCOS MIDOG++"
    author = "Jonas Ammeling / Marc Aubreville"
    package = "org.deepmicroscopy.midog2025.baseline"
    contact = "jonas.ammeling@thi.de"
    abouturl = "https://github.com/DeepMicroscopy/MIDOG25_T1_reference_docker"
    parameters = [
        param("det_thresh", "float", 0.548, "Detection threshold", "Detections with a lower score are dropped. 0.548 is the threshold of the reference algorithm.",
              min=0.05, max=0.95, step=0.01),
        param("overlap", "float", 0.3, "Patch overlap", "Overlap of neighbouring 1024 px patches; less is faster, objects on a patch border are found less reliably.",
              min=0, max=0.6, step=0.05),
        param("tissue_threshold", "float", 0.001, "Tissue fraction", "Patches with less tissue than this fraction are skipped.", min=0, max=1, step=0.001),
        param("batch_size", "int", 8, "Batch size", "Patches per forward pass (lower it on a GPU with little memory).", min=1, max=64),
        param("half_precision", "bool", False, "Half precision", "Run on the GPU in float16: faster and lighter, scores change in the third decimal."),
    ]

    def __init__(self):
        self._model, self._device, self._lock = None, None, threading.Lock()

    def unavailable(self):
        # no imports here: the worker asks at every announcement, and importing torch takes seconds and memory
        import importlib.util

        for module in ("cv2", "torch", "torchvision"):
            if importlib.util.find_spec(module) is None:
                return f"{module} is not installed in this Python (torch, torchvision and opencv are required)"
        if not checkpoint_path():
            return "the checkpoint FCOS_x50.ckpt is missing: set MIDOG25_CHECKPOINT or mount it at /models/FCOS_x50.ckpt"
        return None

    def model(self):
        """Built once, on the first job."""
        import torch

        with self._lock:
            if self._model is None:
                self._device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
                self._model = load_model(checkpoint_path(), self._device)
        return self._model, self._device

    def analyze(self, image_path, params, ctx):
        import numpy as np
        import torch
        from torchvision.ops import batched_nms

        model, device = self.model()
        model.score_thresh = float(params["det_thresh"])
        size, batch = PATCH, int(params["batch_size"])
        slide = open_slide(image_path, ctx.exact_dir)
        width, height = (int(v) for v in slide.dimensions)
        active, ds = tissue_map(slide)
        coords = []
        for x, y in patch_grid(max(width, size), max(height, size), size, float(params["overlap"])):
            window = active[int(y / ds):int((y + size) / ds) + 1, int(x / ds):int((x + size) / ds) + 1]
            if window.size and window.mean() >= float(params["tissue_threshold"]):
                coords.append((x, y))
        ctx.log(f"{image_path}: {width}x{height}, {len(coords)} patches with tissue, device {device}")

        local = threading.local()

        def read(c):  # one slide object per thread: not every reader is thread safe
            if not hasattr(local, "slide"):
                local.slide = open_slide(image_path, ctx.exact_dir)
            x, y = c
            w, h = min(size, width - x), min(size, height - y)
            img = np.full((size, size, 3), 255, np.uint8)  # an image smaller than a patch is padded with white
            img[:h, :w] = np.array(local.slide.read_region((x, y), 0, (w, h)).convert("RGB"))
            return torch.from_numpy(img).permute(2, 0, 1)

        half = bool(params["half_precision"]) and device.type == "cuda"
        boxes, scores = [], []
        started, last = time.time(), 0.0
        with futures.ThreadPoolExecutor(max_workers=3) as pool:
            batches = [coords[i:i + batch] for i in range(0, len(coords), batch)]
            pending = [[pool.submit(read, c) for c in b] for b in batches[:2]]  # two batches read ahead
            for n, b in enumerate(batches):
                if n + 2 < len(batches):
                    pending.append([pool.submit(read, c) for c in batches[n + 2]])
                images = [f.result().to(device, non_blocking=True).float().div_(255) for f in pending[n]]
                pending[n] = None
                with torch.inference_mode(), torch.autocast(device.type, dtype=torch.float16, enabled=half):
                    out = model(images)
                for (x, y), o in zip(b, out):
                    keep = o["labels"] == LABEL_MITOTIC_FIGURE
                    if keep.any():
                        boxes.append((o["boxes"][keep].float() + torch.tensor([x, y, x, y], device=device)).cpu())
                        scores.append(o["scores"][keep].float().cpu())
                if time.time() - last > 5:
                    ctx.progress(95 * (n + 1) / len(batches))
                    last = time.time()
        ctx.log(f"{len(coords)} patches in {time.time() - started:.0f} s")

        found = []
        if boxes:
            boxes, scores = torch.cat(boxes), torch.cat(scores)
            boxes[:, 0::2].clamp_(0, width)
            boxes[:, 1::2].clamp_(0, height)
            keep = batched_nms(boxes, scores, torch.zeros(len(scores), dtype=torch.long), 0.3)  # across the patches, as the reference
            for b, s in zip(boxes[keep].tolist(), scores[keep].tolist()):
                x1, y1, x2, y2 = round(b[0]), round(b[1]), round(b[2]), round(b[3])
                if x2 - x1 < 1 or y2 - y1 < 1:  # a box the server accepts needs x2 > x1 and y2 > y1; clipped to nothing: not a detection
                    continue
                found.append({"vector": {"x1": x1, "y1": y1, "x2": x2, "y2": y2}, "score": s})
        return AnalysisResult(found, "mitotic figure", "Mitotic Figures", float(params["det_thresh"]))


PLUGINS = [Midog2025Fcos()]
