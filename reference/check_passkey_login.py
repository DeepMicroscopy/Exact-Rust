"""Ground truth: log in to the scratch Django with the fixture passkey (proves the software authenticator is valid)."""
import json, pathlib, sys
import httpx
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "tests" / "conformance"))
from softkey import SoftKey

fx = json.loads((pathlib.Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "passkey.json").read_text())
key = SoftKey.from_json(fx)
c = httpx.Client(base_url="http://localhost:8001", follow_redirects=False)
c.get("/auth/login/")
opts = c.get("/passkeys/auth/begin").json()["publicKey"]
cred = key.get(opts)
r = c.post("/auth/login/", data={"username": "", "password": "", "passkeys": json.dumps(cred), "csrfmiddlewaretoken": c.cookies["csrftoken"]}, headers={"Referer": "http://localhost:8001"})
print("status", r.status_code, "location", r.headers.get("location"), "session", "sessionid" in c.cookies)
me = c.get("/api/v1/users/users/", follow_redirects=True)
print("api as session user:", me.status_code, [u["username"] for u in me.json().get("results", [])][:3])
