"""Teams, memberships and user administration (v2). Rust only."""
import os
import subprocess
import uuid

import httpx
import pytest
from common import BASE, PW

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

PGBIN = os.environ.get("PGBIN", "/Applications/Postgres.app/Contents/Versions/latest/bin")
DB = os.environ.get("RUST_DB", "exact_rust_test")


def sql(q):
    return subprocess.run([f"{PGBIN}/psql", "-h", "127.0.0.1", "-d", DB, "-Atc", q], capture_output=True, text=True, check=True).stdout.strip()


def client(user="rt_teamadmin", pw=PW):
    c = httpx.Client(base_url=BASE, timeout=60)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200, r.text
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def make_user(prefix="tmp"):
    name = f"{prefix}-{uuid.uuid4().hex[:8]}"
    uid = int(sql(f"insert into users_user (password, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined, points) values ('!', false, '{name}', '', '', '', false, true, now(), 0) returning id").split("\n")[0])
    sql(f"insert into users_userpreferences (frontend, user_id, is_site_admin) values (3, {uid}, false)")
    return uid, name


@pytest.fixture
def team():
    c = client("rt_member")
    t = c.post("/api/v2/teams", json={"name": f"team-{uuid.uuid4().hex[:8]}"}).json()
    yield c, t
    client("aubreville").delete(f"/api/v2/teams/{t['id']}")


def test_create_team_makes_creator_admin_and_validates():
    c = client("rt_member")
    name = f"team-{uuid.uuid4().hex[:8]}"
    r = c.post("/api/v2/teams", json={"name": name, "website": "https://x.org"})
    assert r.status_code == 201 and r.json()["name"] == name
    tid = r.json()["id"]
    assert sql(f"select website from users_team where id={tid}") == "https://x.org"
    assert sql(f"select is_admin from users_teammembership where team_id={tid} and user_id=(select id from users_user where username='rt_member')") == "t"
    assert c.post("/api/v2/teams", json={"name": name}).status_code == 400  # unique
    assert c.post("/api/v2/teams", json={"name": "ab"}).status_code == 400  # 3..30 characters
    assert c.post("/api/v2/teams", json={}).status_code == 400
    client("aubreville").delete(f"/api/v2/teams/{tid}")


def test_patch_team_only_for_admins(team):
    c, t = team
    assert c.patch(f"/api/v2/teams/{t['id']}", json={"website": "w"}).status_code == 200
    assert sql(f"select website from users_team where id={t['id']}") == "w"
    uid, name = make_user()
    c.put(f"/api/v2/teams/{t['id']}/members/{uid}", json={})
    assert client("rt_outsider").patch(f"/api/v2/teams/{t['id']}", json={"name": "zzz-zzz"}).status_code == 404
    taken = c.patch(f"/api/v2/teams/{t['id']}", json={"name": "My Team 1"})
    assert taken.status_code == 400


def test_members_add_promote_demote_and_leave(team):
    c, t = team
    uid, _ = make_user()
    r = c.put(f"/api/v2/teams/{t['id']}/members/{uid}", json={})
    assert r.status_code == 201 and r.json()["is_admin"] is False
    assert c.put(f"/api/v2/teams/{t['id']}/members/{uid}", json={"is_admin": True}).json() == {"team": t["id"], "user": uid, "is_admin": True}
    me = int(sql("select id from users_user where username='rt_member'"))
    assert c.put(f"/api/v2/teams/{t['id']}/members/{me}", json={"is_admin": False}).status_code == 400  # not your own
    assert c.put(f"/api/v2/teams/{t['id']}/members/99999", json={}).status_code == 404
    assert client("rt_outsider").put(f"/api/v2/teams/{t['id']}/members/{uid}", json={}).status_code == 404
    assert c.delete(f"/api/v2/teams/{t['id']}/members/{uid}").status_code == 204  # kicked by an admin
    assert c.delete(f"/api/v2/teams/{t['id']}/members/{uid}").status_code == 404


def test_last_member_leaving_ends_the_team_and_releases_its_sets():
    c = client("rt_member")
    t = c.post("/api/v2/teams", json={"name": f"team-{uuid.uuid4().hex[:8]}"}).json()
    s = c.post("/api/v2/image-sets", json={"name": "s", "team": t["id"]}).json()
    me = int(sql("select id from users_user where username='rt_member'"))
    assert c.delete(f"/api/v2/teams/{t['id']}/members/{me}").status_code == 204
    assert sql(f"select count(*) from users_team where id={t['id']}") == "0"
    assert sql(f"select public::text||','||image_lock::text||','||coalesce(team_id::text,'null') from images_imageset where id={s['id']}") == "true,true,null"
    client("aubreville").delete(f"/api/v2/image-sets/{s['id']}")


