"""Automatic segmentation: segmenters, jobs, the voxel download and the real worker (Rust only)."""
import os
import pathlib
import subprocess
import sys
import uuid

import httpx
import numpy as np
import pytest
from common import BASE, PW
from test_v2_registration import client
from test_v2_seg3d import ct_volume, slice_alpha

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

NIFTI, SET, SEG_TYPE, SEG_PRODUCT, BBOX_TYPE = 80, 1, 2, 2, 1
ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKER = ROOT / "helpers" / "segment_worker.py"
SCHEMA = [
    {"name": "level", "type": "float", "default": 0.5},
    {"name": "mode", "type": "choice", "choices": ["a", "b"], "default": "a"},
    {"name": "tidy", "type": "bool", "default": True},
]


def python_with_scipy():
    for py in (os.environ.get("SEGMENT_PYTHON"), "/opt/miniconda3/envs/env311/bin/python", sys.executable):
        if py and pathlib.Path(py).exists() and subprocess.run([py, "-c", "import numpy, scipy"], capture_output=True).returncode == 0:
            return py
    return None


@pytest.fixture()
def products():
    c = client("aubreville")
    c.put(f"/api/v2/image-sets/{SET}/products/{SEG_PRODUCT}")
    yield c
    c.delete(f"/api/v2/image-sets/{SET}/products/{SEG_PRODUCT}")


@pytest.fixture()
def segmenter(products):
    name = f"test-seg-{uuid.uuid4().hex[:6]}"
    r = products.post("/api/v2/segmenters/register", json={"name": name, "author": "tests", "description": "x", "parameters_schema": SCHEMA})
    assert r.status_code == 201, r.text
    yield name
    # jobs of the test are removed by the tests; the segmenter row stays (it is a name)


@pytest.fixture()
def ct(tmp_path, products):
    pytest.importorskip("pydicom")
    name = f"ct-{uuid.uuid4().hex[:8]}.dcm"
    f = tmp_path / name
    ct_volume(f)
    up = products.post(f"/api/v2/image-sets/{SET}/images", files={"file": (name, f.read_bytes())})
    assert up.status_code == 201, up.text
    iid = up.json()["items"][0]["id"]
    yield iid
    products.delete(f"/api/v2/images/{iid}")


def job_body(segmenter, **extra):
    return {"segmenter": segmenter, "annotation_type": SEG_TYPE, **extra}


def clear_jobs(c, image):
    """Jobs a crashed earlier run left on the image."""
    for j in c.get("/api/v2/segmentation-jobs", params={"image": image}).json()["items"]:
        c.delete(f"/api/v2/jobs/segmentation/{j['id']}")


def finish(c, jid):
    c.delete(f"/api/v2/jobs/segmentation/{jid}")


def test_a_worker_announces_a_segmenter_and_users_see_it(products, segmenter):
    c = products
    again = c.post("/api/v2/segmenters/register", json={"name": segmenter, "description": "changed", "parameters_schema": SCHEMA})
    assert again.status_code == 200
    mine = next(s for s in c.get("/api/v2/segmenters").json()["items"] if s["name"] == segmenter)
    assert mine["description"] == "changed" and mine["available"] and [p["name"] for p in mine["parameters_schema"]] == ["level", "mode", "tidy"]
    assert c.post("/api/v2/segmenters/register", json={"name": "x", "parameters_schema": [{"name": "a", "type": "matrix"}]}).status_code == 400
    assert c.post("/api/v2/segmenters/register", json={"parameters_schema": []}).status_code == 400
    # announcing needs the plugin permission; everybody may read the list
    member = client("rt_member")
    assert member.post("/api/v2/segmenters/register", json={"name": "nope"}).status_code in (403, 401)
    assert member.get("/api/v2/segmenters").status_code == 200


