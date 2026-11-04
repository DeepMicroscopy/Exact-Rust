"""The screening mode of a user (Rust only): GET / PUT /api/v2/images/{id}/screening."""
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


def tiles(n):
    return {str(i): {"x_min": i * 10, "y_min": 0, "x_max": i * 10 + 20, "y_max": 20, "Screened": False} for i in range(n)}


def test_a_user_keeps_a_screening_mode_per_image_of_their_own():
    a, b = client("rt_member"), client("rt_teamadmin")
    try:
        ids = [i["id"] for i in a.get("/api/v2/images?limit=50&fields=id").json()["items"]]
        img = ids[-1]
        # a user in the same team (or with access) does not see the other's
        mine = a.put(f"/api/v2/images/{img}/screening", json={"x_resolution": 20, "y_resolution": 20, "x_steps": 4, "y_steps": 1, "screening_tiles": tiles(4), "current_index": 0})
        assert mine.status_code == 200, mine.text
        assert mine.json()["x_steps"] == 4
        # a partial update keeps the rest
        step = a.put(f"/api/v2/images/{img}/screening", json={"current_index": 2}).json()
        assert step["current_index"] == 2 and len(step["screening_tiles"]) == 4 and step["id"] == mine.json()["id"]
        assert a.get(f"/api/v2/images/{img}/screening").json()["current_index"] == 2
        other = b.get(f"/api/v2/images/{img}/screening")
        assert other.status_code in (200, 404)
        if other.status_code == 200:
            assert other.json() is None or other.json()["id"] != mine.json()["id"]
        # outside the windows, and a new mode that is not complete
        assert a.put(f"/api/v2/images/{img}/screening", json={"current_index": 9}).status_code == 400
        assert a.put(f"/api/v2/images/{img}/screening", json={"x_resolution": "wide"}).status_code == 400
    finally:
        a.close()
        b.close()


def test_the_screening_mode_needs_a_login_and_an_image():
    assert httpx.get(BASE + "/api/v2/images/1/screening").status_code in (401, 403)
    c = client("rt_member")
    try:
        assert c.get("/api/v2/images/999999999/screening").status_code == 404
        assert c.put("/api/v2/images/999999999/screening", json={"current_index": 0}).status_code == 404
    finally:
        c.close()
