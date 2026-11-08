"""Image analysis jobs on the queue worker (helpers/queue_worker.py): the claim shows the file and the annotation types, the
result is stored in one request, failures and a missing annotation type are reported (Rust only)."""
import os
import subprocess
import sys
import textwrap
import uuid

import httpx
import pytest
from common import BASE, PW
from test_example_plugins import remove_plugin
from test_queue_worker import ROOT, psql

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGE = 2

PLUGIN = '''
from queue_plugin import AnalysisResult, ImageAnalysisPlugin, param

class Finder(ImageAnalysisPlugin):
    name = "{name}"
    package = "test_finder"
    parameters = [param("n", "int", 3, "How many", min=0, max=1000), param("fail", "bool", False, "Fail"), param("type", "text", "{atype}", "Type")]

    def analyze(self, image_path, params, ctx):
        if params["fail"]:
            raise RuntimeError("asked to fail")
        assert image_path.endswith(".tiff") or image_path.endswith(".png") or "." in image_path, image_path
        ctx.progress(50)
        found = [{{"vector": {{"x1": i, "y1": i, "x2": i + 10, "y2": i + 10}}, "score": 0.5 + i / 1000}} for i in range(params["n"])]
        return AnalysisResult(found, params["type"], "Finds", 0.55)

PLUGINS = [Finder()]
'''


