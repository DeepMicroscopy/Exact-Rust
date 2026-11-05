"""Accounts, passwords and tokens are shared through the database: whoever changes one, the other server must follow."""
import pytest

from coex import BOTH, PW, delete_user, django, execute, rust, sql, unique

SEEDED = ["aubreville", "brummel", "rt_teamadmin", "rt_member", "rt_outsider"]


@pytest.fixture
def account():
    """A new account made by the Rust server (the way the beta will make them): (username, first password)."""
    name = unique("coex-user")
    r = rust.session("aubreville").post("/api/v2/admin/users", json={"username": name, "email": f"{name}@example.org"})
    assert r.status_code in (200, 201), r.text
    pw = r.json().get("password") or r.json().get("initial_password")
    assert pw, r.json()
    yield name, pw
    delete_user(name)


def test_every_account_of_django_logs_in_on_rust_and_the_other_way():
    for u in SEEDED:
        for s in BOTH:
            c = s.login(u)
            assert c.logged_in, f"{u} cannot log in on {s.name}"
        assert rust.basic(u).get("/api/v1/users/users/").status_code == 200
        assert django.basic(u).get("/api/v1/users/users/").status_code == 200


def test_a_wrong_password_and_an_inactive_account_are_refused_by_both():
    for s in BOTH:
        assert not s.login("rt_member", "not-the-password").logged_in, s.name
    execute("update users_user set is_active = false where username = 'rt_outsider'")
    try:
        for s in BOTH:
            assert not s.login("rt_outsider").logged_in, f"{s.name} let an inactive account in"
            assert s.basic("rt_outsider").get("/api/v1/users/users/").status_code in (401, 403), s.name
    finally:
        execute("update users_user set is_active = true where username = 'rt_outsider'")


def test_an_account_made_by_rust_works_on_django_with_a_hash_django_accepts(account):
    name, pw = account
    assert django.login(name, pw).logged_in
    assert rust.login(name, pw).logged_in
    h = sql(f"select password from users_user where username = '{name}'")[0]["password"]
    assert h.startswith("pbkdf2_sha256$"), h[:20]


def test_a_password_changed_on_django_is_the_one_rust_checks(account):
    name, pw = account
    c = django.session(name, pw)
    new = "A-new-Django-pw-7391!"
    r = c.post("/user/password_change/", data={"old_password": pw, "new_password1": new, "new_password2": new, "csrfmiddlewaretoken": c.cookies.get("csrftoken")})
    assert r.status_code in (301, 302), r.text[:300]
    assert rust.login(name, new).logged_in, "Rust does not accept the password set on Django"
    assert not rust.login(name, pw).logged_in, "Rust still accepts the old password"
    assert django.login(name, new).logged_in


def test_a_password_changed_on_rust_is_the_one_django_checks(account):
    name, pw = account
    c = rust.session(name, pw)
    new = "A-new-Rust-pw-4852!"
    r = c.post("/api/v2/me/password", json={"current_password": pw, "new_password": new})
    assert r.status_code in (200, 204), r.text
    assert django.login(name, new).logged_in, "Django does not accept the password set on Rust"
    assert not django.login(name, pw).logged_in, "Django still accepts the old password"
    h = sql(f"select password from users_user where username = '{name}'")[0]["password"]
    assert h.startswith("pbkdf2_sha256$")


def _token(server, user, **body):
    r = server.session(user).post("/users/api/tokens/", json={"name": unique("coex-token"), **body})
    assert r.status_code == 201, f"{server.name}: {r.status_code} {r.text[:200]}"
    return r.json()["token"], r.json()["id"]


def _get(server, token):
    import httpx

    return httpx.get(server.url + "/api/v1/users/users/", headers={"Authorization": f"Bearer {token}"}, timeout=60).status_code


def test_a_personal_access_token_made_on_django_works_on_both_and_a_revoked_one_on_neither():
    token, tid = _token(django, "rt_member")
    try:
        for s in BOTH:
            assert _get(s, token) == 200, f"{s.name} refuses a token made by Django"
        assert django.session("rt_member").post(f"/users/api/tokens/{tid}/revoke/").status_code == 200
        for s in BOTH:
            assert _get(s, token) in (401, 403), f"{s.name} still accepts a revoked token"
    finally:
        execute(f"delete from users_personalaccesstoken where id = {tid}")


def test_an_expired_token_is_refused_by_both_and_the_token_of_an_inactive_user_by_rust():
    token, tid = _token(django, "rt_member")
    try:
        execute(f"update users_personalaccesstoken set expires_at = now() - interval '1 minute' where id = {tid}")
        for s in BOTH:
            assert _get(s, token) in (401, 403), f"{s.name} accepts an expired token"
        execute(f"update users_personalaccesstoken set expires_at = null where id = {tid}")
        execute("update users_user set is_active = false where username = 'rt_member'")
        # a known difference: Django still accepts the token of a deactivated user (Rust refuses it, on purpose); nothing to fix on our side
        assert _get(rust, token) in (401, 403), "Rust accepts the token of an inactive user"
    finally:
        execute("update users_user set is_active = true where username = 'rt_member'")
        execute(f"delete from users_personalaccesstoken where id = {tid}")


def test_a_read_only_token_of_django_cannot_write_on_either_server():
    import httpx

    token, tid = _token(django, "rt_member", read_only=True)
    try:
        for s in BOTH:
            r = httpx.post(s.url + "/api/v1/annotations/annotations/", json={"image": 2, "annotation_type": 1, "vector": {"x1": 1, "y1": 2, "x2": 30, "y2": 40}}, headers={"Authorization": f"Bearer {token}"}, timeout=60)
            assert r.status_code in (401, 403), f"{s.name} let a read-only token write: {r.status_code}"
    finally:
        execute(f"delete from users_personalaccesstoken where id = {tid}")


@pytest.mark.xfail(reason="known gap: the Rust server validates personal access tokens but has no endpoint (or page) to create or revoke them; until it has, they are made in Django's UI", strict=True)
def test_a_personal_access_token_can_be_made_on_rust():
    _token(rust, "rt_member")
