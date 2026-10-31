#!/usr/bin/env python3
"""Segmentation worker for the EXACT Rust server: computes the masks that users ask for with "Auto segment".

On start it announces the segmenters it can run (`POST /api/v2/segmenters/register`), then claims jobs from
`POST /api/v2/segmentation-jobs/claim`. For a job it downloads the volume (`GET /api/v2/images/{id}/voxels`), runs the segmenter
the job names and puts the mask into the job's mask annotation (`PUT /api/v2/segmentation/{annotation}/labels`), so that it appears
in the three-plane view like a painted mask and can be undone there.

    segment_worker.py --url http://localhost:8000 --user worker --password ... [--name w1] [--once] [--plugins-dir helpers/segmenters]

A segmenter is a Python module in the plugins folder (see helpers/segmenters/threshold.py):

    NAME = "my method"                 # what users pick
    DESCRIPTION = "one sentence"
    PARAMS = [{"name": "level", "type": "float", "default": 0.5, "label": "Level", "help": "..."}]   # as registration plugins
    INPUT = "intensity"                # "intensity" (float32 true values, e.g. HU) or "display" (uint8, display window)
    def available(): return None       # optional: a text saying why it cannot run here (a library is missing), else None
    def segment(volume, spacing_mm, params, progress):
        # volume: float32 array (z, y, x) of the mask grid; spacing_mm: (sx, sy, sz); progress(fraction, text) reports
        return mask                    # uint8 array of the same shape, non-zero = masked

The worker needs an account with the permission `processing.add_plugin` (to announce segmenters) that is a member of the teams
whose images it works on and may annotate and edit annotations in their image sets. It runs anywhere that reaches the server:
the voxels travel over HTTP, nothing is read from the image folder. Needs numpy; the shipped segmenters also scipy.
"""
import argparse
import base64
import gzip
import importlib.util
import json
import os
import pathlib
import socket
import sys
import time
import traceback
import urllib.error
import urllib.request

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent


class Gone(Exception):
    """The job was removed or taken by another worker while this one worked on it."""