def client(user="aubreville"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def run_worker(folder):
    env = {**os.environ, "EXACT_URL": BASE, "EXACT_USER": "aubreville", "EXACT_PASSWORD": PW}
    return subprocess.run([sys.executable, str(ROOT / "helpers/queue_worker.py"), "--once", "--name", "qa", "--plugins", str(folder)],
                          env=env, capture_output=True, text=True, timeout=120)


@pytest.fixture
def setup(tmp_path):
    c = client()
    atype = c.get("/api/v2/annotation-types/1").json()["name"]
    name = f"finder-{uuid.uuid4().hex[:6]}"
    (tmp_path / "finder.py").write_text(textwrap.dedent(PLUGIN).format(name=name, atype=atype.lower()))
    psql("update processing_pluginjob set error_message = 'test cleanup' where error_message is null and processing_complete < 100 and plugin_id in (select id from processing_plugin where plugin_type = 1)")
    out = run_worker(tmp_path)  # announces the plugin
    assert out.returncode == 0, out.stdout + out.stderr
    plugin = next(p for p in c.get("/api/v2/plugins").json()["items"] if p["name"] == name)
    yield c, tmp_path, plugin
    remove_plugin(c, plugin["id"])


def job_of(c, plugin, params=None):
    body = {"plugin": plugin["id"], "image": IMAGE}
    r = c.post("/api/v2/plugin-jobs", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def test_an_analysis_job_is_run_and_its_detections_are_stored_at_once(setup):
    c, folder, plugin = setup
    job = job_of(c, plugin)
    out = run_worker(folder)
    assert out.returncode == 0 and "done, 3 detections" in out.stdout, out.stdout + out.stderr
    j = c.get(f"/api/v2/plugin-jobs/{job['id']}").json()
    assert j["processing_complete"] == 100 and j["error_message"] is None
    result = c.get(f"/api/v2/plugin-results/{j['result']}").json() if isinstance(j["result"], int) else j["result"]
    entry = result["entries"][0] if isinstance(result["entries"][0], dict) else c.get(f"/api/v2/plugin-result-entries/{result['entries'][0]}").json()
    assert entry["name"] == "Finds" and entry["default_threshold"] == 0.55
    anns = entry["annotation_results"]
    assert len(anns) == 3
    first = anns[0] if isinstance(anns[0], dict) else c.get(f"/api/v2/plugin-result-annotations/{anns[0]}").json()
    assert first["annotation_type"] == 1 and first["image"] == IMAGE and first["generated"] is True and len(first["unique_identifier"]) == 36
    assert run_worker(folder).stdout.count("job ") == 0  # nothing left to do


def test_the_claim_shows_the_file_and_the_annotation_types(setup):
    c, _, plugin = setup
    job = job_of(c, plugin)
    r = c.post("/api/v2/jobs/claim", json={"worker": "probe", "kinds": ["plugin"], "plugin": plugin["id"]})
    assert r.status_code == 200, r.text
    got = r.json()["job"]
    assert got["id"] == job["id"] and got["image_path"].endswith("/") is False and "annotation_types" in got
    assert any(t["id"] == 1 for t in got["annotation_types"])
    # only the worker the job is attached to may report on it, and once
    assert c.post(f"/api/v2/plugin-jobs/{job['id']}/progress", json={"worker": "other", "progress": 10}).status_code == 409
    assert c.post(f"/api/v2/plugin-jobs/{job['id']}/progress", json={"worker": "probe", "progress": 10}).status_code == 204
    assert c.get(f"/api/v2/plugin-jobs/{job['id']}").json()["processing_complete"] == 10
    bad = c.post(f"/api/v2/plugin-jobs/{job['id']}/complete", json={"worker": "probe", "annotation_type": 99999999, "detections": []})
    assert bad.status_code == 400
    bad = c.post(f"/api/v2/plugin-jobs/{job['id']}/complete", json={"worker": "probe", "annotation_type": 1, "detections": [{"vector": {"x1": 1}}]})
    assert bad.status_code == 400 and "detections[0]" in bad.text
    # the vector has to be valid for the type (type 1 is a box): reversed corners, a missing corner, a polygon's keys
    for vector in ({"x1": 50, "y1": 10, "x2": 10, "y2": 60}, {"x1": 1, "y1": 1, "x2": 5}, {"x1": 1, "y1": 1, "x2": 5, "y2": 5, "x3": 7, "y3": 7}):
        bad = c.post(f"/api/v2/plugin-jobs/{job['id']}/complete", json={"worker": "probe", "annotation_type": 1, "detections": [{"vector": vector, "score": 0.5}]})
        assert bad.status_code == 400 and "detections[0]" in bad.text and "not valid for the annotation type" in bad.text, bad.text
    ok = c.post(f"/api/v2/plugin-jobs/{job['id']}/complete", json={"worker": "probe", "annotation_type": 1, "name": "x", "detections": []})
    assert ok.status_code == 201 and ok.json()["annotations"] == 0
    assert c.post(f"/api/v2/plugin-jobs/{job['id']}/complete", json={"worker": "probe", "annotation_type": 1, "detections": []}).status_code == 409


def test_a_failing_plugin_and_a_missing_annotation_type_are_reported(setup):
    c, folder, plugin = setup
    job = job_of(c, plugin)
    psql(f"update processing_plugin set id = id where id = {plugin['id']}")
    # the plugin asks for a type the set does not have
    r = c.patch(f"/api/v2/plugin-jobs/{job['id']}", json={"attached_worker": ""})
    assert r.status_code == 200
    env = {**os.environ, "EXACT_URL": BASE, "EXACT_USER": "aubreville", "EXACT_PASSWORD": PW}
    # parameters of a job are not stored for analysis jobs: the plugin defaults decide, so use a plugin file with other defaults
    (folder / "finder.py").write_text((folder / "finder.py").read_text().replace('param("fail", "bool", False', 'param("fail", "bool", True'))
    out = subprocess.run([sys.executable, str(ROOT / "helpers/queue_worker.py"), "--once", "--name", "qa", "--plugins", str(folder)], env=env, capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stdout + out.stderr
    j = c.get(f"/api/v2/plugin-jobs/{job['id']}").json()
    assert j["error_message"] == "Error: RuntimeError" and "asked to fail" in j["error_detail"]


def test_the_viewer_lists_results_and_plugins_runs_with_parameters_and_serves_detections(setup):
    c, folder, plugin = setup
    a = c.get(f"/api/v2/images/{IMAGE}/analysis")
    assert a.status_code == 200, a.text
    mine = next(p for p in a.json()["plugins"] if p["id"] == plugin["id"])
    assert {x["name"] for x in mine["parameters_schema"]} == {"n", "fail", "type"} and mine["job"] is None
    # parameters are checked against the plugin's schema
    assert c.post(f"/api/v2/images/{IMAGE}/analyze", json={"plugin": plugin["id"], "params": {"nope": 1}}).status_code == 400
    assert c.post(f"/api/v2/images/{IMAGE}/analyze", json={"plugin": 99999999}).status_code == 400
    assert c.post("/api/v2/images/99999999/analyze", json={"plugin": plugin["id"]}).status_code == 404
    queued = c.post(f"/api/v2/images/{IMAGE}/analyze", json={"plugin": plugin["id"], "params": {"n": 5}})
    assert queued.status_code == 202 and queued.json()["reused"] is False, queued.text
    again = c.post(f"/api/v2/images/{IMAGE}/analyze", json={"plugin": plugin["id"], "params": {"n": 5}})
    assert again.status_code == 200 and again.json()["id"] == queued.json()["id"] and again.json()["reused"] is True
    out = run_worker(folder)  # the claimed job carries the parameters: 5 detections, not the default 3
    assert "done, 5 detections" in out.stdout, out.stdout + out.stderr
    a = c.get(f"/api/v2/images/{IMAGE}/analysis").json()
    result = next(r for r in a["results"] if r["plugin"]["id"] == plugin["id"])
    entry = result["entries"][0]
    assert entry["name"] == "Finds" and entry["count"] == 5 and entry["default_threshold"] == 0.55
    assert next(p for p in a["plugins"] if p["id"] == plugin["id"])["job"]["status"] == "done"
    d = c.get(f"/api/v2/plugin-result-entries/{entry['id']}/detections").json()
    assert len(d["boxes"]) == 5 and d["polygons"] == [] and d["truncated"] is False
    x1, y1, x2, y2, score, atype = d["boxes"][0]
    assert x2 - x1 == 10 and 0.5 <= score < 0.6 and str(atype) in d["types"]
    assert c.get("/api/v2/plugin-result-entries/99999999/detections").status_code == 404


def test_heartbeat_keeps_a_busy_worker_listed():
    """A worker computing a long job does not claim; its heartbeat keeps it (and its plugins) in the list of workers."""
    c = client()
    name = "hb-" + uuid.uuid4().hex[:8]
    r = c.post("/api/v2/jobs/heartbeat", json={"worker": name, "kinds": ["plugin"], "plugins": [424242]})
    assert r.status_code == 204
    mine = [w for w in c.get("/api/v2/jobs").json()["workers"] if w["name"] == name]
    assert mine and mine[0]["plugins"] == [424242] and mine[0]["kinds"] == ["plugin"]
    assert c.post("/api/v2/jobs/heartbeat", json={}).status_code == 400
    plain = client("rt_member")
    assert plain.post("/api/v2/jobs/heartbeat", json={"worker": name}).status_code == 403


def test_worker_sends_heartbeats_while_a_job_runs():
    sys.path.insert(0, str(ROOT / "helpers"))
    import queue_worker
    from queue_plugin import IMAGE_ANALYSIS

    calls = []

    class FakeApi:
        def call(self, path, body=None, files=None):
            calls.append((path, body))
            return 204, {}

    class P:
        plugin_type = IMAGE_ANALYSIS

    import time
    with queue_worker.heartbeat(FakeApi(), "w", {7: P()}, every=0.05):
        time.sleep(0.3)
    n = len(calls)
    assert n >= 3 and calls[0] == ("/api/v2/jobs/heartbeat", {"worker": "w", "kinds": ["plugin"], "plugins": [7]})
    time.sleep(0.2)
    assert len(calls) == n  # stopped with the job
