"""Personal settings of the account (Rust only): GET / PUT /api/v2/me/preferences."""
import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def client(user):
    c = httpx.Client(base_url=BASE, timeout=30)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def test_the_old_navigation_is_off_until_a_user_turns_it_on_and_belongs_to_that_user():
    a, b = client("rt_member"), client("rt_teamadmin")
    try:
        assert a.get("/api/v2/me/preferences").json() == {"legacy_navigation": False, "auto_overlay": False, "overlay_opacity": 50, "zoom_slider": False, "zoom_step": "low", "allow_outside": False}
        assert a.put("/api/v2/me/preferences", json={"legacy_navigation": True}).json() == {"legacy_navigation": True, "auto_overlay": False, "overlay_opacity": 50, "zoom_slider": False, "zoom_step": "low", "allow_outside": False}
        assert a.get("/api/v2/me/preferences").json()["legacy_navigation"] is True
        assert b.get("/api/v2/me/preferences").json()["legacy_navigation"] is False
    finally:
        a.put("/api/v2/me/preferences", json={"legacy_navigation": False})
    assert a.get("/api/v2/me/preferences").json()["legacy_navigation"] is False


def test_unknown_keys_and_wrong_types_are_refused_and_anonymous_is_not_let_in():
    c = client("rt_member")
    assert c.put("/api/v2/me/preferences", json={"nope": 1}).status_code == 400
    assert c.put("/api/v2/me/preferences", json={"legacy_navigation": "yes"}).status_code == 400
    assert c.put("/api/v2/me/preferences", json=[1]).status_code == 400
    assert httpx.get(BASE + "/api/v2/me/preferences").status_code in (401, 403)


def test_the_overlay_opacity_is_a_whole_percent_and_kept():
    c = client("rt_member")
    try:
        assert c.put("/api/v2/me/preferences", json={"overlay_opacity": 30}).json()["overlay_opacity"] == 30
        assert c.get("/api/v2/me/preferences").json()["overlay_opacity"] == 30
        for bad in (101, -1, 2.5, "50"):
            assert c.put("/api/v2/me/preferences", json={"overlay_opacity": bad}).status_code == 400
        assert c.get("/api/v2/me/preferences").json()["overlay_opacity"] == 30
    finally:
        c.put("/api/v2/me/preferences", json={"overlay_opacity": 50, "zoom_slider": False, "zoom_step": "low", "allow_outside": False})


def test_the_zoom_slider_is_off_and_the_zoom_step_is_low_until_a_user_changes_them():
    c = client("rt_member")
    try:
        assert c.put("/api/v2/me/preferences", json={"zoom_slider": True, "zoom_step": "high"}).json()["zoom_step"] == "high"
        got = c.get("/api/v2/me/preferences").json()
        assert got["zoom_slider"] is True and got["zoom_step"] == "high"
        for bad in ({"zoom_step": "huge"}, {"zoom_step": 2}, {"zoom_slider": "yes"}):
            assert c.put("/api/v2/me/preferences", json=bad).status_code == 400
        assert c.get("/api/v2/me/preferences").json()["zoom_step"] == "high"
        for step in ("medium", "low"):
            assert c.put("/api/v2/me/preferences", json={"zoom_step": step}).json()["zoom_step"] == step
    finally:
        c.put("/api/v2/me/preferences", json={"zoom_slider": False, "zoom_step": "low", "allow_outside": False})
