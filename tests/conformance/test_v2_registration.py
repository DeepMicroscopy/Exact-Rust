"""Registration: jobs and the worker API, conversion, inverse registrations (Rust only). The worker is played by the test;
`REG_E2E=1` additionally runs the real worker (helpers/registration_worker.py) with qt-wsi-registration."""
import concurrent.futures
import os
import pathlib
import subprocess
import threading
import time

import httpx
import pytest
from common import BASE, PW, drop_registration_plugin, registration_plugin

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC, TGT = 31, 33  # registration 16 of the scratch database (matrix only); its inverse (26) exists already
ISRC, ITGT = 28, 29  # registration 25: no inverse yet
JSRC, JTGT = 15, 16  # pair for the job tests (no registration in the scratch database)


def client(user="aubreville"):
    c = httpx.Client(base_url=BASE, timeout=120)
    r = c.post("/api/v2/auth/login", json={"username": user, "password": PW})
    c.headers["X-CSRF-Token"] = r.json()["csrf_token"]
    return c


def matrix(a=1.0, tx=0.0):
    return {"t_00": a, "t_01": 0.0, "t_02": tx, "t_10": 0.0, "t_11": a, "t_12": 5.0, "t_20": 0.0, "t_21": 0.0, "t_22": 1.0}


def fake_worker(c, name, error=0.5, fail=False):
    """Claims one job and completes it with a scaling matrix (or fails it)."""
    r = c.post("/api/v2/registration-jobs/claim", json={"worker": name})
    if r.status_code == 204:
        return None
    job = r.json()
    if fail:
        c.post(f"/api/v2/registration-jobs/{job['id']}/fail", json={"worker": name, "error": "boom"})
    else:
        done = c.post(f"/api/v2/registration-jobs/{job['id']}/complete", data={"worker": name, "transformation_matrix": __import__("json").dumps(matrix(2.0, 10.0)), "registration_error": str(error), "runtime": "3"},
                      files={"file": ("x.pickle", b"not a real pickle")})
        assert done.status_code == 200, done.text
    return job


@pytest.fixture(autouse=True)
def drain_queue():
    c = client()
    subprocess.run([f"{os.environ.get('PGBIN', '/Applications/Postgres.app/Contents/Versions/latest/bin')}/psql", "-h", "127.0.0.1", "-d", os.environ.get("RUST_DB", "exact_rust_test"), "-Atc",
                    "update processing_pluginjob set error_message = 'test cleanup' where error_message is null and processing_complete < 100 and plugin_id in (select id from processing_plugin where plugin_type = 2)"], capture_output=True)
    registration_plugin(c)
    while fake_worker(c, "drain", fail=True):
        pass
    yield
    drop_registration_plugin()
    for r in c.get("/api/v2/registrations", params={"source_image": JSRC, "target_image": JTGT}).json()["items"]:
        c.delete(f"/api/v2/registrations/{r['id']}")


def test_convert_native_matrix_and_inverse_round_trip():
    c = client()
    reg = c.get("/api/v2/registrations", params={"source_image": ISRC, "target_image": ITGT}).json()["items"][0]
    m = reg["transformation_matrix"]
    x, y = 100.0, 250.0
    out = c.get(f"/api/v2/registrations/{reg['id']}/convert", params={"vector": f'{{"x1": {x}, "y1": {y}}}'}).json()
    assert out["x1"] == pytest.approx(m["t_00"] * x + m["t_01"] * y + m["t_02"]) and out["y1"] == pytest.approx(m["t_10"] * x + m["t_11"] * y + m["t_12"])
    two = c.post(f"/api/v2/registrations/{reg['id']}/convert", json={"vector": {"x1": 0, "y1": 0, "x2": x, "y2": y}}).json()
    assert two["x1"] == pytest.approx(m["t_02"]) and two["x2"] == pytest.approx(out["x1"])
    inv = c.post(f"/api/v2/registrations/{reg['id']}/inverse")
    assert inv.status_code == 201, inv.text
    inv = inv.json()
    assert (inv["source_image"], inv["target_image"]) == (ITGT, ISRC) and inv["registration_error"] == reg["registration_error"]
    back = c.get(f"/api/v2/registrations/{inv['id']}/convert", params={"vector": f'{{"x1": {out["x1"]}, "y1": {out["y1"]}}}'}).json()
    assert back["x1"] == pytest.approx(x, abs=1e-6) and back["y1"] == pytest.approx(y, abs=1e-6)
    assert c.post(f"/api/v2/registrations/{reg['id']}/inverse").status_code == 409
    c.delete(f"/api/v2/registrations/{inv['id']}")