def test_the_voxels_of_a_volume_come_as_raw_arrays_of_the_mask_grid(ct):
    c = client("aubreville")
    r = c.get(f"/api/v2/images/{ct}/voxels")
    assert r.status_code == 200
    h = r.headers
    assert (h["x-voxels-width"], h["x-voxels-height"], h["x-voxels-frames"], h["x-dtype"]) == ("64", "48", "40", "uint8")
    assert [round(float(v), 2) for v in h["x-voxel-mm"].split(",")] == [0.8, 0.8, 2.5]
    disp = np.frombuffer(r.content, np.uint8).reshape(40, 48, 64)
    assert disp[25, 20, 40] > 200 and disp[0, 0, 0] < 120  # the bright ball, the background (window 500 / 1200)
    r = c.get(f"/api/v2/images/{ct}/voxels?kind=intensity")
    assert r.status_code == 200 and r.headers["x-dtype"] == "float32"
    vol = np.frombuffer(r.content, "<f4").reshape(40, 48, 64)
    assert vol[25, 20, 40] == 1000 and vol[0, 0, 0] == 100 and vol[10, 30, 15] == 600  # true values, (z, y, x)
    assert c.get(f"/api/v2/images/{ct}/voxels?kind=other").status_code == 400
    assert client("rt_outsider").get(f"/api/v2/images/{ct}/voxels").status_code == 404
    # a plain image is not a volume
    assert c.get("/api/v2/images/2/voxels").status_code == 400


def test_a_nifti_volume_gives_true_values_too():
    c = client("aubreville")
    r = c.get(f"/api/v2/images/{NIFTI}/voxels?kind=intensity")
    assert r.status_code == 200
    w, h, n = (int(r.headers[f"x-voxels-{k}"]) for k in ("width", "height", "frames"))
    vol = np.frombuffer(r.content, "<f4")
    assert vol.size == w * h * n and np.isfinite(vol).all() and vol.max() > vol.min()
    disp = np.frombuffer(c.get(f"/api/v2/images/{NIFTI}/voxels").content, np.uint8)
    assert disp.size == vol.size
    # the display grey is a monotone function of the true value: the brightest true voxels are bright on screen
    top = vol >= np.percentile(vol, 99.5)
    assert disp[top].mean() > 200


def test_creating_a_job_checks_what_it_needs(products, segmenter, ct):
    c = products
    assert c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body("no-such")).status_code == 400
    assert c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body(segmenter, parameters={"bogus": 1})).status_code == 400
    assert c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body(segmenter, parameters={"level": [1]})).status_code == 400
    assert c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body(segmenter, mode="paint")).status_code == 400
    assert c.post(f"/api/v2/images/{ct}/auto-segment", json={"segmenter": segmenter, "annotation_type": BBOX_TYPE}).status_code == 400  # not a segmentation type
    assert c.post(f"/api/v2/images/{ct}/auto-segment", json={"segmenter": segmenter}).status_code == 400
    assert c.post("/api/v2/images/2/auto-segment", json=job_body(segmenter)).status_code == 400  # not a volume
    assert c.post("/api/v2/images/99999999/auto-segment", json=job_body(segmenter)).status_code == 404
    assert client("rt_outsider").post(f"/api/v2/images/{ct}/auto-segment", json=job_body(segmenter)).status_code == 404
    made = c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body(segmenter, parameters={"level": 0.25}))
    assert made.status_code == 201, made.text
    job = made.json()
    assert job["status"] == "queued" and job["mode"] == "replace" and job["parameters"] == {"level": 0.25} and job["annotation"]
    # the mask annotation exists, as a segmentation annotation of the image
    a = c.get(f"/api/v2/annotations/{job['annotation']}").json()
    assert a["image"] == ct and a["annotation_type"] == SEG_TYPE
    # a second job for the same image and type is refused while the first one waits
    assert c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body(segmenter)).status_code == 409
    assert c.get(f"/api/v2/segmentation-jobs/{job['id']}").json()["id"] == job["id"]
    assert [j["id"] for j in c.get("/api/v2/segmentation-jobs", params={"image": ct}).json()["items"]] == [job["id"]]
    assert client("rt_outsider").get(f"/api/v2/segmentation-jobs/{job['id']}").status_code == 404
    finish(c, job["id"])
    assert c.get(f"/api/v2/segmentation-jobs/{job['id']}").status_code == 404
    c.delete(f"/api/v2/annotations/{job['annotation']}?hard=true")


