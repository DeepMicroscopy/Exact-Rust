#!/usr/bin/env python3
"""Slide reader process for formats only slideio can read (CZI, VSI, DICOM).

Protocol on stdin/stdout, one request per line (JSON), one answer per request:
  answer = one JSON line, followed by `payload_len` raw bytes when the header has that field.
  {"op":"open","path":P}   -> {"ok":true,"levels":[{"w","h","scale"}],"mpp_x","mpp_y","magnification",
                                "frames","frame_descriptors":[...],"kind":"none|zstack|volume|timeseries","z_positions":[..]|null,"z_unit",
                                "bgr":bool,"meta":{...}}
  {"op":"read","path":P,"x","y","w","h","level","frame"[,"ds"]} -> {"ok":true,"w","h","payload_len"} + RGBA bytes
  {"op":"ping"} -> {"ok":true}
Errors: {"ok":false,"error":"..."}.  The Rust side (exact-wsi/src/slideio.rs) owns lifecycle and restarts.
Ported from exact/util/slideio.py; keep the semantics identical.
"""
import hashlib
import json
import os
import re
import sys
import tempfile

import numpy as np
import slideio

# the last slides opened, bounded: a helper that serves thumbnails of hundreds of different files must not keep them all open
MAX_OPEN = int(os.environ.get("SLIDEIO_MAX_OPEN", "12"))
slides = {}


def vsi_path(path):
    """The Olympus scanner writes `slide-1.vsi` with the data in `_slide_1_` (anything but letters and digits becomes `_` in the
    folder name), but the reader looks for `_slide-1_`. When only the scanner's spelling exists, the file is opened through a
    link in a folder of its own that carries the folder's name. Some exports name the folder `_Image_slide-1_` (an `Image_` in front of
    the name): that is found as well."""
    if not path.lower().endswith(".vsi"):
        return path
    here, name = os.path.split(path)
    stem = name[:-4]
    if os.path.isdir(os.path.join(here, f"_{stem}_")):
        return path
    flat = re.sub(r"[^0-9A-Za-z]", "_", stem)
    spellings = (flat, "Image_" + flat)
    found = [e for e in os.listdir(here) if e.startswith("_") and e.endswith("_") and len(e) > 2 and re.sub(r"[^0-9A-Za-z]", "_", e[1:-1]) in spellings and os.path.isdir(os.path.join(here, e))]
    found.sort(key=lambda e: spellings.index(re.sub(r"[^0-9A-Za-z]", "_", e[1:-1])))  # the plainer spelling first
    for entry in found[:1]:
        # the reader looks for `_<name of the .vsi>_`, so the link carries the .vsi's own name, the folder keeps its content
        if True:
            alias = os.path.join(tempfile.gettempdir(), "exact-vsi", hashlib.sha1(path.encode()).hexdigest()[:16])
            os.makedirs(alias, exist_ok=True)
            for link, target in ((f"{stem}.vsi", path), (f"_{stem}_", os.path.join(here, entry))):
                if not os.path.lexists(os.path.join(alias, link)):
                    os.symlink(target, os.path.join(alias, link))
            return os.path.join(alias, f"{stem}.vsi")
    return path


def open_slide(path):
    if path in slides:
        slides[path] = slides.pop(path)  # most recently used last
        return slides[path]
    fh = slideio.open_slide(vsi_path(path))
    scene = fh.get_scene(0)
    slides[path] = (fh, scene)
    while len(slides) > MAX_OPEN:
        old = slides.pop(next(iter(slides)))
        del old
    return slides[path]


