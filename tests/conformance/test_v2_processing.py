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


# --- file fields -------------------------------------------------------------------------------------------------

def tiny_png(color=(10, 20, 30)):
    import io
    from PIL import Image
    b = io.BytesIO()
    Image.new("RGB", (8, 8), color).save(b, "PNG")
    return b.getvalue()


def test_bitmap_upload_multipart_is_stored_and_served(plugin):
    c = client()
    job = c.post("/api/v2/plugin-jobs", json={"plugin": plugin["id"], "image": IMAGE}).json()
    res = c.post("/api/v2/plugin-results", json={"plugin": plugin["id"], "image": IMAGE, "job": job["id"]}).json()
    entry = c.post("/api/v2/plugin-result-entries", json={"pluginresult": res["id"], "name": "heat"}).json()
    data = tiny_png()
    r = c.post("/api/v2/plugin-result-bitmaps", data={"pluginresultentry": entry["id"], "image": IMAGE, "name": "b", "channels": "3", "location_rect": '{"x": 1, "y": 2, "w": 8, "h": 8}', "scale_max": "2.5"},
               files={"bitmap": ("my map.png", data)})
    assert r.status_code == 201, r.text
    b = r.json()
    assert b["channels"] == 3 and b["scale_max"] == 2.5 and b["location_rect"] == {"x": 1, "y": 2, "w": 8, "h": 8} and b["plugin"] == plugin["id"]
    assert f"/plugins/{plugin['name']}_{plugin['id']}/{IMAGE}/my_map" in b["bitmap"]
    served = httpx.get(b["bitmap"].replace("http://127.0.0.1:8002", BASE))
    assert served.status_code == 200 and served.content == data
    # same name again: never overwritten
    r2 = c.post("/api/v2/plugin-result-bitmaps", data={"pluginresultentry": entry["id"], "image": IMAGE, "name": "b"}, files={"bitmap": ("my map.png", tiny_png((1, 1, 1)))})
    assert r2.status_code == 201 and r2.json()["bitmap"] != b["bitmap"]
    # defaults and the required file
    assert r2.json()["channels"] == 1 and r2.json()["location_rect"] == {"x": 0, "y": 0, "w": 10000, "h": 10000}
    missing = c.post("/api/v2/plugin-result-bitmaps", data={"pluginresultentry": entry["id"], "image": IMAGE, "name": "b"})
    assert missing.status_code == 400 and "bitmap" in missing.json()["errors"]
    c.delete(f"/api/v2/plugin-results/{res['id']}")
    c.delete(f"/api/v2/plugin-jobs/{job['id']}")


def test_plugin_icon_upload_and_v1_multipart(plugin):
    c = client()
    r = c.patch(f"/api/v2/plugins/{plugin['id']}", files={"icon": ("icon.png", tiny_png())})
    assert r.status_code == 200 and r.json()["icon"].endswith(".png") and f"/plugins/{plugin['name']}_{plugin['id']}/icon" in r.json()["icon"]
    v1 = c.post("/api/v1/processing/plugins/", data={"name": f"v1-{uuid.uuid4().hex[:6]}"}, files={"icon": ("i.png", tiny_png())})
    assert v1.status_code == 201 and v1.json()["icon"].startswith("http://")
    c.delete(f"/api/v2/plugins/{v1.json()['id']}")


def test_annotation_media_files_v2_and_legacy():
    c = client("rt_member")
    ann = c.post("/api/v2/annotations", json={"image": IMAGE, "annotation_type": 1, "vector": {"x1": 1, "y1": 1, "x2": 9, "y2": 9}}).json()
    up = c.post(f"/api/v2/annotations/{ann['id']}/media-files", data={"media_file_type": "3"}, files=[("a", ("clip.mp4", b"video-bytes")), ("b", ("note.png", tiny_png()))])
    assert up.status_code == 201 and [m["name"] for m in up.json()] == ["clip.mp4", "note.png"] and up.json()[0]["media_file_type"] == 3
    served = httpx.get(up.json()[0]["file"].replace("http://127.0.0.1:8002", BASE))
    assert served.status_code == 200 and served.content == b"video-bytes"
    again = c.post(f"/api/v2/annotations/{ann['id']}/media-files", files={"a": ("clip.mp4", b"x")})
    assert again.status_code == 201 and again.json() == []  # same name: skipped
    got = c.get(f"/api/v2/annotations/{ann['id']}", params={"expand": "uploaded_media_files"}).json()
    assert len(got["uploaded_media_files"]) == 2
    legacy = c.post(f"/annotations/api/annotation/mediafile/upload/{ann['id']}/2/", files={"f": ("l.png", tiny_png())})
    assert legacy.status_code == 200 and legacy.json()[0]["name"] == "l.png" and legacy.json()[0]["media_file_type"] == 2
    assert c.delete(f"/api/v2/annotation-media-files/{up.json()[0]['id']}").status_code == 204
    assert httpx.get(up.json()[0]["file"].replace("http://127.0.0.1:8002", BASE)).status_code == 404
    assert client("rt_outsider").post(f"/api/v2/annotations/{ann['id']}/media-files", files={"a": ("z.png", b"z")}).status_code == 404
    assert c.post(f"/api/v2/annotations/{ann['id']}/media-files", data={"x": "y"}).status_code == 400
    c.delete(f"/api/v2/annotations/{ann['id']}", params={"hard": "true"})