def test_a_worker_claims_reports_and_completes_a_job(products, segmenter, ct):
    c = products
    job = c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body(segmenter, mode="add")).json()
    w = client("aubreville")
    name = f"w-{uuid.uuid4().hex[:5]}"
    assert w.post("/api/v2/segmentation-jobs/claim", json={"worker": name, "segmenter": "another"}).status_code == 204
    assert w.post("/api/v2/segmentation-jobs/claim", json={}).status_code == 400
    got = w.post("/api/v2/segmentation-jobs/claim", json={"worker": name, "segmenters": [segmenter]})
    assert got.status_code == 200 and got.json()["id"] == job["id"] and got.json()["status"] == "running" and got.json()["worker"] == name
    assert w.post("/api/v2/segmentation-jobs/claim", json={"worker": "w2"}).status_code in (204, 200)
    # another worker's report is refused, the right one's is taken
    assert w.post(f"/api/v2/segmentation-jobs/{job['id']}/progress", json={"worker": "other", "progress": 0.5}).status_code == 409
    assert w.post(f"/api/v2/segmentation-jobs/{job['id']}/progress", json={"worker": name, "progress": 0.4, "message": "halfway"}).status_code == 204
    seen = c.get(f"/api/v2/segmentation-jobs/{job['id']}").json()
    assert seen["status"] == "running" and abs(seen["progress"] - 0.4) < 1e-6 and seen["message"] == "halfway"
    # the jobs page lists it as a job of kind segmentation
    items = c.get("/api/v2/jobs", params={"kind": "segmentation"}).json()["items"]
    row = next(i for i in items if i["id"] == job["id"])
    assert row["kind"] == "segmentation" and row["status"] == "running" and row["plugin_name"] == segmenter and row["images"] == [ct]
    assert any(i["id"] == job["id"] for i in c.get("/api/v2/jobs").json()["items"])
    assert c.get("/api/v2/jobs", params={"kind": "bogus"}).status_code == 400
    # the mask goes in through the labels endpoint, then the job is complete
    vol = np.zeros((40, 48, 64), np.uint8)
    vol[20:30, 10:30, 30:50] = 1
    put = w.put(f"/api/v2/segmentation/{job['annotation']}/labels?mode=add", content=vol.tobytes())
    assert put.status_code == 200 and put.json()["count"] == 10 * 20 * 20
    assert w.post(f"/api/v2/segmentation-jobs/{job['id']}/complete", json={"worker": name}).status_code == 204
    done = c.get(f"/api/v2/segmentation-jobs/{job['id']}").json()
    assert done["status"] == "done" and done["progress"] == 1 and done["finished_at"]
    assert next(i for i in c.get("/api/v2/jobs", params={"kind": "segmentation"}).json()["items"] if i["id"] == job["id"])["result"] == job["annotation"]
    assert w.post(f"/api/v2/segmentation-jobs/{job['id']}/complete", json={}).status_code == 409  # not running any more
    finish(c, job["id"])
    c.delete(f"/api/v2/annotations/{job['annotation']}?hard=true")


