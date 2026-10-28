"""Plugins as registration algorithms: announcing, selecting one for a job, the overview for administrators (Rust only)."""
import os
import subprocess
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

JSRC, JTGT = 15, 16
SCHEMA = [
    {"name": "maxFeatures", "type": "int", "default": 512, "min": 32, "max": 4096},
    {"name": "mode", "type": "choice", "choices": ["fast", "careful"], "default": "fast"},
    {"name": "flip", "type": "bool", "default": False},
]


def client(user="aubreville"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def psql(sql):
    subprocess.run([f"{os.environ.get('PGBIN', '/Applications/Postgres.app/Contents/Versions/latest/bin')}/psql", "-h", "127.0.0.1", "-d", os.environ.get("RUST_DB", "exact_rust_test"), "-Atc", sql], capture_output=True)


@pytest.fixture(autouse=True)
def quiet_queue():
    psql("delete from exact_rust_registration_job where source_image_id = 15")
    psql("update exact_rust_registration_job set status = 'failed' where status in ('queued', 'running')")
    yield
    psql("delete from exact_rust_registration_job where source_image_id = 15")


@pytest.fixture
def plugin():
    c = client()
    name = f"reg-{uuid.uuid4().hex[:6]}"
    r = c.post("/api/v2/plugins/register", json={"name": name, "author": "t", "package": "t_pkg", "plugin_type": 2, "parameters_schema": SCHEMA})
    assert r.status_code == 201, r.text
    yield r.json()
    psql(f"delete from exact_rust_registration_job where plugin_id = {r.json()['id']}")
    c.delete(f"/api/v2/plugins/{r.json()['id']}")


def test_announcing_creates_then_updates_and_checks_the_schema(plugin):
    c = client()
    assert plugin["created"] and plugin["plugin_type"] == 2 and plugin["parameters_schema"] == SCHEMA
    # clients of the plugin API (exact-sync, QueueRunner) refuse a plugin without an icon, so one is always set
    assert c.get(f"/api/v1/processing/plugins/{plugin['id']}/").json()["icon"]
    again = c.post("/api/v2/plugins/register", json={"name": plugin["name"], "author": "t", "package": "t_pkg", "plugin_type": 2, "parameters_schema": SCHEMA[:1]})
    assert again.status_code == 200 and again.json()["id"] == plugin["id"] and again.json()["parameters_schema"] == SCHEMA[:1]
    bad = lambda **kw: c.post("/api/v2/plugins/register", json={"name": "x", "plugin_type": 2, **kw}).status_code  # noqa: E731
    assert bad(parameters_schema={"a": 1}) == 400
    assert bad(parameters_schema=[{"name": "a", "type": "weird"}]) == 400
    assert bad(parameters_schema=[{"name": "a", "type": "choice"}]) == 400
    assert bad(plugin_type=7) == 400
    assert client("rt_outsider").post("/api/v2/plugins/register", json={"name": "x"}).status_code == 403


def test_registration_plugins_are_listed_for_the_register_dialog(plugin):
    items = client("rt_member").get("/api/v2/registration-plugins").json()["items"]
    mine = next(p for p in items if p["id"] == plugin["id"])
    assert mine["parameters_schema"] == SCHEMA and all(p["plugin_type"] == 2 for p in items)
    assert sum(1 for p in items if p["default"]) == 1 and items[0]["default"]


def test_a_job_names_its_plugin_and_only_its_parameters(plugin):
    c = client()
    j = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT, "plugin": plugin["id"], "maxFeatures": 100, "mode": "careful", "bogus": 1})
    assert j.status_code == 202, j.text
    job = j.json()
    assert job["plugin"] == plugin["id"] and job["params"] == {"maxFeatures": 100, "mode": "careful"}
    listed = next(x for x in c.get("/api/v2/jobs", params={"kind": "registration", "limit": 500}).json()["items"] if x["id"] == job["id"])
    assert listed["plugin"] == plugin["id"] and listed["plugin_name"] == plugin["name"]
    # a worker that serves other plugins does not get it, one that serves this plugin does
    assert c.post("/api/v2/jobs/claim", json={"worker": "other", "kinds": ["registration"], "plugins": [plugin["id"] + 1000]}).status_code == 204
    got = c.post("/api/v2/jobs/claim", json={"worker": "mine", "kinds": ["registration"], "plugins": [plugin["id"]]})
    assert got.status_code == 200 and got.json()["job"]["id"] == job["id"]
    assert got.json()["job"]["plugin"] == {"id": plugin["id"], "name": plugin["name"], "package": "t_pkg"}
    assert got.json()["job"]["params"] == {"maxFeatures": 100, "mode": "careful"}


def test_refused_plugins(plugin):
    c = client()
    assert c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT, "plugin": 99999}).status_code == 400
    analysis = c.post("/api/v2/plugins/register", json={"name": f"ana-{uuid.uuid4().hex[:6]}", "plugin_type": 1}).json()
    try:
        r = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT, "plugin": analysis["id"]})
        assert r.status_code == 400 and "registration plugin" in r.text
    finally:
        c.delete(f"/api/v2/plugins/{analysis['id']}")


def test_overview_for_administrators(plugin):
    c = client()
    c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT, "plugin": plugin["id"]})
    c.post("/api/v2/jobs/claim", json={"worker": "ov-worker", "kinds": ["registration"], "plugins": [plugin["id"]]})
    ov = c.get("/api/v2/admin/plugins").json()
    mine = next(p for p in ov["items"] if p["id"] == plugin["id"])
    assert mine["plugin_type"] == 2 and mine["jobs"]["running"] == 1 and mine["jobs"]["queued"] == 0 and mine["last_job_at"]
    assert any(w["name"] == "ov-worker" for w in mine["workers"]) and any(w["name"] == "ov-worker" for w in ov["workers"])
    assert {"id", "name", "author", "package", "parameters_schema", "default", "products", "results"} <= mine.keys()
    assert client("rt_member").get("/api/v2/admin/plugins").status_code == 403
