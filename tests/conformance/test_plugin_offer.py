"""Plugins whose worker has not been there for a week are not offered (analysis panel, registration list) (Rust only)."""
import os
import subprocess
import uuid

import httpx
import pytest
from common import BASE, PW
from test_example_plugins import remove_plugin

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

PSQL = f"{os.environ.get('PGBIN', '/Applications/Postgres.app/Contents/Versions/latest/bin')}/psql"
IMAGE = 2


def sql(q):
    r = subprocess.run([PSQL, "-h", "127.0.0.1", "-d", os.environ.get("RUST_DB", "exact_rust_test"), "-Atc", q], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip()


def client():
    return httpx.Client(base_url=BASE, auth=("aubreville", PW), timeout=60)


def offered(c):
    return {p["id"] for p in c.get(f"/api/v2/images/{IMAGE}/analysis").json()["plugins"]}


def test_a_plugin_not_seen_for_a_week_is_not_offered():
    c = client()
    name = "stale-" + uuid.uuid4().hex[:6]
    r = c.post("/api/v2/plugins/register", json={"name": name, "package": name, "plugin_type": 1, "parameters_schema": []})
    assert r.status_code in (200, 201), r.text
    pid = r.json()["id"]
    try:
        assert pid in offered(c)  # announcing counts as being there
        sql(f"update exact_rust_plugin_seen set seen_at = now() - interval '8 days' where plugin_id = {pid}")
        assert pid not in offered(c)
        # and it cannot be started either
        assert c.post(f"/api/v2/images/{IMAGE}/analyze", json={"plugin": pid}).status_code in (400, 404)
        sql(f"update exact_rust_plugin_seen set seen_at = now() - interval '6 days' where plugin_id = {pid}")
        assert pid in offered(c)
    finally:
        remove_plugin(c, pid)


def test_registration_list_and_default_follow_the_same_rule():
    c = client()
    name = "stale-reg-" + uuid.uuid4().hex[:6]
    r = c.post("/api/v2/plugins/register", json={"name": name, "package": name, "plugin_type": 2, "parameters_schema": []})
    assert r.status_code in (200, 201), r.text
    pid = r.json()["id"]
    try:
        ids = lambda: [p["id"] for p in c.get("/api/v2/registration-plugins").json()["items"]]  # noqa: E731
        assert pid in ids()
        sql(f"update exact_rust_plugin_seen set seen_at = now() - interval '8 days' where plugin_id = {pid}")
        assert pid not in ids()
    finally:
        remove_plugin(c, pid)