def test_a_failed_job_can_be_restarted_and_a_removed_one_is_dropped(products, segmenter, ct):
    c = products
    job = c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body(segmenter)).json()
    w = client("aubreville")
    assert w.post("/api/v2/segmentation-jobs/claim", json={"worker": "w", "segmenter": segmenter}).json()["id"] == job["id"]
    assert w.post(f"/api/v2/segmentation-jobs/{job['id']}/fail", json={"worker": "w", "message": "the model ran out of memory"}).status_code == 204
    failed = c.get(f"/api/v2/segmentation-jobs/{job['id']}").json()
    assert failed["status"] == "failed" and failed["message"] == "the model ran out of memory"
    assert next(i for i in c.get("/api/v2/jobs", params={"kind": "segmentation", "status": "failed"}).json()["items"] if i["id"] == job["id"])["error"] == "the model ran out of memory"
    assert c.post(f"/api/v2/jobs/segmentation/{job['id']}/restart").status_code == 204
    assert c.get(f"/api/v2/segmentation-jobs/{job['id']}").json()["status"] == "queued"
    assert c.post(f"/api/v2/jobs/segmentation/{job['id']}/restart").status_code == 409  # only a failed job
    assert w.post("/api/v2/segmentation-jobs/claim", json={"worker": "w"}).json()["id"] == job["id"]
    # a removed job: the worker that still reports on it is told so
    assert c.delete(f"/api/v2/jobs/segmentation/{job['id']}").status_code == 204
    assert w.post(f"/api/v2/segmentation-jobs/{job['id']}/progress", json={"progress": 0.9}).status_code == 404
    c.delete(f"/api/v2/annotations/{job['annotation']}?hard=true")


def run_worker(segmenter=None, plugins_dir=None):
    py = python_with_scipy()
    if py is None:
        pytest.skip("no Python with numpy and scipy for the worker")
    cmd = [py, str(WORKER), "--url", BASE, "--user", "aubreville", "--password", PW, "--name", "pytest", "--once"]
    if plugins_dir:
        cmd += ["--plugins-dir", str(plugins_dir)]
    if segmenter:
        cmd += ["--only", segmenter]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    assert p.returncode == 0, p.stdout + p.stderr
    return p.stdout


def test_the_real_worker_segments_a_ct_volume_with_the_threshold_method(products, ct):
    c = products
    out = run_worker("threshold")  # announces the shipped segmenters (once: nothing queued yet)
    names = [s["name"] for s in c.get("/api/v2/segmenters").json()["items"]]
    assert "Threshold" in names and "nnU-Net (your model)" not in names, names  # the skeleton registers nothing without a model
    schema = next(s for s in c.get("/api/v2/segmenters").json()["items"] if s["name"] == "Threshold")["parameters_schema"]
    assert {p["name"] for p in schema} >= {"method", "lower", "upper", "closing", "keep_largest"}
    # bounds from 500 HU: the bright ball (radius 8 mm) and the dim one (5 mm, 600 HU); only the larger part is kept
    made = c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body("Threshold", parameters={"method": "bounds", "lower": 500}))
    assert made.status_code == 201, made.text
    job = made.json()
    out = run_worker("threshold")
    assert f"job {job['id']}: done" in out, out
    done = c.get(f"/api/v2/segmentation-jobs/{job['id']}").json()
    assert done["status"] == "done", done
    v = c.get(f"/api/v2/segmentation/{job['annotation']}/volume").json()
    assert 1100 < v["count"] < 1600, v["count"]  # 4/3 pi 8^3 = 2144 mm3 at 1.6 mm3 per voxel
    x0, x1, y0, y1, z0, z1 = v["bbox"]
    assert 28 <= x0 and x1 <= 52 and 8 <= y0 and y1 <= 32 and 21 <= z0 and z1 <= 29, v["bbox"]
    assert abs((x0 + x1) / 2 - 40) < 2 and abs((y0 + y1) / 2 - 20) < 2 and abs((z0 + z1) / 2 - 25) < 1.5
    # the dim ball is not in it, and the mask is on the planes: the coronal slice through the ball shows it
    assert 10 not in v["slices"]
    ny = v["voxels"][1]
    yv = ny - 1 - int(20.5 / 48 * ny)
    assert slice_alpha(c, job["annotation"], 1, yv)[1]
    # without 'keep the largest part' both balls come out
    again = c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body("Threshold", mode="replace", parameters={"method": "bounds", "lower": 500, "keep_largest": False}))
    assert again.status_code == 201, again.text
    run_worker("threshold")
    v2 = c.get(f"/api/v2/segmentation/{job['annotation']}/volume").json()
    assert v2["count"] > v["count"] and 10 in v2["slices"]
    # and the result can be undone like painting: back to the first mask (the undo steps live in memory; a long run of other
    # masks in the same server can have pushed this one out, then there is nothing to undo)
    undo = c.post(f"/api/v2/segmentation/{job['annotation']}/undo")
    assert undo.status_code in (200, 409)
    if undo.status_code == 200:
        assert undo.json()["count"] == v["count"]
    for j in (job, again.json()):
        finish(c, j["id"])
    c.delete(f"/api/v2/annotations/{job['annotation']}?hard=true")


