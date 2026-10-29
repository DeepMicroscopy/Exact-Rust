"""The common job queue: registration jobs and plugin (image analysis) jobs in one list, one claim, one set of actions (Rust only)."""
import os
import subprocess
import time
import uuid

import httpx
import pytest
from common import BASE, PW, drop_registration_plugin, registration_plugin

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGE = 2  # plugin jobs
JSRC, JTGT = 15, 16  # registration jobs (same pair as test_v2_registration)


def client(user="aubreville"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def psql(sql):
    subprocess.run([f"{os.environ.get('PGBIN', '/Applications/Postgres.app/Contents/Versions/latest/bin')}/psql", "-h", "127.0.0.1", "-d", os.environ.get("RUST_DB", "exact_rust_test"), "-Atc", sql], capture_output=True)


@pytest.fixture(autouse=True)
def quiet_queue():
    psql("update processing_pluginjob set error_message = 'test cleanup' where error_message is null and processing_complete < 100 and plugin_id in (select id from processing_plugin where plugin_type = 2)")
    registration_plugin(client())
    yield
    psql("delete from processing_pluginjob where image_id = 15 and plugin_id in (select id from processing_plugin where plugin_type = 2)")
    drop_registration_plugin()


@pytest.fixture
def plugin():
    c = client()
    r = c.post("/api/v2/plugins", json={"name": f"jobs-{uuid.uuid4().hex[:6]}", "author": "t"})
    assert r.status_code == 201, r.text
    yield r.json()
    c.delete(f"/api/v2/plugins/{r.json()['id']}")


def plugin_job(c, plugin):
    r = c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE})
    assert r.status_code == 201, r.text
    return r.json()


def registration_job(c):
    r = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT})
    assert r.status_code == 202, r.text
    return r.json()


def listed(c, **q):
    return c.get("/api/v2/jobs", params=q).json()["items"]


def test_both_kinds_are_listed_with_the_same_status_words(plugin):
    c = client()
    pj, rj = plugin_job(c, plugin), registration_job(c)
    jobs = listed(c, limit=500)
    p = next(j for j in jobs if j["kind"] == "plugin" and j["id"] == pj["id"])
    r = next(j for j in jobs if j["kind"] == "registration" and j["id"] == rj["id"])
    assert p["status"] == "queued" and p["plugin_name"] == plugin["name"] and p["progress"] == 0 and p["image"] == IMAGE
    assert p["images"] == [IMAGE]  # a job of one image has no rows in processing_pluginjobimage
    assert r["status"] == "queued" and r["image"] == JSRC and r["images"] == [JSRC, JTGT] and r["progress"] is None
    c.patch(f"/api/v2/plugin-jobs/{pj['id']}", json={"processing_complete": 55, "attached_worker": "w1"})
    p = next(j for j in listed(c, kind="plugin", image=IMAGE, limit=500) if j["id"] == pj["id"])
    assert p["status"] == "running" and p["worker"] == "w1" and abs(p["progress"] - 0.55) < 1e-9
    c.patch(f"/api/v2/plugin-jobs/{pj['id']}", json={"error_message": "boom"})
    assert next(j for j in listed(c, status="failed", limit=500) if j["id"] == pj["id"] and j["kind"] == "plugin")["error"] == "boom"
    assert all(j["kind"] == "registration" for j in listed(c, kind="registration"))
    assert c.get("/api/v2/jobs", params={"kind": "nope"}).status_code == 400
    c.delete(f"/api/v2/plugin-jobs/{pj['id']}")


def test_one_claim_for_both_kinds_oldest_first(plugin):
    c = client()
    pj = plugin_job(c, plugin)
    time.sleep(0.05)
    rj = registration_job(c)
    first = c.post("/api/v2/jobs/claim", json={"worker": "u1", "plugin": plugin["id"]})
    assert first.status_code == 200 and first.json()["kind"] == "plugin" and first.json()["job"]["id"] == pj["id"]
    second = c.post("/api/v2/jobs/claim", json={"worker": "u1", "plugin": plugin["id"]})
    assert second.status_code == 200 and second.json()["kind"] == "registration"
    assert second.json()["job"]["id"] == rj["id"] and second.json()["job"]["source_path"] and second.json()["job"]["target_image"] == JTGT
    assert c.post("/api/v2/jobs/claim", json={"worker": "u1", "plugin": plugin["id"]}).status_code == 204
    workers = c.get("/api/v2/jobs").json()["workers"]
    assert any(w["name"] == "u1" and set(w["kinds"]) == {"registration", "plugin"} and w["seen_seconds_ago"] < 30 for w in workers)
    states = {(j["kind"], j["id"]): j["status"] for j in listed(c, limit=500)}
    assert states[("plugin", pj["id"])] == "running" and states[("registration", rj["id"])] == "running"
    c.delete(f"/api/v2/plugin-jobs/{pj['id']}")


