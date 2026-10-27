"""Enroll a software passkey for `rt_member` through the *real* django-passkeys endpoints of the scratch Django
(http://localhost:8001), then save the fixture (private key + stored row) for tests and for `seed_test_users`.

Usage: reference/.venv/bin/python reference/enroll_passkey.py   (Django must be running; DB = exact_rust_test)
"""
import json, pathlib, sys
import httpx

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests" / "conformance"))
from softkey import SoftKey

BASE = "http://localhost:8001"
c = httpx.Client(base_url=BASE, follow_redirects=True)
c.get("/auth/login/")
c.post("/auth/login/", data={"username": "rt_member", "password": "rust-test-pw", "csrfmiddlewaretoken": c.cookies["csrftoken"]}, headers={"Referer": BASE})
assert "sessionid" in c.cookies, "login failed"

key = SoftKey("localhost", BASE)
opts = c.get("/passkeys/reg/begin").json()["publicKey"]
cred = key.create(opts)
r = c.post("/passkeys/reg/complete", json={**cred, "key_name": "software test key"})
assert r.json().get("status") == "OK", r.text

# read back what django-passkeys stored (via the DB, the source of truth)
import psycopg2
db = psycopg2.connect(host="127.0.0.1", dbname="exact_rust_test", user="exact", password="exact")
cur = db.cursor()
cur.execute("select id, name, platform, credential_id, token, enabled from passkeys_userpasskey where credential_id = %s", (cred["id"],))
row = cur.fetchone()
fixture = {**key.to_json(), "username": "rt_member", "row": {"name": row[1], "platform": row[2], "credential_id": row[3], "token": row[4], "enabled": row[5]}}
out = pathlib.Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "passkey.json"
out.write_text(json.dumps(fixture, indent=1))
print("enrolled; token length", len(row[4]), "->", out)