def test_convert_input_errors_and_visibility():
    c = client()
    reg = c.get("/api/v2/registrations", params={"source_image": SRC, "target_image": TGT}).json()["items"][0]["id"]
    assert c.get(f"/api/v2/registrations/{reg}/convert").status_code == 400
    assert c.get(f"/api/v2/registrations/{reg}/convert", params={"vector": '{"x1": 1, "y1": "a"}'}).status_code == 400
    assert c.get(f"/api/v2/registrations/{reg}/convert", params={"vector": "{'x1': 1, 'y1': 2}"}).status_code == 200  # python quotes
    assert client("rt_outsider").get(f"/api/v2/registrations/{reg}/convert", params={"vector": '{"x1": 1, "y1": 2}'}).status_code == 404


def test_legacy_endpoints_match_django_behaviour():
    c = client()
    reg = c.get("/api/v2/registrations", params={"source_image": ISRC, "target_image": ITGT}).json()["items"][0]["id"]
    r = c.get(f"/api/v1/images/registration/{reg}/convert_coodinates/", params={"vector": '{"x1": 1, "y1": 2}'})
    assert r.status_code == 202 and set(r.json()) == {"x1", "y1"}
    inv = c.get(f"/api/v1/images/registration/{reg}/create_inverse_registration/")
    assert inv.status_code == 201 and inv.json()["source_image"] == ITGT and "rotation_angle" in inv.json()
    c.delete(f"/api/v2/registrations/{inv.json()['id']}")


def test_job_lifecycle_complete_creates_then_updates_the_registration():
    c = client()
    j = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT, "maxFeatures": 100, "bogus": 1})
    assert j.status_code == 202 and j.json()["status"] == "queued" and j.json()["params"] == {"maxFeatures": 100}
    again = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT})
    assert again.json()["id"] == j.json()["id"]  # the open job is reused
    claimed = fake_worker(c, "w1", error=0.25)
    assert claimed["id"] == j.json()["id"] and claimed["source_path"].endswith("") and claimed["params"] == {"maxFeatures": 100}
    job = c.get(f"/api/v2/registration-jobs/{claimed['id']}").json()
    assert job["status"] == "done" and job["worker"] == "w1" and job["registration"]
    reg = c.get(f"/api/v2/registrations/{job['registration']}").json()
    assert reg["registration_error"] == 0.25 and reg["transformation_matrix"]["t_00"] == 2.0 and reg["runtime"] == 3
    assert reg["file"] and reg["file"].endswith(".pickle") and "registration/" in reg["file"]
    assert c.get("/api/v2/registrations", params={"source_image": JSRC, "target_image": JTGT}).json()["items"][0]["id"] == reg["id"]  # updated, not duplicated
    assert c.post("/api/v2/registration-jobs/claim", json={"worker": "w1"}).status_code == 204


def test_failed_job_and_wrong_worker():
    c = client()
    j = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT}).json()
    claimed = fake_worker(c, "w1", fail=True)
    assert claimed["id"] == j["id"]
    job = c.get(f"/api/v2/registration-jobs/{j['id']}").json()
    assert job["status"] == "failed" and job["error"] == "boom"
    j2 = c.post(f"/api/v2/images/{JSRC}/register", json={"target_image": JTGT}).json()
    r = c.post("/api/v2/registration-jobs/claim", json={"worker": "w1"})
    assert r.json()["id"] == j2["id"]
    other = c.post(f"/api/v2/registration-jobs/{j2['id']}/fail", json={"worker": "someone-else", "error": "x"})
    assert other.status_code == 409
    c.post(f"/api/v2/registration-jobs/{j2['id']}/fail", json={"worker": "w1", "error": "x"})


