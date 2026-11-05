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
    psql(f"delete from processing_pluginresult where plugin_id = {plugin['id']}")
    psql(f"delete from processing_pluginjob where plugin_id = {plugin['id']}")
    psql(f"delete from processing_plugin where id = {plugin['id']}")


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
