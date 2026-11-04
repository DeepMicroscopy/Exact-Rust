"""The server log for site admins (Rust only): GET / DELETE /api/v2/admin/log."""
import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def client(user):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def test_only_site_admins_read_the_log():
    m = client("rt_member")
    try:
        assert m.get("/api/v2/admin/log").status_code == 403
        assert m.delete("/api/v2/admin/log").status_code == 403
    finally:
        m.close()
    assert httpx.get(BASE + "/api/v2/admin/log").status_code in (401, 403)


def test_a_slide_that_cannot_be_read_is_in_the_log_with_its_image():
    a = client("aubreville")
    try:
        # an image row that is an NRRD file: the viewer cannot read it (see test_v2_linked)
        items = a.get("/api/v2/images?name__icontains=.nrrd&fields=id,name&limit=5").json()["items"]
        if not items:
            pytest.skip("no unreadable image in this database")
        img = items[0]["id"]
        assert a.get(f"/api/v2/images/{img}/metadata").status_code == 400
        log = a.get("/api/v2/admin/log?q=" + str(img)).json()
        assert log["capacity"] >= 1 and log["since"]
        hit = [e for e in log["items"] if f"image {img}" in e["message"]]
        assert hit and hit[0]["level"] == "WARN", log["items"][:3]
        # the same failure again is counted, not listed twice
        before = hit[0]["count"]
        a.get(f"/api/v2/images/{img}/metadata")
        again = [e for e in a.get("/api/v2/admin/log?q=" + str(img)).json()["items"] if f"image {img}" in e["message"]]
        assert len(again) == len(hit) and again[0]["count"] == before + 1
        assert a.get("/api/v2/admin/log?level=error&q=" + str(img)).json()["total"] == 0  # a warning, not an error
    finally:
        a.close()
