"""Compare the server under test (EXACT_URL) with the recorded Django goldens, per role."""
import gzip, json, pathlib
import pytest
from common import USERS, client, fetch

GOLD = pathlib.Path(__file__).parent / "goldens" / "django"


# Django serves `slide_information` from its cache before checking the team, so a recorded response for a user
# outside the team depends on who asked first. Rust always checks (404); not reproduced on purpose.
def cache_leak(name, golden, got):
    return name.endswith("/slide_information") and golden["status"] == 200 and got["status"] == 404


def cases():
    return list(_cases())


def _cases():
    for user in USERS:
        f = GOLD / f"{user}.json"
        if f.exists():
            for name, g in json.loads(f.read_text()).items():
                yield pytest.param(user, name, g, id=f"{user}:{name}")


@pytest.mark.parametrize("user,name,golden", cases())
def test_matches_django(user, name, golden):
    with client(user) as c:
        got = fetch(c, golden["path"], golden["params"])
    if cache_leak(name, golden, got):
        pytest.skip("Django cache bypasses the team check")
    assert got["status"] == golden["status"], f"status differs for {golden['path']}"
    assert got["body"] == golden["body"], f"body differs for {golden['path']}"


def auth_cases():
    f = GOLD / "auth_cases.json"
    return [pytest.param(n, g, id=n) for n, g in json.loads(f.read_text()).items()] if f.exists() else []


@pytest.mark.parametrize("name,golden", auth_cases())
def test_auth_case_matches_django(name, golden):
    import auth_cases as ac
    got = ac.run(name)
    assert got["status"] == golden["status"], f"status: {got['body']} vs {golden['body']}"
    assert got["body"] == golden["body"]
    allow = lambda h: {k: sorted(v.split(", ")) if k == "allow" else v for k, v in h.items()}  # Django lists methods in per-process random order
    assert allow(got["headers"]) == allow(golden["headers"])


def resource_cases():
    f = GOLD / "resource_cases.json.gz"
    if not f.exists():
        return []
    with gzip.open(f, "rt") as fh:
        return [pytest.param(n, g, id=n) for n, g in json.load(fh).items()]


@pytest.mark.parametrize("name,golden", resource_cases())
def test_resource_case_matches_django(name, golden):
    from common import normalize
    with client(golden["user"]) as c:
        r = c.get(golden["path"], params=[tuple(p) for p in golden["params"]])
    try:
        body = normalize(r.json())
    except Exception:
        body = {"_non_json_len": len(r.content)}
    assert r.status_code == golden["status"], f"status {r.status_code} vs {golden['status']}: {body}"
    assert body == golden["body"]