def describe(path):
    fh, scene = open_slide(path)
    n = scene.num_zoom_levels
    infos = [scene.get_zoom_level_info(k) for k in range(n)]
    mpp_x, mpp_y = scene.resolution[0] * 1e6, scene.resolution[1] * 1e6
    meta = {}
    if path.lower().endswith(".dcm"):
        try:
            import pydicom

            d = pydicom.dcmread(path, stop_before_pixels=True)
            if mpp_x == 0.0:
                ps = getattr(d, "PixelSpacing", None) or getattr(d, "ImagerPixelSpacing", None) or getattr(d, "NominalScannedPixelSpacing", None)
                if ps and float(ps[0]) > 0:
                    mpp_x, mpp_y = float(ps[1]) * 1000, float(ps[0]) * 1000
            meta["modality"] = str(getattr(d, "Modality", ""))
            ft = getattr(d, "FrameTime", None)
            if ft is not None:
                meta["frame_time_ms"] = float(ft)
        except Exception:
            pass
    z_res = scene.z_resolution * 1e6
    frames = scene.num_z_slices
    if z_res > 0:
        desc = ["%.2f µ" % (z_res * x) for x in range(frames)]
    elif "frame_time_ms" in meta:
        t = meta["frame_time_ms"] / 1000.0
        desc = ["%.2f s (%d)" % (t * x, x) for x in range(frames)]
    else:
        desc = ["Frame %d" % x for x in range(frames)]
    # what the frames are: DICOM CT/MR/PT/NM = radiology volume, other DICOM = time series, CZI/VSI z slices = z-stack
    if frames <= 1:
        kind = "none"
    elif path.lower().endswith(".dcm"):
        kind = "volume" if meta.get("modality") in ("CT", "MR", "PT", "NM") else "timeseries"
    else:
        kind = "zstack"
    z_positions = [z_res * i for i in range(frames)] if kind == "zstack" and z_res > 0 else None
    return {
        "ok": True,
        "kind": kind,
        "z_positions": z_positions,
        "z_unit": "µm",
        "levels": [{"w": i.size.width, "h": i.size.height, "scale": i.scale} for i in infos],
        "mpp_x": mpp_x,
        "mpp_y": mpp_y,
        "magnification": scene.magnification,
        "frames": frames,
        "frame_descriptors": desc,
        "bgr": os.path.splitext(path.upper())[-1] == ".CZI",
        "meta": meta,
    }


def read(req):
    fh, scene = open_slide(req["path"])
    w, h, level, frame = req["w"], req["h"], req["level"], req["frame"]
    bgr = os.path.splitext(req["path"].upper())[-1] == ".CZI"
    if req.get("ds"):
        # integer downsample of the level (levels are exact 2^k pixel grids even though their stored sizes are rounded):
        # the caller passes a position that is a multiple of it, so the rect maps onto whole level pixels
        rect = [req["x"], req["y"], w * req["ds"], h * req["ds"]]
    else:
        ds = scene.get_zoom_level_info(level).scale
        rect = [req["x"], req["y"], int(w / ds), int(h / ds)]
    img = scene.read_block(rect=rect, size=(w, h), slices=(frame, frame + 1))
    out = np.zeros([h, w, 4], dtype=np.uint8)
    out[:, :, 3] = 255
    if img.ndim == 2:
        out[:, :, 0] = out[:, :, 1] = out[:, :, 2] = img
    elif bgr:
        out[:, :, 0:3] = img[:, :, ::-1]
    else:
        out[:, :, 0:3] = img
    return out.tobytes()


def main():
    stdout = sys.stdout.buffer
    for line in sys.stdin:
        try:
            req = json.loads(line)
            op = req["op"]
            if op == "ping":
                head, payload = {"ok": True}, b""
            elif op == "open":
                head, payload = describe(req["path"]), b""
            elif op == "read":
                payload = read(req)
                head = {"ok": True, "w": req["w"], "h": req["h"], "payload_len": len(payload)}
            else:
                head, payload = {"ok": False, "error": "unknown op"}, b""
        except Exception as e:  # noqa: BLE001 - every failure is reported to the caller
            head, payload = {"ok": False, "error": f"{type(e).__name__}: {e}"}, b""
        stdout.write(json.dumps(head).encode() + b"\n" + payload)
        stdout.flush()


if __name__ == "__main__":
    main()
