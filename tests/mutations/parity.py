"""Mutation parity: the same scripted write operations against the reference Django and the Rust server, each on its own
copy of the same database (so generated ids agree), then a comparison of the responses and of the resulting table contents.

Environment: DJANGO_URL (default :8001), RUST_URL (default :8002), DJANGO_DB / RUST_DB (database names), PGBIN.
"""
import json
import os
import re
import subprocess

import httpx

DJANGO_URL = os.environ.get("DJANGO_URL", "http://127.0.0.1:8001").rstrip("/")
RUST_URL = os.environ.get("RUST_URL", "http://127.0.0.1:8002").rstrip("/")
DJANGO_DB = os.environ.get("DJANGO_DB", "exact_django_test")
RUST_DB = os.environ.get("RUST_DB", "exact_rust_test")
PGBIN = os.environ.get("PGBIN", "/Applications/Postgres.app/Contents/Versions/latest/bin")
PW = os.environ.get("EXACT_TEST_PW", "rust-test-pw")

# values that legitimately differ between the two runs
VOLATILE = {"time", "last_edit_time", "unique_identifier", "last_login", "date_joined"}


def normalize(o):
    if isinstance(o, dict):
        return {k: normalize(v) for k, v in sorted(o.items()) if k not in VOLATILE}
    if isinstance(o, list):
        return [normalize(v) for v in o]
    if isinstance(o, str):
        return re.sub(r"https?://[^/]+/", "http://HOST/", o)
    return o


class Side:
    def __init__(self, name, url, db):
        self.name, self.url, self.db = name, url, db
        self.clients = {}
        self.last = {}  # last response body per label, for steps that depend on earlier ids

    def client(self, user):
        """`user` logs in with Basic auth; `session:user` through the login form / v2 login (for @login_required views)."""
        if user not in self.clients:
            if user.startswith("session:"):
                c = httpx.Client(base_url=self.url, timeout=120, follow_redirects=False)
                name = user[8:]
                if self.name == "django":
                    c.get("/user/login/")
                    c.post("/user/login/", data={"username": name, "password": PW, "csrfmiddlewaretoken": c.cookies.get("csrftoken")})
                    c.headers["X-CSRFToken"] = c.cookies.get("csrftoken", "")
                else:
                    j = c.post("/api/v2/auth/login", json={"username": name, "password": PW}).json()
                    c.headers["X-CSRF-Token"] = j["csrf_token"]
                    c.headers["X-CSRFToken"] = j["csrf_token"]
                self.clients[user] = c
            else:
                self.clients[user] = httpx.Client(base_url=self.url, auth=(user, PW), timeout=120, follow_redirects=False)
        return self.clients[user]

    def request(self, user, method, path, json_body=None, params=None):
        r = self.client(user).request(method, path, json=json_body, params=params)
        try:
            body = r.json()
        except Exception:  # noqa: BLE001
            body = {"_non_json_len": len(r.content)}
        return r.status_code, body

    def rows(self, sql):
        """JSON array of the rows of a query, ordered as the query says."""
        out = subprocess.run([f"{PGBIN}/psql", "-h", "127.0.0.1", "-d", self.db, "-Atc", f"select coalesce(json_agg(t), '[]') from ({sql}) t"],
                             capture_output=True, text=True, check=True).stdout.strip()
        return json.loads(out)


def sides():
    return Side("django", DJANGO_URL, DJANGO_DB), Side("rust", RUST_URL, RUST_DB)
