"""Generic REST writes (processing resources etc.) in v1 and v2, and the atomic job claim. Rust only."""
import concurrent.futures
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGE = 2


def client(user="aubreville"):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


@pytest.fixture
def plugin():
    c = client()
    r = c.post("/api/v2/plugins", json={"name": f"pl-{uuid.uuid4().hex[:6]}", "author": "t"})
    assert r.status_code == 201, r.text
    yield r.json()
    c.delete(f"/api/v2/plugins/{r.json()['id']}")


def test_v2_plugin_job_lifecycle(plugin):
    c = client()
    j = c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE})
    assert j.status_code == 201, j.text
    job = j.json()
    assert job["processing_complete"] == 0 and job["attached_worker"] is None and job["created_time"].endswith("Z") or "+00:00" in job["created_time"]
    p = c.patch(f"/api/v2/plugin-jobs/{job['id']}", json={"processing_complete": 55.5, "attached_worker": "w1"})
    assert p.status_code == 200 and p.json()["processing_complete"] == 55.5 and p.json()["attached_worker"] == "w1"
    assert c.delete(f"/api/v2/plugin-jobs/{job['id']}").status_code == 204
    assert c.get(f"/api/v2/plugin-jobs/{job['id']}").status_code == 404


def test_results_entries_and_annotations_chain(plugin):
    c = client()
    job = c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE}).json()
    res = c.post("/api/v2/plugin-results", json={"plugin": plugin["id"], "image": IMAGE, "job": job["id"]})
    assert res.status_code == 201 and res.json()["job"] == job["id"]
    entry = c.post("/api/v2/plugin-result-entries", json={"pluginresult": res.json()["id"], "name": "heat"})
    assert entry.status_code == 201 and entry.json()["visible"] is True
    ann = c.post("/api/v2/plugin-result-annotations", json={
        "annotation_type": 1, "image": IMAGE, "pluginresultentry": entry.json()["id"], "vector": {"x1": 1, "y1": 1, "x2": 5, "y2": 5}, "score": 0.9})
    assert ann.status_code == 201 and ann.json()["score"] == 0.9 and ann.json()["generated"] is True
    # deleting the result removes its entries and annotations; the job stays, without result
    assert c.delete(f"/api/v2/plugin-results/{res.json()['id']}").status_code == 204
    assert c.get(f"/api/v2/plugin-result-annotations/{ann.json()['id']}").status_code == 404
    assert c.get(f"/api/v2/plugin-jobs/{job['id']}").status_code == 200
    c.delete(f"/api/v2/plugin-jobs/{job['id']}")


def test_validation_and_permissions(plugin):
    c = client()
    r = c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"]})
    assert r.status_code == 400 and "image" in r.json()["errors"]
    r = c.post("/api/v2/plugin-jobs", json={"plugin": 99999, "image": IMAGE, "processing_complete": "x"})
    assert r.status_code == 400 and {"plugin", "processing_complete"} <= set(r.json()["errors"])
    assert client("rt_outsider").post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE}).status_code == 403
    assert c.post("/api/v2/users", json={"username": "x"}).status_code == 405  # not a writable resource


def test_v1_rest_write_with_drf_errors(plugin):
    c = client()
    r = c.post("/api/v1/processing/pluginjobs/", json={"plugin": plugin["id"], "image": IMAGE})
    assert r.status_code == 201, r.text
    jid = r.json()["id"]
    assert c.patch(f"/api/v1/processing/pluginjobs/{jid}/", json={"error_message": "boom"}).json()["error_message"] == "boom"
    bad = c.post("/api/v1/processing/pluginjobs/", json={"plugin": plugin["id"]})
    assert bad.status_code == 400 and bad.json() == {"image": ["This field is required."]}
    assert c.delete(f"/api/v1/processing/pluginjobs/{jid}/").status_code == 204


def test_claim_hands_every_job_to_exactly_one_worker(plugin):
    c = client()
    ids = [c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE}).json()["id"] for _ in range(6)]

    def take(i):
        w = client()
        r = w.post("/api/v2/plugin-jobs/claim", json={"worker": f"w{i}", "plugin": plugin["id"]})
        return r.status_code, (r.json()["id"] if r.status_code == 200 else None)

    with concurrent.futures.ThreadPoolExecutor(10) as ex:
        out = list(ex.map(take, range(10)))
    got = sorted(i for s, i in out if s == 200)
    assert got == sorted(ids) and [s for s, _ in out].count(204) == 4
    for i in ids:
        c.delete(f"/api/v2/plugin-jobs/{i}")


def test_claim_skips_finished_and_failed_jobs(plugin):
    c = client()
    done = c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE, "processing_complete": 100}).json()["id"]
    failed = c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE, "error_message": "x"}).json()["id"]
    assert c.post("/api/v2/plugin-jobs/claim", json={"worker": "w", "plugin": plugin["id"]}).status_code == 204
    assert c.post("/api/v2/plugin-jobs/claim", json={}).status_code == 400
    for i in (done, failed):
        c.delete(f"/api/v2/plugin-jobs/{i}")


def test_other_generic_resources():
    c = client()
    t = c.post("/api/v2/set-tags", json={"name": f"gen{uuid.uuid4().hex[:6]}"})
    assert t.status_code == 201  # a tag without image sets is outside every team's scope, so it cannot be read back
    assert c.patch(f"/api/v2/set-tags/{t.json()['id']}", json={"name": "x"}).status_code == 404
    reg = c.post("/api/v2/registrations", json={"source_image": IMAGE, "target_image": 6, "registration_error": 1.5, "transformation_matrix": [[1, 0, 0], [0, 1, 0]]})
    assert reg.status_code == 201 and reg.json()["registration_error"] == 1.5
    assert c.delete(f"/api/v2/registrations/{reg.json()['id']}").status_code == 204
