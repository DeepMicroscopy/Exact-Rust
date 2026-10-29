"""The queue worker (helpers/queue_worker.py) with a plugin of its own: announcing, parameters, result (Rust only)."""
import os
import pathlib
import subprocess
import sys
import textwrap
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

ROOT = pathlib.Path(__file__).resolve().parents[2]
JSRC, JTGT = 15, 16

PLUGIN = '''
from queue_plugin import RegistrationPlugin, RegistrationResult, param

class Shift(RegistrationPlugin):
    name = "{name}"
    package = "test_shift"
    parameters = [param("shift", "float", 3.0, "Shift", "pixels to the right", min=0, max=100), param("fail", "bool", False, "Fail")]

    def register(self, source_path, target_path, params, ctx):
        if params["fail"]:
            raise RuntimeError("asked to fail")
        m = {{"t_00": 1.0, "t_01": 0.0, "t_02": params["shift"], "t_10": 0.0, "t_11": 1.0, "t_12": 0.0, "t_20": 0.0, "t_21": 0.0, "t_22": 1.0}}
        return RegistrationResult(matrix=m, error=0.25, runtime=1)

PLUGINS = [Shift()]
'''


def client(user="aubreville"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def psql(sql):
    subprocess.run([f"{os.environ.get('PGBIN', '/Applications/Postgres.app/Contents/Versions/latest/bin')}/psql", "-h", "127.0.0.1", "-d", os.environ.get("RUST_DB", "exact_rust_test"), "-Atc", sql], capture_output=True)


@pytest.fixture
def folder(tmp_path):
    name = f"shift-{uuid.uuid4().hex[:6]}"
    (tmp_path / "shift.py").write_text(textwrap.dedent(PLUGIN).format(name=name))
    psql("update processing_pluginjob set error_message = 'test cleanup' where error_message is null and processing_complete < 100 and plugin_id in (select id from processing_plugin where plugin_type = 2)")
    yield tmp_path, name
    psql(f"delete from processing_pluginjob where plugin_id in (select id from processing_plugin where name = '{name}')")
    psql(f"delete from processing_plugin where name = '{name}'")
    c = client()
    for r in c.get("/api/v2/registrations", params={"source_image": JSRC, "target_image": JTGT}).json()["items"]:
        c.delete(f"/api/v2/registrations/{r['id']}")


def run_worker(folder, name="qw"):
    env = {**os.environ, "EXACT_URL": BASE, "EXACT_USER": "aubreville", "EXACT_PASSWORD": PW}
    return subprocess.run([sys.executable, str(ROOT / "helpers/queue_worker.py"), "--once", "--name", name, "--plugins", str(folder)], env=env, capture_output=True, text=True, timeout=120)


def test_the_worker_announces_its_plugin_and_runs_a_job_with_the_chosen_parameters(folder):
    path, name = folder
    c = client()
    out = run_worker(path)  # announces the plugin first (nothing to do yet)
    assert out.returncode == 0, out.stdout + out.stderr
    plugin = next(p for p in c.get("/api/v2/registration-plugins").json()["items"] if p["name"] == name)
    assert [p["name"] for p in plugin["parameters_schema"]] == ["shift", "fail"]
    job = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT, "plugin": plugin["id"], "shift": 12.5}).json()
    out = run_worker(path)
    assert out.returncode == 0 and "done" in out.stdout, out.stdout + out.stderr
    done = next(j for j in c.get("/api/v2/jobs", params={"kind": "registration", "limit": 500}).json()["items"] if j["id"] == job["id"])
    assert done["status"] == "done" and done["worker"] == "qw" and done["plugin_name"] == name
    reg = c.get(f"/api/v2/registrations/{done['result']}").json()
    assert reg["transformation_matrix"]["t_02"] == 12.5 and reg["registration_error"] == 0.25


def test_a_failing_plugin_reports_its_error(folder):
    path, name = folder
    c = client()
    run_worker(path)
    plugin = next(p for p in c.get("/api/v2/registration-plugins").json()["items"] if p["name"] == name)
    job = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT, "plugin": plugin["id"], "fail": True}).json()
    run_worker(path)
    failed = next(j for j in c.get("/api/v2/jobs", params={"kind": "registration", "status": "failed", "limit": 500}).json()["items"] if j["id"] == job["id"])
    assert "asked to fail" in failed["error"]
    # restarting it (with the same parameters) queues it again for the next worker
    assert c.post(f"/api/v2/jobs/registration/{job['id']}/restart").status_code == 204


def test_a_broken_plugin_file_does_not_stop_the_others(folder):
    path, name = folder
    (path / "broken.py").write_text("raise SystemError('nope')\n")
    out = run_worker(path)
    assert out.returncode == 0 and "cannot be loaded" in out.stderr
    assert any(p["name"] == name for p in client().get("/api/v2/registration-plugins").json()["items"])