def test_create_inverse_option_and_validation_and_permissions():
    c = client()
    assert c.post(f"/api/v2/images/{SRC}/register", json={}).status_code == 400
    assert c.post(f"/api/v2/images/{SRC}/register", json={"target_image": SRC}).status_code == 400
    assert c.post(f"/api/v2/images/{SRC}/register", json={"target_image": 99999}).status_code == 404
    assert client("rt_outsider").post(f"/api/v2/images/{SRC}/register", json={"target_image": TGT}).status_code in (403, 404)
    assert client("rt_member").post("/api/v2/registration-jobs/claim", json={"worker": "x"}).status_code == 403
    j = c.post("/api/v2/images/6/register", json={"target_image": 14, "create_inverse_registration": True}).json()
    claimed = fake_worker(c, "w1")
    assert claimed["id"] == j["id"]
    regs = c.get("/api/v2/registrations", params={"source_image__in": "6,14"}).json()["items"]
    pairs = {(r["source_image"], r["target_image"]): r for r in regs}
    assert (6, 14) in pairs and (14, 6) in pairs
    assert pairs[(14, 6)]["transformation_matrix"]["t_00"] == pytest.approx(0.5)  # the inverse of the scaling by 2
    for r in pairs.values():
        c.delete(f"/api/v2/registrations/{r['id']}")


def test_two_workers_never_get_the_same_job():
    c = client()
    ids = []
    for target in (6, 11, 14):
        ids.append(c.post(f"/api/v2/images/{SRC}/register", json={"target_image": target}).json()["id"])

    def take(i):
        r = client().post("/api/v2/registration-jobs/claim", json={"worker": f"w{i}"})
        return (r.json()["id"], f"w{i}") if r.status_code == 200 else None

    with concurrent.futures.ThreadPoolExecutor(6) as ex:
        got = [g for g in ex.map(take, range(6)) if g]
    assert sorted(i for i, _ in got) == sorted(ids)
    for i, w in got:
        c.post(f"/api/v2/registration-jobs/{i}/fail", json={"worker": w, "error": "x"})


def test_v1_register_images_waits_for_the_worker():
    c = client()
    result = {}

    def request():
        result["r"] = client().post(f"/api/v1/images/images/{JSRC}/register_images/", json={"target_image": JTGT, "maxFeatures": 64})

    t = threading.Thread(target=request)
    t.start()
    job = None
    for _ in range(40):
        job = fake_worker(c, "w1", error=1.5)
        if job:
            break
        time.sleep(0.25)
    t.join(30)
    assert job and result["r"].status_code in (201, 202), result["r"].text
    body = result["r"].json()
    assert body["registration_error"] == 1.5 and body["source_image"] == JSRC and body["target_image"] == JTGT and "inv_matrix" in body


@pytest.mark.skipif(not os.environ.get("REG_E2E"), reason="REG_E2E=1 runs the real registration worker")
def test_real_worker_registers_and_the_helper_converts_through_the_pickle():
    c = client()
    py = os.environ.get("REGISTRATION_PYTHON", "/opt/miniconda3/envs/env311/bin/python")
    src, tgt = int(os.environ.get("REG_SRC", 43)), int(os.environ.get("REG_TGT", 2))
    # the worker serves its own plugin (the same name and package as it announces), a job names the plugin it is for
    plugin = c.post("/api/v2/plugins/register", json={"name": "Quad-tree SIFT registration", "author": "tests", "package": "qt_wsi_reg", "plugin_type": 2}).json()
    j = c.post(f"/api/v2/images/{src}/register", json={"target_image": tgt, "plugin": plugin["id"], "maxFeatures": 256, "thumbnail_size": [512, 512]}).json()
    env = {**os.environ, "EXACT_URL": BASE, "EXACT_USER": "aubreville", "EXACT_PASSWORD": PW,
           "EXACT_DIR": os.environ.get("REGISTRATION_EXACT_DIR", str(pathlib.Path.home() / "code/Exact/exact"))}
    out = subprocess.run([py, str(ROOT / "helpers/registration_worker.py"), "--once", "--name", "e2e"], env=env, capture_output=True, text=True, timeout=1200)
    job = c.get(f"/api/v2/registration-jobs/{j['id']}").json()
    assert job["status"] == "done", out.stdout + out.stderr
    reg = c.get(f"/api/v2/registrations/{job['registration']}").json()
    assert reg["file"] and reg["transformation_matrix"]
    conv = c.get(f"/api/v2/registrations/{reg['id']}/convert", params={"vector": '{"x1": 100, "y1": 100}'})
    assert conv.status_code == 200, conv.text
    assert set(conv.json()) == {"x1", "y1"}