class Api:
    def __init__(self, url, user, password):
        self.url = url.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def request(self, method, path, body=None, headers=None, raw=False):
        h = {"Authorization": self.auth, "Accept-Encoding": "gzip", **(headers or {})}
        data = body
        if isinstance(body, (dict, list)):
            data = json.dumps(body).encode()
            h["Content-Type"] = "application/json"
        elif body is None and method == "POST":
            data = b"{}"
            h["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=600) as r:
                payload = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    payload = gzip.decompress(payload)
                if raw:
                    return r.status, payload, dict(r.headers)
                return r.status, (json.loads(payload) if payload else None)
        except urllib.error.HTTPError as e:
            text = e.read().decode(errors="replace")
            try:
                text = json.loads(text)
            except ValueError:
                pass
            return (e.code, text, {}) if raw else (e.code, text)

    def call(self, path, body=None):
        return self.request("POST", path, body)


def load_segmenters(folder, only=None):
    """The modules of `folder` that define `NAME` and `segment`."""
    found = []
    for path in sorted(pathlib.Path(folder).glob("*.py")):
        if path.name.startswith("_"):
            continue
        spec = importlib.util.spec_from_file_location(f"exact_segmenter_{path.stem}", path)
        module = importlib.util.module_from_spec(spec)
        try:
            spec.loader.exec_module(module)
        except Exception:  # noqa: BLE001 - a broken module must not stop the others
            print(f"segmenter {path.name} cannot be loaded:\n{traceback.format_exc()}", file=sys.stderr, flush=True)
            continue
        if not hasattr(module, "NAME") or not hasattr(module, "segment"):
            continue
        if only and only.lower() not in module.NAME.lower() and only.lower() not in path.stem:
            continue
        found.append(module)
    return found


def announce(api, segmenters):
    """Registers the segmenters that can run here. {name: module}."""
    served = {}
    for m in segmenters:
        why = m.available() if hasattr(m, "available") else None
        if why:
            print(f"segmenter {m.NAME!r} not served: {why}", file=sys.stderr, flush=True)
            continue
        body = {"name": m.NAME, "author": getattr(m, "AUTHOR", ""), "description": getattr(m, "DESCRIPTION", ""), "parameters_schema": list(getattr(m, "PARAMS", []))}
        status, answer = api.call("/api/v2/segmenters/register", body)
        if status not in (200, 201):
            raise RuntimeError(f"cannot register segmenter {m.NAME!r}: {status} {answer}")
        served[m.NAME] = m
    return served


def coerce(schema, given):
    """The parameter values of a job: the defaults of the schema, overridden by what the job carries."""
    out = {}
    for p in schema:
        v = given.get(p["name"], p.get("default"))
        t = p.get("type")
        if v is None:
            v = {"bool": False, "text": "", "int": 0, "float": 0.0}.get(t)
        elif t == "int":
            v = int(v)
        elif t == "float":
            v = float(v)
        elif t == "bool":
            v = bool(v)
        out[p["name"]] = v
    return out


def fetch_volume(api, image, kind):
    status, payload, h = api.request("GET", f"/api/v2/images/{image}/voxels?kind={kind}", raw=True)
    if status != 200:
        raise RuntimeError(f"cannot read the voxels of image {image} ({kind}): {status} {payload if not isinstance(payload, bytes) else payload[:200]}")
    h = {k.lower(): v for k, v in h.items()}
    w, hh, n = int(h["x-voxels-width"]), int(h["x-voxels-height"]), int(h["x-voxels-frames"])
    sx, sy, sz = (float(v) for v in h["x-voxel-mm"].split(","))
    dtype = {"uint8": np.uint8, "float32": "<f4"}[h["x-dtype"]]
    vol = np.frombuffer(payload, dtype=dtype)
    if vol.size != w * hh * n:
        raise RuntimeError(f"the volume came short: {vol.size} of {w * hh * n} voxels")
    return vol.reshape(n, hh, w).astype(np.float32), (sx, sy, sz)


def work(api, name, served):
    """One job, if there is one. Returns whether a job was handled."""
    status, job = api.call("/api/v2/segmentation-jobs/claim", {"worker": name, "segmenters": list(served)})
    if status == 204:
        return False
    if status != 200:
        raise RuntimeError(f"claim failed: {status} {job}")
    seg = served[job["segmenter"]]
    jid = job["id"]
    print(f"job {jid}: {seg.NAME}: image {job['image']}", flush=True)

    def report(path, body):
        status, answer = api.call(f"/api/v2/segmentation-jobs/{jid}/{path}", {"worker": name, **body})
        if status in (404, 409):
            raise Gone(f"job {jid}: {answer}")
        return status

    def progress(fraction, text=""):
        report("progress", {"progress": 0.1 + 0.8 * max(0.0, min(1.0, float(fraction))), "message": text})

    try:
        report("progress", {"progress": 0.02, "message": "Loading the volume"})
        kind = getattr(seg, "INPUT", "intensity")
        try:
            volume, spacing = fetch_volume(api, job["image"], kind)
        except RuntimeError:
            if kind != "intensity":
                raise
            volume, spacing = fetch_volume(api, job["image"], "display")  # a reader without true values
        report("progress", {"progress": 0.1, "message": f"Segmenting with {seg.NAME}"})
        mask = np.asarray(seg.segment(volume, spacing, coerce(getattr(seg, "PARAMS", []), job["parameters"]), progress))
        if mask.shape != volume.shape:
            raise RuntimeError(f"the segmenter returned a mask of shape {mask.shape} for a volume of {volume.shape}")
        mask = (mask != 0).astype(np.uint8)
        report("progress", {"progress": 0.92, "message": f"Storing the mask ({int(mask.sum())} voxels)"})
        status, answer = api.request("PUT", f"/api/v2/segmentation/{job['annotation']}/labels?mode={job['mode']}", gzip.compress(mask.tobytes(), 3),
                                     headers={"Content-Encoding": "gzip", "Content-Type": "application/octet-stream"})
        if status != 200:
            raise RuntimeError(f"the server refused the mask: {status} {answer}")
        report("complete", {"message": f"{int(mask.sum())} voxels"})
        print(f"job {jid}: done, {int(mask.sum())} voxels", flush=True)
    except Gone as e:
        print(f"{e}: dropped", file=sys.stderr, flush=True)
    except Exception:  # noqa: BLE001 - every failure is reported to the server
        msg = traceback.format_exc()
        print(msg, file=sys.stderr, flush=True)
        try:
            report("fail", {"message": msg.strip().splitlines()[-1][:500] if msg.strip() else "failed"})
        except Gone:
            pass
    return True


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("EXACT_URL", "http://127.0.0.1:8000"))
    ap.add_argument("--user", default=os.environ.get("EXACT_USER"))
    ap.add_argument("--password", default=os.environ.get("EXACT_PASSWORD"))
    ap.add_argument("--name", default=f"{socket.gethostname()}-{os.getpid()}")
    ap.add_argument("--plugins-dir", default=str(HERE / "segmenters"), help="folder with the segmenter modules")
    ap.add_argument("--only", help="serve only the segmenters whose name contains this")
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between polls when idle")
    ap.add_argument("--once", action="store_true", help="work off the queue and exit")
    a = ap.parse_args(argv)
    if not a.user or not a.password:
        ap.error("--user and --password (or EXACT_USER / EXACT_PASSWORD) are required")
    api = Api(a.url, a.user, a.password)
    segmenters = load_segmenters(a.plugins_dir, a.only)
    served, announced = {}, 0.0
    while True:
        try:
            if not served or time.time() - announced > 600:
                served, announced = announce(api, segmenters), time.time()
                if not served:
                    print("no segmenter can run here", file=sys.stderr, flush=True)
                    if a.once:
                        return 1
                    time.sleep(a.interval)
                    continue
            busy = work(api, a.name, served)
        except Exception as e:  # noqa: BLE001 - keep polling when the server is unreachable
            print(f"worker error: {e}", file=sys.stderr, flush=True)
            busy = False
            if a.once:
                return 1
        if not busy:
            if a.once:
                return 0
            time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