def test_the_real_worker_segments_a_nifti_volume_and_an_empty_result_is_a_mask_not_an_error(products):
    c = products
    clear_jobs(c, NIFTI)
    run_worker("threshold")
    made = c.post(f"/api/v2/images/{NIFTI}/auto-segment", json=job_body("Threshold"))
    assert made.status_code == 201, made.text
    job = made.json()
    out = run_worker("threshold")
    assert f"job {job['id']}: done" in out, out
    v = c.get(f"/api/v2/segmentation/{job['annotation']}/volume").json()
    assert v["count"] > 1000 and v["bbox"] is not None
    for j in [job]:
        finish(c, j["id"])
    # nothing above 5e9 is an empty mask, which replaces the old one; the job is done, not failed
    bad = c.post(f"/api/v2/images/{NIFTI}/auto-segment", json=job_body("Threshold", parameters={"method": "bounds", "lower": 5e9, "upper": 6e9, "closing": 0}))
    assert bad.status_code == 201
    run_worker("threshold")
    after = c.get(f"/api/v2/segmentation-jobs/{bad.json()['id']}").json()
    assert after["status"] == "done"
    assert c.get(f"/api/v2/segmentation/{job['annotation']}/volume").json()["count"] == 0
    finish(c, bad.json()["id"])
    c.delete(f"/api/v2/annotations/{job['annotation']}?hard=true")


def test_a_segmenter_that_raises_fails_its_job_with_the_reason_and_a_wrong_mask_shape_is_refused(products, ct, tmp_path):
    c = products
    clear_jobs(c, ct)
    boom, wrong = f"boom-{uuid.uuid4().hex[:5]}", f"wrong-{uuid.uuid4().hex[:5]}"
    (tmp_path / "boom.py").write_text(f"NAME = {boom!r}\nPARAMS = []\ndef segment(volume, spacing_mm, params, progress):\n    raise ValueError('no model is installed')\n")
    (tmp_path / "wrong.py").write_text(f"import numpy as np\nNAME = {wrong!r}\nPARAMS = []\ndef segment(volume, spacing_mm, params, progress):\n    return np.zeros((3, 3, 3))\n")
    run_worker(plugins_dir=tmp_path)  # announces both
    for name, why in ((boom, "no model is installed"), (wrong, "shape")):
        made = c.post(f"/api/v2/images/{ct}/auto-segment", json=job_body(name))
        assert made.status_code == 201, made.text
        out = run_worker(plugins_dir=tmp_path)
        job = c.get(f"/api/v2/segmentation-jobs/{made.json()['id']}").json()
        assert job["status"] == "failed" and why in job["message"], (job, out)
        assert c.post(f"/api/v2/jobs/segmentation/{job['id']}/restart").status_code == 204
        finish(c, job["id"])
    c.delete(f"/api/v2/annotations/{made.json()['annotation']}?hard=true")
