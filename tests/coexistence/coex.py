"""Helpers for the coexistence suite: the unmodified Django EXACT and the Rust server on ONE database and ONE image store.

Environment (set by scripts/coexistence.sh): DJANGO_URL, RUST_URL, COEX_DB (shared database), COEX_PRISTINE_DB (restored the same way,
never migrated by the Rust tools), IMAGE_PATH, MEDIA_ROOT, PGBIN.
"""
import json
import os
import subprocess
import uuid

import httpx

DJANGO_URL = os.environ.get("DJANGO_URL", "http://127.0.0.1:8001").rstrip("/")
RUST_URL = os.environ.get("RUST_URL", "http://127.0.0.1:18002").rstrip("/")
DB = os.environ.get("COEX_DB", "exact_coexist")
PRISTINE = os.environ.get("COEX_PRISTINE_DB", "exact_coexist_pristine")
IMAGE_PATH = os.environ.get("IMAGE_PATH", "")
MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "")
PGBIN = os.environ.get("PGBIN", "/Applications/Postgres.app/Contents/Versions/16/bin")
PW = os.environ.get("EXACT_TEST_PW", "rust-test-pw")


def sql(query, db=DB):
    """Rows of a query as a list of dicts."""
    r = subprocess.run([f"{PGBIN}/psql", "-h", "127.0.0.1", "-U", "exact", "-d", db, "-Atc", f"select coalesce(json_agg(q_), '[]') from ({query}) q_"],
                       capture_output=True, text=True)
    assert r.returncode == 0, f"psql {db}: {r.stderr.strip()}\n{query}"
    return json.loads(r.stdout.strip())


def execute(statement, db=DB):
    r = subprocess.run([f"{PGBIN}/psql", "-h", "127.0.0.1", "-U", "exact", "-d", db, "-Atc", statement], capture_output=True, text=True)
    assert r.returncode == 0, f"psql {db}: {r.stderr.strip()}\n{statement}"


class Server:
    """One of the two servers. `basic(user)` is a client with Basic auth (the v1 API / exact-sync way), `session(user)` one that is logged in
    like a browser (CSRF header set), for the views that need a session."""

    def __init__(self, name, url):
        self.name, self.url = name, url
        self._basic, self._session = {}, {}

    def basic(self, user, password=PW):
        key = (user, password)
        if key not in self._basic:
            self._basic[key] = httpx.Client(base_url=self.url, auth=(user, password), timeout=120, follow_redirects=False)
        return self._basic[key]

    def login(self, user, password=PW):
        """A fresh logged-in client (not cached): the status of a failed login is part of the tests."""
        c = httpx.Client(base_url=self.url, timeout=120, follow_redirects=False)
        if self.name == "django":
            c.get("/user/login/")
            r = c.post("/user/login/", data={"username": user, "password": password, "csrfmiddlewaretoken": c.cookies.get("csrftoken")})
            ok = r.status_code in (301, 302) and "sessionid" in c.cookies
            c.headers["X-CSRFToken"] = c.cookies.get("csrftoken", "")
        else:
            r = c.post("/api/v2/auth/login", json={"username": user, "password": password})
            ok = r.status_code == 200
            if ok:
                token = r.json()["csrf_token"]
                c.headers["X-CSRF-Token"] = token
                c.headers["X-CSRFToken"] = token
        c.logged_in = ok
        return c

    def session(self, user, password=PW):
        key = (user, password)
        if key not in self._session:
            c = self.login(user, password)
            assert c.logged_in, f"{self.name}: login of {user} failed"
            self._session[key] = c
        return self._session[key]


django = Server("django", DJANGO_URL)
rust = Server("rust", RUST_URL)
BOTH = (django, rust)


def unique(prefix="coex"):
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def png(w=300, h=200, seed=1):
    """A small noisy RGB PNG."""
    import io

    from PIL import Image

    im = Image.new("RGB", (w, h))
    px = im.load()
    s = seed
    for y in range(h):
        for x in range(w):
            s = (s * 1103515245 + 12345) & 0x7FFFFFFF
            px[x, y] = ((s >> 8) & 255, (s >> 16) & 255, (x * 255) // max(w, 1))
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def delete_user(name):
    """What Django's `user.delete()` does: every row that points at the user goes first."""
    rows = sql(f"select id from users_user where username = '{name}'")
    if not rows:
        return
    uid = rows[0]["id"]
    refs = sql("select conrelid::regclass::text t, a.attname c from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = k.conkey[1] "
               "where k.contype = 'f' and k.confrelid = 'users_user'::regclass and array_length(k.conkey, 1) = 1")
    for r in refs:
        try:
            execute(f'delete from {r["t"]} where "{r["c"]}" = {uid}')
        except AssertionError:
            pass  # a table whose rows must stay (images created by the user, annotations...): nulled below
    execute(f"delete from users_user where id = {uid}")
