"""Compare the MPR planes (axial/coronal/sagittal) of volumetric images between Django and Rust (viewer routes).

Both servers must run (DJANGO_URL default :8001, EXACT_URL default :8002). Django uses its session login, Rust the
/api/v2/auth/login session. Usage: python compare_planes.py [--ids 82,86]
"""
import argparse, io, math, os, re, sys
import httpx
import numpy as np
from PIL import Image

D = os.environ.get("DJANGO_URL", "http://127.0.0.1:8001").rstrip("/")
R = os.environ.get("EXACT_URL", "http://127.0.0.1:8002").rstrip("/")
PW = os.environ.get("EXACT_TEST_PW", "rust-test-pw")
ap = argparse.ArgumentParser()
ap.add_argument("--ids", default="")
ap.add_argument("--max-diff", type=float, default=6.0)
a = ap.parse_args()

dj = httpx.Client(base_url=D, timeout=300, follow_redirects=True)
r = dj.get("/auth/login/")
tok = dj.cookies.get("csrftoken") or re.search(r'csrfmiddlewaretoken" value="([^"]+)', r.text).group(1)
dj.post("/auth/login/", data={"username": "aubreville", "password": PW, "csrfmiddlewaretoken": tok}, headers={"Referer": D})
assert "sessionid" in dj.cookies, "Django login failed"
ru = httpx.Client(base_url=R, timeout=300)
assert ru.post("/api/v2/auth/login", json={"username": "aubreville", "password": PW}).status_code == 200
api = httpx.Client(base_url=R, auth=("aubreville", PW), timeout=300)

imgs = [i for i in api.get("/api/v1/images/images/", params={"limit": 1000, "omit": "annotations"}).json()["results"]
        if re.search(r"\.nii(\.gz)?$", i["name"])]
want = {int(x) for x in a.ids.split(",") if x}
bad = 0
for im in sorted(imgs, key=lambda i: i["id"]):
    iid = im["id"]
    if want and iid not in want:
        continue
    problems = []
    for z, plane in ((1, "axial"), (2, "coronal"), (3, "sagittal")):
        base = f"/images/image/{iid}/{z}/%d"
        for frame in (0, 3):
            d, u = dj.get(base % frame + "/tile/"), ru.get(base % frame + "/tile/")
            if d.status_code != u.status_code:
                problems.append(f"{plane} f{frame} dzi status {d.status_code}/{u.status_code}")
                continue
            if d.status_code != 200:
                continue
            nums = lambda t: dict(re.findall(r'(Width|Height)="(\d+)"', t))
            if nums(d.text) != nums(u.text):
                problems.append(f"{plane} dzi size {nums(d.text)} vs {nums(u.text)}")
                continue
            w, h = int(nums(d.text)["Width"]), int(nums(d.text)["Height"])
            level = math.ceil(math.log2(max(w, h, 1)))
            tx, ty = w // 2 // 254, h // 2 // 254
            tp = f"{base % frame}/tile_files/{level}/{tx}_{ty}.jpeg"
            td, tu = dj.get(tp), ru.get(tp)
            if td.status_code != tu.status_code:
                problems.append(f"{plane} f{frame} tile status {td.status_code}/{tu.status_code}")
            elif td.status_code == 200:
                A, B = (np.asarray(Image.open(io.BytesIO(x.content)).convert("RGB"), dtype=np.int16) for x in (td, tu))
                if A.shape != B.shape:
                    problems.append(f"{plane} f{frame} tile size {A.shape[1::-1]} vs {B.shape[1::-1]}")
                elif np.abs(A - B).mean() > a.max_diff:
                    problems.append(f"{plane} f{frame} tile diff {np.abs(A - B).mean():.1f}")
    bad += bool(problems)
    print(("OK  " if not problems else "FAIL"), iid, im["name"][:40], "; ".join(problems), flush=True)
sys.exit(1 if bad else 0)
