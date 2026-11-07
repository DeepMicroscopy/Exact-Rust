"""The example plugins of helpers/plugin_examples (used in the HOWTO) run through the real worker (Rust only)."""
import os
import subprocess
import sys

import httpx
import pytest
from common import BASE, PW
from test_queue_worker import ROOT, psql

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

EXAMPLES = ROOT / "helpers" / "plugin_examples"
IMAGE, JSRC, JTGT = 2, 15, 16


def client():
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": "aubreville", "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def remove_plugin(c, plugin_id):
    """Everything a test plugin left: its results, jobs and the plugin (through the API: needs no database client)."""
    for res in c.get("/api/v2/plugin-results", params={"plugin": plugin_id, "limit": 200}).json()["items"]:
        c.delete(f"/api/v2/plugin-results/{res['id']}")
    for job in c.get("/api/v2/plugin-jobs", params={"plugin": plugin_id, "limit": 200}).json()["items"]:
        c.delete(f"/api/v2/plugin-jobs/{job['id']}")
    c.delete(f"/api/v2/plugins/{plugin_id}")


def worker(only):
    env = {**os.environ, "EXACT_URL": BASE, "EXACT_USER": "aubreville", "EXACT_PASSWORD": PW}
    return subprocess.run([sys.executable, str(ROOT / "helpers/queue_worker.py"), "--once", "--name", "ex", "--plugins", str(EXAMPLES), "--only", only],
                          env=env, capture_output=True, text=True, timeout=300)


def test_the_dark_regions_example_stores_boxes():
    c = client()
    psql("update processing_pluginjob set error_message = 'test cleanup' where error_message is null and processing_complete < 100 and plugin_id in (select id from processing_plugin where plugin_type = 1)")
    assert worker("dark").returncode == 0  # announces it
    plugin = next(p for p in c.get("/api/v2/plugins").json()["items"] if p["package"] == "org.example.dark-regions")
    try:
        job = c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE}).json()
        out = worker("dark")
        assert out.returncode == 0 and "done," in out.stdout, out.stdout + out.stderr
        j = c.get(f"/api/v2/plugin-jobs/{job['id']}").json()
        assert j["processing_complete"] == 100 and not j["error_message"]
    finally:
        remove_plugin(c, plugin["id"])


def test_the_shift_example_registers():
    c = client()
    psql("update processing_pluginjob set error_message = 'test cleanup' where error_message is null and processing_complete < 100 and plugin_id in (select id from processing_plugin where plugin_type = 2)")
    assert worker("shift").returncode == 0
    plugin = next(p for p in c.get("/api/v2/registration-plugins").json()["items"] if p["package"] == "org.example.fixed-shift")
    try:
        r = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT, "plugin": plugin["id"], "shift_x": 250})
        assert r.status_code == 202, r.text
        out = worker("shift")
        assert out.returncode == 0 and "done" in out.stdout, out.stdout + out.stderr
        reg = c.get("/api/v2/registrations", params={"source_image": JSRC, "target_image": JTGT}).json()["items"][0]
        assert reg["transformation_matrix"]["t_02"] == 250.0
    finally:
        for r in c.get("/api/v2/registrations", params={"source_image": JSRC, "target_image": JTGT}).json()["items"]:
            c.delete(f"/api/v2/registrations/{r['id']}")
        remove_plugin(c, plugin["id"])