@pytest.mark.skipif(not os.environ.get("REG_E2E"), reason="REG_E2E=1 runs the real registration worker")
@pytest.mark.parametrize("mode", ["affine", "deformable"])
def test_real_worker_registers_with_deeperhistreg(mode):
    c = client()
    py = os.environ.get("REGISTRATION_PYTHON", "/opt/miniconda3/envs/env311/bin/python")
    src, tgt = int(os.environ.get("REG_SRC", 43)), int(os.environ.get("REG_TGT", 2))
    plugin = c.post("/api/v2/plugins/register", json={"name": "DeeperHistReg", "author": "tests", "package": "deeperhistreg", "plugin_type": 2}).json()
    j = c.post(f"/api/v2/images/{src}/register", json={"target_image": tgt, "plugin": plugin["id"], "mode": mode, "device": "cpu",
                                                       "thumbnail_size": 1024, "registration_size": 512, "angle_step": 90}).json()
    env = {**os.environ, "EXACT_URL": BASE, "EXACT_USER": "aubreville", "EXACT_PASSWORD": PW,
           "EXACT_DIR": os.environ.get("REGISTRATION_EXACT_DIR", str(pathlib.Path.home() / "code/Exact/exact"))}
    out = subprocess.run([py, str(ROOT / "helpers/queue_worker.py"), "--only", "DeeperHistReg", "--once", "--name", "e2e-dhr"], env=env, capture_output=True, text=True, timeout=1800)
    job = c.get(f"/api/v2/registration-jobs/{j['id']}").json()
    assert job["status"] == "done", out.stdout + out.stderr
    reg = c.get(f"/api/v2/registrations/{job['registration']}").json()
    assert reg["file"] and reg["transformation_matrix"]
    conv = c.get(f"/api/v2/registrations/{reg['id']}/convert", params={"vector": '{"x1": 1000, "y1": 1000}'})
    assert conv.status_code == 200, conv.text
    assert set(conv.json()) == {"x1", "y1"}


def test_team_members_manage_registrations_without_model_permissions():
    t, a = client("rt_teamadmin"), client()
    j = t.post("/api/v2/images/6/register", json={"target_image": 11})  # rt_teamadmin has no Django model permissions, only the team
    assert j.status_code == 202, j.text
    assert fake_worker(a, "w1")["id"] == j.json()["id"]
    reg = a.get("/api/v2/registrations", params={"source_image": 6, "target_image": 11}).json()["items"][0]["id"]
    inv = t.post(f"/api/v2/registrations/{reg}/inverse")
    assert inv.status_code == 201, inv.text
    assert client("rt_outsider").delete(f"/api/v2/registrations/{reg}").status_code == 404
    assert t.delete(f"/api/v2/registrations/{inv.json()['id']}").status_code == 204
    assert t.delete(f"/api/v2/registrations/{reg}").status_code == 204
    assert t.get(f"/api/v2/registrations/{reg}").status_code == 404


