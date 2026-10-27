"""Passkey login/registration against the Rust v2 API. The fixture passkey was enrolled through the real
django-passkeys endpoints (reference/enroll_passkey.py), so these tests also prove that keys enrolled under Django
keep working in Rust."""
import json, pathlib
import httpx
import pytest
from common import BASE, PW
from softkey import SoftKey, b64u

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="Rust server only")
FX = json.loads((pathlib.Path(__file__).resolve().parents[1] / "fixtures" / "passkey.json").read_text())


def fixture_key():
    return SoftKey.from_json(FX)


def begin(c, username=None):
    r = c.post("/api/v2/auth/passkey/begin", json={"username": username} if username else {})
    assert r.status_code == 200
    return r.json()


def finish(c, state, cred):
    return c.post("/api/v2/auth/passkey/finish", json={"state": state, "credential": cred})


def pw_login(user, pw=PW):
    c = httpx.Client(base_url=BASE, timeout=30)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": pw})
    assert r.status_code == 200
    return c, {"X-CSRF-Token": r.json()["csrf_token"]}


def test_django_enrolled_passkey_logs_in_usernameless():
    c = httpx.Client(base_url=BASE, timeout=30)
    b = begin(c)
    assert b["publicKey"]["rpId"] == "localhost" and b["publicKey"]["allowCredentials"] == []
    r = finish(c, b["state"], fixture_key().get(b["publicKey"]))
    assert r.status_code == 200 and r.json()["user"]["username"] == "rt_member"
    assert "HttpOnly" in r.headers["set-cookie"]
    assert c.get("/api/v2/auth/me").json()["username"] == "rt_member"
    assert c.get("/api/v1/users/users/").status_code == 200


def test_login_with_username_lists_only_that_users_keys_and_unknown_user_looks_the_same():
    c = httpx.Client(base_url=BASE, timeout=30)
    known = begin(c, "rt_member")["publicKey"]["allowCredentials"]
    assert [k["id"] for k in known] == [FX["credential_id"]]
    unknown = begin(c, "no-such-user")["publicKey"]
    assert unknown["allowCredentials"] == [] and set(unknown) == set(begin(c, "rt_member")["publicKey"])


def test_challenge_is_single_use():
    c = httpx.Client(base_url=BASE, timeout=30)
    b = begin(c)
    cred = fixture_key().get(b["publicKey"])
    assert finish(c, b["state"], cred).status_code == 200
    assert finish(c, b["state"], cred).status_code == 401


@pytest.mark.parametrize("what", ["wrong-challenge", "evil-origin", "wrong-rp", "no-user-presence", "bad-signature", "unknown-credential", "bogus-state"])
def test_bad_assertions_are_rejected_uniformly(what):
    c = httpx.Client(base_url=BASE, timeout=30)
    b = begin(c)
    k, opts, state = fixture_key(), b["publicKey"], b["state"]
    cred = {
        "wrong-challenge": lambda: k.get(opts, challenge_override=b64u(b"another challenge value 1234567890123")),
        "evil-origin": lambda: k.get(opts, origin_override="https://evil.example"),
        "wrong-rp": lambda: k.get(opts, rp_id="example.org"),
        "no-user-presence": lambda: k.get(opts, flags=0x00),
        "bad-signature": lambda: (lambda x: x["response"].update(signature=b64u(b"\x30\x06\x02\x01\x01\x02\x01\x01")) or x)(k.get(opts)),
        "unknown-credential": lambda: SoftKey(k.rp_id, k.origin).get(opts),
        "bogus-state": lambda: k.get(opts),
    }[what]()
    r = finish(c, "bogus" if what == "bogus-state" else state, cred)
    assert r.status_code == 401 and r.json() == {"detail": "Passkey login failed."}


def test_register_use_and_delete_a_new_passkey_with_csrf():
    c, h = pw_login("rt_teamadmin")
    # needs a session and the CSRF header
    assert httpx.post(BASE + "/api/v2/auth/passkeys/register/begin", auth=("rt_teamadmin", PW)).status_code == 403
    assert c.post("/api/v2/auth/passkeys/register/begin").status_code == 403
    b = c.post("/api/v2/auth/passkeys/register/begin", headers=h).json()
    pk = b["publicKey"]
    assert pk["rp"]["id"] == "localhost" and pk["attestation"] == "none" and pk["excludeCredentials"] == []
    key = SoftKey("localhost", "https://localhost.localhost")  # new key, other (valid) origin
    r = c.post("/api/v2/auth/passkeys/register/finish", headers=h, json={"state": b["state"], "name": "laptop", "credential": key.create(pk)})
    assert r.status_code == 201, r.text
    kid = r.json()["id"]
    assert r.json()["name"] == "laptop" and r.json()["enabled"] is True
    assert [k["name"] for k in c.get("/api/v2/auth/passkeys").json()] == ["laptop"]
    # the challenge is single use
    assert c.post("/api/v2/auth/passkeys/register/finish", headers=h, json={"state": b["state"], "credential": key.create(pk)}).status_code == 400
    # log in with it from a fresh client
    c2 = httpx.Client(base_url=BASE, timeout=30)
    b2 = begin(c2)
    ok = finish(c2, b2["state"], key.get(b2["publicKey"]))
    assert ok.status_code == 200 and ok.json()["user"]["username"] == "rt_teamadmin"
    # disable -> rejected, enable -> works, delete -> rejected
    assert c.patch(f"/api/v2/auth/passkeys/{kid}", headers=h, json={"enabled": False}).json()["enabled"] is False
    b3 = begin(c2)
    assert finish(c2, b3["state"], key.get(b3["publicKey"])).status_code == 401
    assert c.patch(f"/api/v2/auth/passkeys/{kid}", headers=h, json={"enabled": True, "name": "renamed"}).json()["name"] == "renamed"
    b4 = begin(c2)
    assert finish(c2, b4["state"], key.get(b4["publicKey"])).status_code == 200
    assert c.delete(f"/api/v2/auth/passkeys/{kid}", headers=h).status_code == 204
    b5 = begin(c2)
    assert finish(c2, b5["state"], key.get(b5["publicKey"])).status_code == 401
    assert c.delete(f"/api/v2/auth/passkeys/{kid}", headers=h).status_code == 404


def test_registration_rejects_bad_attestations():
    c, h = pw_login("rt_perm")
    b = c.post("/api/v2/auth/passkeys/register/begin", headers=h).json()
    key = SoftKey("example.org", "https://example.org")  # wrong relying party
    r = c.post("/api/v2/auth/passkeys/register/finish", headers=h, json={"state": b["state"], "credential": key.create(b["publicKey"])})
    assert r.status_code == 400
    assert c.get("/api/v2/auth/passkeys").json() == []


def test_users_cannot_touch_each_others_passkeys():
    c, h = pw_login("rt_outsider")
    assert c.get("/api/v2/auth/passkeys").json() == []
    kid = httpx.get(BASE + "/api/v2/auth/passkeys", auth=("rt_member", PW)).json()[0]["id"]
    assert c.delete(f"/api/v2/auth/passkeys/{kid}", headers=h).status_code == 404
    assert c.patch(f"/api/v2/auth/passkeys/{kid}", headers=h, json={"enabled": False}).status_code == 404