def test_delete_team_by_admin_or_superuser():
    c = client("rt_member")
    t = c.post("/api/v2/teams", json={"name": f"team-{uuid.uuid4().hex[:8]}"}).json()
    assert client("rt_outsider").delete(f"/api/v2/teams/{t['id']}").status_code == 404
    assert c.delete(f"/api/v2/teams/{t['id']}").status_code == 204
    t2 = c.post("/api/v2/teams", json={"name": f"team-{uuid.uuid4().hex[:8]}"}).json()
    assert client("aubreville").delete(f"/api/v2/teams/{t2['id']}").status_code == 204


def test_user_patch_rules():
    uid, name = make_user()
    staff = client("aubreville")
    r = staff.patch(f"/api/v2/users/{uid}", json={"first_name": " Ada ", "email": "ada@example.org", "frontend": 2})
    assert r.status_code == 200 and r.json()["username"] == name
    assert sql(f"select first_name||'|'||email from users_user where id={uid}") == "Ada|ada@example.org"
    assert sql(f"select frontend from users_userpreferences where user_id={uid}") == "2"
    assert staff.patch(f"/api/v2/users/{uid}", json={"email": "nope"}).status_code == 400
    assert staff.patch(f"/api/v2/users/{uid}", json={"username": "aubreville"}).status_code == 400
    assert staff.patch(f"/api/v2/users/{uid}", json={"is_active": False}).json()["is_active"] is False
    assert staff.patch(f"/api/v2/users/{uid}", json={"is_staff": True}).json()["is_staff"] is True
    me = int(sql("select id from users_user where username='aubreville'"))
    assert staff.patch(f"/api/v2/users/{me}", json={"is_active": False}).status_code == 400  # not yourself
    assert client("rt_member").patch(f"/api/v2/users/{uid}", json={"first_name": "x"}).status_code == 403  # not staff


def test_random_password_and_delete_user_clear_references():
    uid, name = make_user()
    admin = client("aubreville")
    sql("update users_userpreferences set is_site_admin = true where user_id = (select id from users_user where username='aubreville')")
    pw = admin.post(f"/api/v2/users/{uid}/random-password").json()["password"]
    assert len(pw) >= 20
    assert client(name, pw).get("/api/v2/auth/me").json()["username"] == name  # the new password works
    # a row created by the user keeps existing after the user is gone
    sql(f"update images_imageset set creator_id = {uid} where id = (select min(id) from images_imageset)")
    sid = sql("select min(id) from images_imageset")
    assert admin.delete(f"/api/v2/users/{uid}").status_code == 204
    assert sql(f"select count(*) from users_user where id={uid}") == "0"
    assert sql(f"select coalesce(creator_id::text,'null') from images_imageset where id={sid}") == "null"
    assert sql(f"select count(*) from users_userpreferences where user_id={uid}") == "0"
    me = int(sql("select id from users_user where username='aubreville'"))
    assert admin.delete(f"/api/v2/users/{me}").status_code == 400
    assert admin.post(f"/api/v2/users/{me}/random-password").status_code == 400


def test_user_admin_needs_site_admin():
    uid, _ = make_user()
    assert client("rt_teamadmin").delete(f"/api/v2/users/{uid}").status_code == 403
    assert client("rt_teamadmin").post(f"/api/v2/users/{uid}/random-password").status_code == 403
    sql(f"delete from users_userpreferences where user_id={uid}")
    sql(f"delete from users_user where id={uid}")


def test_admin_me_tells_what_the_screens_may_offer():
    root = client("aubreville")
    me = root.get("/api/v2/admin/me").json()
    assert me["is_site_admin"] is True and isinstance(me["admin_team_ids"], list)
    ta = client("rt_teamadmin").get("/api/v2/admin/me").json()
    assert ta["is_site_admin"] is False and 1 in ta["admin_team_ids"]
    m = client("rt_member").get("/api/v2/admin/me").json()
    assert m["is_site_admin"] is False and m["admin_team_ids"] == []
    assert httpx.get(BASE + "/api/v2/admin/me").status_code in (401, 403)


def test_admin_me_lists_the_model_permissions_for_products_and_types():
    root = client("aubreville")
    perms = root.get("/api/v2/admin/me").json()["perms"]
    assert perms["add_product"] and perms["delete_annotationtype"]
    m = client("rt_member").get("/api/v2/admin/me").json()["perms"]
    assert not any(m.values())


def test_product_types_for_the_admin_screen_carry_active_and_usage():
    root = client("aubreville")
    types = root.get("/api/v2/products/1/annotation-types").json()["items"]
    assert types and {"active", "annotation_count", "vector_type", "color_code"} <= types[0].keys()
    assert client("rt_outsider").get("/api/v2/products/1/annotation-types").status_code == 404
