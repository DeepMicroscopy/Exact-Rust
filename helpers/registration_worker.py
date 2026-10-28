#!/usr/bin/env python3
"""Registration worker: computes image registrations for the EXACT Rust server with `qt-wsi-registration`.

It claims registration jobs from the common queue (`POST /api/v2/jobs/claim`, kind `registration`), registers source onto target exactly as
`ImageRegistration.perform_registration` of EXACT does, and reports the result (`.../complete`, with the pickled quad tree
as file) or the error (`.../fail`). Several workers can run side by side; a job whose worker disappears is claimed again
after its lease (30 minutes) ran out.

    registration_worker.py --url http://localhost:8000 --user worker --password ... [--name w1] [--once]

The worker runs on a machine that sees the image files under the same paths as the server (it receives absolute paths).
The user needs the Django permission `images.change_imageregistration`. Slides are opened with OpenSlide; with
`--exact-dir <EXACT checkout>/exact` (or EXACT_DIR) EXACT's own `getSlideHandler` is used, which also reads the formats
OpenSlide does not.
"""
import argparse
import base64
import json
import os
import pickle
import socket
import sys
import time
import traceback
import urllib.error
import urllib.request
import uuid


class Api:
    def __init__(self, url, user, password):
        self.url = url.rstrip("/")
        self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def call(self, path, body=None, files=None):
        headers = {"Authorization": self.auth}
        if files:
            boundary = uuid.uuid4().hex
            parts = []
            for k, v in (body or {}).items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
            for k, (name, data) in files.items():
                parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"; filename="{name}"\r\n'
                             f"Content-Type: application/octet-stream\r\n\r\n".encode() + data + b"\r\n")
            parts.append(f"--{boundary}--\r\n".encode())
            data = b"".join(parts)
            headers["Content-Type"] = f"multipart/form-data; boundary={boundary}"
        else:
            data = json.dumps(body or {}).encode()
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=300) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode(errors="replace")


def open_slide(path, exact_dir):
    if exact_dir:
        sys.path.insert(0, exact_dir)
        from util.slide_server import getSlideHandler  # EXACT's own reader selection
        return getSlideHandler(path)
    import openslide
    return openslide.OpenSlide(path)


def register(job, exact_dir):
    import qt_wsi_reg.registration_tree as registration

    p = job.get("params") or {}
    parameters = {
        "point_extractor": "sift",
        "maxFeatures": p.get("maxFeatures", 512),
        "crossCheck": p.get("crossCheck", False),
        "flann": p.get("flann", False),
        "ratio": p.get("ratio", 0.7),
        "use_gray": p.get("use_gray", False),
        "homography": p.get("homography", True),
        "filter_outliner": p.get("filter_outliner", False),
        "debug": False,
        "target_depth": p.get("target_depth", 0),
        "run_async": True,
        "num_workers": 4,
        "thumbnail_size": tuple(p.get("thumbnail_size", (2048, 2048))),
    }
    qtree = registration.RegistrationQuadTree(
        source_slide=open_slide(job["source_path"], exact_dir),
        target_slide=open_slide(job["target_path"], exact_dir),
        **parameters)
    h = qtree.get_homography
    matrix = {f"t_{i}{j}": float(h[i][j]) for i in range(3) for j in range(3)}
    return matrix, float(qtree.mean_reg_error), int(qtree.run_time), pickle.dumps(qtree)


def work(api, name, exact_dir):
    # the common queue (registration jobs and image analysis jobs): this worker only asks for the kind it can do
    status, claimed = api.call("/api/v2/jobs/claim", {"worker": name, "kinds": ["registration"]})
    if status == 204:
        return False
    if status != 200:
        raise RuntimeError(f"claim failed: {status} {claimed}")
    job = claimed["job"]
    print(f"job {job['id']}: registering image {job['source_image']} onto {job['target_image']}", flush=True)
    try:
        matrix, error, runtime, blob = register(job, exact_dir)
    except Exception:  # noqa: BLE001 - every failure is reported to the server
        msg = traceback.format_exc()[-3500:]
        print(msg, file=sys.stderr, flush=True)
        api.call(f"/api/v2/registration-jobs/{job['id']}/fail", {"worker": name, "error": msg})
        return True
    status, body = api.call(
        f"/api/v2/registration-jobs/{job['id']}/complete",
        {"worker": name, "transformation_matrix": json.dumps(matrix), "registration_error": error, "runtime": runtime},
        files={"file": (f"{job['id']}.pickle", blob)})
    print(f"job {job['id']}: done ({status}), error {error:.3f}", flush=True)
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=os.environ.get("EXACT_URL", "http://127.0.0.1:8000"))
    ap.add_argument("--user", default=os.environ.get("EXACT_USER"))
    ap.add_argument("--password", default=os.environ.get("EXACT_PASSWORD"))
    ap.add_argument("--name", default=f"{socket.gethostname()}-{os.getpid()}")
    ap.add_argument("--exact-dir", default=os.environ.get("EXACT_DIR"))
    ap.add_argument("--interval", type=float, default=5.0, help="seconds between polls when idle")
    ap.add_argument("--once", action="store_true", help="work off the queue and exit")
    a = ap.parse_args()
    if not a.user or not a.password:
        ap.error("--user and --password (or EXACT_USER / EXACT_PASSWORD) are required")
    api = Api(a.url, a.user, a.password)
    while True:
        try:
            busy = work(api, a.name, a.exact_dir)
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