def test_a_worker_asks_only_for_the_kinds_it_can_do(plugin):
    c = client()
    pj, rj = plugin_job(c, plugin), registration_job(c)
    got = c.post("/api/v2/jobs/claim", json={"worker": "reg-only", "kinds": ["registration"]})
    assert got.status_code == 200 and got.json()["kind"] == "registration" and got.json()["job"]["id"] == rj["id"]
    assert c.post("/api/v2/jobs/claim", json={"worker": "reg-only", "kinds": ["registration"]}).status_code == 204
    assert c.post("/api/v2/jobs/claim", json={"worker": "w", "kinds": ["thumbnails"]}).status_code == 400
    assert c.post("/api/v2/jobs/claim", json={"kinds": ["plugin"]}).status_code == 400  # a worker needs a name
    c.delete(f"/api/v2/plugin-jobs/{pj['id']}")


def test_cancel_and_restart(plugin):
    c = client()
    rj = registration_job(c)
    # a failed job can be queued again; a waiting one cannot be restarted
    assert c.post(f"/api/v2/jobs/registration/{rj['id']}/restart").status_code == 409
    claimed = c.post("/api/v2/jobs/claim", json={"worker": "w", "kinds": ["registration"]}).json()["job"]
    c.post(f"/api/v2/registration-jobs/{claimed['id']}/fail", json={"worker": "w", "error": "boom"})
    assert next(j for j in listed(c, kind="registration", limit=500) if j["id"] == rj["id"])["status"] == "failed"
    assert c.post(f"/api/v2/jobs/registration/{rj['id']}/restart").status_code == 204
    again = next(j for j in listed(c, kind="registration", limit=500) if j["id"] == rj["id"])
    assert again["status"] == "queued" and again["error"] is None and again["worker"] is None
    # cancelling removes it; the worker that still reports gets told
    assert c.delete(f"/api/v2/jobs/registration/{rj['id']}").status_code == 204
    assert all(j["id"] != rj["id"] for j in listed(c, kind="registration", limit=500))
    assert c.post("/api/v2/jobs/claim", json={"worker": "w", "kinds": ["registration"]}).status_code == 204
    # plugin jobs: results go with the job
    pj = plugin_job(c, plugin)
    res = c.post("/api/v2/plugin-results", json={"plugin": plugin["id"], "image": IMAGE, "job": pj["id"]}).json()
    assert c.delete(f"/api/v2/jobs/plugin/{pj['id']}").status_code == 204
    assert c.get(f"/api/v2/plugin-results/{res['id']}").status_code == 404 and c.get(f"/api/v2/plugin-jobs/{pj['id']}").status_code == 404
    assert c.delete("/api/v2/jobs/other/1").status_code == 404


def test_visibility_and_permissions(plugin):
    c = client()
    pj, rj = plugin_job(c, plugin), registration_job(c)
    o = client("rt_outsider")
    assert o.get("/api/v2/jobs").json()["items"] == []
    assert o.delete(f"/api/v2/jobs/plugin/{pj['id']}").status_code == 404
    assert o.delete(f"/api/v2/jobs/registration/{rj['id']}").status_code == 404
    assert o.post("/api/v2/jobs/claim", json={"worker": "w"}).status_code == 403  # no right to work on jobs
    m = client("rt_member")  # sees the jobs of the team, but neither created them nor may change jobs
    assert any(j["id"] == pj["id"] for j in listed(m, kind="plugin", limit=500))
    assert m.delete(f"/api/v2/jobs/plugin/{pj['id']}").status_code == 403
    c.delete(f"/api/v2/plugin-jobs/{pj['id']}")


def test_a_job_can_concern_several_images_in_order(plugin):
    c = client("aubreville")
    pj = plugin_job(c, plugin)
    psql(f"insert into processing_pluginjobimage (job_id, image_id, position) values ({pj['id']}, 15, 1), ({pj['id']}, {IMAGE}, 0)")
    p = next(j for j in listed(c, kind="plugin", limit=500) if j["id"] == pj["id"])
    assert p["image"] == IMAGE and p["images"] == [IMAGE, 15]
    assert any(j["id"] == pj["id"] for j in listed(c, kind="plugin", image=15, limit=500))
    c.delete(f"/api/v2/plugin-jobs/{pj['id']}")


def test_a_registration_job_is_a_plugin_job_of_two_images():
    c = client("aubreville")
    rj = registration_job(c)
    row = subprocess.run([f"{os.environ.get('PGBIN', '/Applications/Postgres.app/Contents/Versions/latest/bin')}/psql", "-h", "127.0.0.1", "-d", os.environ.get("RUST_DB", "exact_rust_test"), "-Atc",
                          f"select q.image_id, pl.plugin_type, (select string_agg(ji.image_id::text, ',' order by ji.position) from processing_pluginjobimage ji where ji.job_id = q.id) "
                          f"from processing_pluginjob q join processing_plugin pl on pl.id = q.plugin_id where q.id = {rj['id']}"], capture_output=True, text=True).stdout.strip()
    assert row == f"{JSRC}|2|{JSRC},{JTGT}"
    # asking again for the same pair reuses the open job
    assert registration_job(c)["id"] == rj["id"]
    c.delete(f"/api/v2/jobs/registration/{rj['id']}")
