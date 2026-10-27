"""/api/v2 read endpoints: Rust only. Checks the five v2 decisions (PLAN.md §2a) and scoping."""
import re

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def client(user="rt_member"):
    c = httpx.Client(base_url=BASE, timeout=30)
    assert c.post("/api/v2/auth/login", json={"username": user, "password": PW}).status_code == 200
    return c


def test_requires_authentication():
    assert httpx.get(BASE + "/api/v2/images").status_code in (401, 403)


def test_unknown_resource_is_404_json():
    r = client().get("/api/v2/nonsense")
    assert r.status_code == 404 and "detail" in r.json()


def test_cursor_pagination_walks_every_item_once_in_id_order():
    c = client("aubreville")
    seen, cursor = [], None
    while True:
        r = c.get("/api/v2/annotations", params={"limit": 7, **({"cursor": cursor} if cursor else {})})
        assert r.status_code == 200
        j = r.json()
        assert set(j) == {"items", "next_cursor"}  # no count unless asked
        seen += [i["id"] for i in j["items"]]
        cursor = j["next_cursor"]
        if not cursor or len(seen) > 60:
            break
    assert seen == sorted(set(seen)) and len(seen) > 7


def test_count_on_request_and_limit_validation():
    c = client("aubreville")
    assert c.get("/api/v2/images", params={"count": "true", "limit": 1}).json()["count"] >= 1
    assert c.get("/api/v2/images", params={"limit": 0}).status_code == 400
    assert c.get("/api/v2/images", params={"limit": 100000}).status_code == 400
    assert c.get("/api/v2/images", params={"cursor": "garbage"}).status_code == 400


def test_timestamps_are_rfc3339_utc():
    c = client("aubreville")
    items = c.get("/api/v2/annotations", params={"limit": 5}).json()["items"]
    assert items
    for i in items:
        assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z", i["last_edit_time"]), i["last_edit_time"]


def test_field_names_are_snake_case():
    c = client("aubreville")
    img = c.get("/api/v2/images", params={"limit": 1}).json()["items"][0]
    assert "objective_power" in img and "frame_descriptions" in img and "default_frame" in img
    assert not [k for k in img if k != k.lower()]
    one = c.get("/api/v2/images", params={"limit": 1, "fields": "id,objective_power"}).json()["items"][0]
    assert set(one) == {"id", "objective_power"}


def test_detail_and_missing():
    c = client("aubreville")
    iid = c.get("/api/v2/images", params={"limit": 1}).json()["items"][0]["id"]
    assert c.get(f"/api/v2/images/{iid}").json()["id"] == iid
    assert c.get("/api/v2/images/999999999").status_code == 404
    assert c.get("/api/v2/images/abc").status_code == 404


def test_processing_data_is_team_scoped():
    out = client("rt_outsider")
    for res in ("plugin-jobs", "plugin-results", "plugin-result-entries", "plugin-result-annotations", "plugin-result-bitmaps"):
        assert out.get(f"/api/v2/{res}").json()["items"] == [], res
    adm = client("aubreville")
    assert adm.get("/api/v2/plugin-results").status_code == 200
    # v1 keeps showing processing data to every authenticated user (compat)
    r = httpx.get(BASE + "/api/v1/processing/pluginresults/", auth=("rt_outsider", PW))
    assert r.status_code == 200


def test_member_sees_only_own_team_images():
    c = client("rt_member")
    out = client("rt_outsider")
    assert c.get("/api/v2/images", params={"limit": 1}).json()["items"]
    assert out.get("/api/v2/images").json()["items"] == []