def test_manual_registration_from_point_pairs():
    c = client()
    pairs = lambda f: [{"source": s, "target": f(s)} for s in ([0, 0], [100, 0], [0, 80], [60, 90])]
    # target = 2 * source + (10, 5): an affine fit finds it exactly, with the inverse created too
    r = c.post("/api/v2/registrations/manual", json={"source_image": JSRC, "target_image": JTGT, "inverse": True, "points": pairs(lambda s: [2 * s[0] + 10, 2 * s[1] + 5])})
    assert r.status_code == 201, r.text
    m = r.json()["transformation_matrix"]
    assert abs(m["t_00"] - 2) < 1e-9 and abs(m["t_12"] - 5) < 1e-9 and r.json()["registration_error"] < 1e-9
    inv = c.get(f"/api/v2/registrations?source_image={JTGT}&target_image={JSRC}").json()["items"][0]
    assert abs(inv["transformation_matrix"]["t_00"] - 0.5) < 1e-9
    pts = c.get(f"/api/v2/registrations/{r.json()['id']}/points").json()["points"]
    assert len(pts) == 4 and pts[1] == {"source": [100, 0], "target": [210, 5]}
    # a second one replaces both (one pair = a shift)
    r2 = c.post("/api/v2/registrations/manual", json={"source_image": JSRC, "target_image": JTGT, "inverse": True, "points": [{"source": [1, 1], "target": [4, 5]}]})
    assert r2.status_code == 201 and r2.json()["id"] == r.json()["id"]
    assert r2.json()["transformation_matrix"]["t_02"] == 3
    inv2 = c.get(f"/api/v2/registrations?source_image={JTGT}&target_image={JSRC}").json()["items"][0]
    assert inv2["id"] == inv["id"] and inv2["transformation_matrix"]["t_02"] == -3
    # invalid input
    bad = lambda **k: c.post("/api/v2/registrations/manual", json={"source_image": JSRC, "target_image": JTGT, **k}).status_code
    assert bad(points=[]) == 400 and bad(points=[{"source": [1, 1]}]) == 400
    assert bad(points=[{"source": [0, 0], "target": [0, 0]}, {"source": [1, 1], "target": [0, 0]}, {"source": [2, 2], "target": [0, 0]}]) == 400  # collinear
    assert c.post("/api/v2/registrations/manual", json={"source_image": JSRC, "target_image": JSRC, "points": pairs(lambda s: s)}).status_code == 400
    for reg in (r.json()["id"], inv["id"]):
        assert c.delete(f"/api/v2/registrations/{reg}").status_code == 204
    # no right to edit the source image's set
    assert client("rt_outsider").post("/api/v2/registrations/manual", json={"source_image": JSRC, "target_image": JTGT, "points": [{"source": [1, 1], "target": [4, 5]}]}).status_code in (403, 404)


@pytest.mark.skipif(not os.environ.get("REG_E2E"), reason="REG_E2E=1 runs the real registration worker")
def test_real_worker_registers_with_the_multistage_plugin():
    """The plugin that refines a feature based alignment on the slides: announced by the worker, queued through the API with its own
    parameters, run, and the matrix stored. REG_SRC / REG_TGT name the pair (default: the same as the DeeperHistReg test)."""
    c = client()
    py = os.environ.get("REGISTRATION_PYTHON", "/opt/miniconda3/envs/env311/bin/python")
    src, tgt = int(os.environ.get("REG_SRC", 43)), int(os.environ.get("REG_TGT", 2))
    import importlib.util
    import sys

    sys.path.insert(0, str(ROOT / "helpers"))
    spec = importlib.util.spec_from_file_location("multistage_plugin", ROOT / "helpers/plugins/multistage_registration.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    # what the worker announces on start: the server keeps only the parameters that the announced schema names
    plugin = c.post("/api/v2/plugins/register", json=mod.PLUGINS[0].describe()).json()
    j = c.post(f"/api/v2/images/{src}/register", json={"target_image": tgt, "plugin": plugin["id"], "initial": "sift", "thumbnail_size": 1024,
                                                       "refine_size": 1024, "tile_size": 128, "rounds": 2}).json()
    assert j["params"]["initial"] == "sift", j
    env = {**os.environ, "EXACT_URL": BASE, "EXACT_USER": "aubreville", "EXACT_PASSWORD": PW,
           "EXACT_DIR": os.environ.get("REGISTRATION_EXACT_DIR", str(pathlib.Path.home() / "code/Exact/exact"))}
    out = subprocess.run([py, str(ROOT / "helpers/queue_worker.py"), "--only", "Multi-stage", "--once", "--name", "e2e-multistage"], env=env, capture_output=True, text=True, timeout=1800)
    job = c.get(f"/api/v2/registration-jobs/{j['id']}").json()
    assert job["status"] == "done", out.stdout + out.stderr
    reg = c.get(f"/api/v2/registrations/{job['registration']}").json()
    assert reg["transformation_matrix"] and reg["registration_error"] >= 0
    conv = c.get(f"/api/v2/registrations/{reg['id']}/convert", params={"vector": '{"x1": 1000, "y1": 1000}'})
    assert conv.status_code == 200, conv.text
    # the schema the worker announced is what the dialog shows: a choice and the numbers with their limits
    schema = {p["name"]: p for p in next(x for x in c.get("/api/v2/registration-plugins").json()["items"] if x["id"] == plugin["id"])["parameters_schema"]}
    assert schema["initial"]["type"] == "choice" and schema["refine_size"]["max"] == 8192 and schema["refine"]["default"] is True
