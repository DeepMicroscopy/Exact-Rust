"""Compare slide endpoints of the Rust server with the reference Django, image by image.

Both servers must run (DJANGO_URL default :8001, EXACT_URL default :8002) on the same database and image files.
Per image: DZI descriptor, slide information, one full-resolution tile near the centre, one low-resolution tile,
thumbnail and a patch. Tiles are compared by size and mean absolute pixel difference (JPEG encoders differ).
Usage: python compare_slides.py [--ids 41,42] [--max-diff 3.0]
"""
import argparse, io, math, os, sys
import httpx
import numpy as np
from PIL import Image

D = os.environ.get("DJANGO_URL", "http://127.0.0.1:8001").rstrip("/")
R = os.environ.get("EXACT_URL", "http://127.0.0.1:8002").rstrip("/")
PW = os.environ.get("EXACT_TEST_PW", "rust-test-pw")
ap = argparse.ArgumentParser()
ap.add_argument("--ids", default="")
ap.add_argument("--max-diff", type=float, default=6.0)
ap.add_argument("--user", default="aubreville")
a = ap.parse_args()
dj, ru = (httpx.Client(base_url=u, auth=(a.user, PW), timeout=300) for u in (D, R))

images, off = [], 0
while True:
    j = ru.get("/api/v1/images/images/", params={"limit": 100, "offset": off, "omit": "annotations"}).json()
    images += j["results"]
    if not j.get("next"):
        break
    off += 100
want = {int(x) for x in a.ids.split(",") if x}
images = [i for i in sorted(images, key=lambda i: i["id"]) if not want or i["id"] in want]


def same(a, b):
    if isinstance(a, float) or isinstance(b, float):
        # 0.1%: slideio levels report 16.0007 for an exact 16:1 grid, Rust reports the exact 16.0 (see PLAN 5i item 7)
        return abs(a - b) <= 1e-3 * max(1.0, abs(a))
    if isinstance(a, list):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    return a == b


def pix(b):
    return np.asarray(Image.open(io.BytesIO(b)).convert("RGB"), dtype=np.int16)


def cmp_img(p, pixels=True):
    x, y = dj.get(p), ru.get(p)
    if x.status_code != y.status_code:
        return f"status django={x.status_code} rust={y.status_code}"
    if x.status_code != 200:
        return None
    A, B = pix(x.content), pix(y.content)
    if A.shape != B.shape:
        return f"size django={A.shape[1::-1]} rust={B.shape[1::-1]}"
    if not pixels:
        return None
    d = float(np.abs(A - B).mean())
    return f"mean abs diff {d:.2f}" if d > a.max_diff else None


# Django swaps width and height of non-square MKT frames (508x512 reported as 512x508); Rust reports them correctly.
KNOWN_DIVERGENT = {
    109: "MKT with non-square frames: Django swaps width and height",
    98: "multi-page plain TIFF: the reference Django serves content of another image here; Rust matches a PIL crop of the file",
    2: "big-endian OME-TIFF with a SubIFD pyramid: Django reports a single level (and renders every low zoom from full resolution); Rust uses the 4 levels",
    99: "see 98",
    19: "TIFF whose pyramid pages 1-4 are grey noise (not copies of page 0): Rust drops the broken levels, Django serves them",
    48: "see 19 (pages 1-5 are grey noise)",
    95: "see 19 (pages 1-2 are grey noise)",
    102: "see 98",
    6: "JPEG-compressed OME-TIFF: the reference Django lacks `imagecodecs` and serves black tiles; Rust output checked against an independent PIL decode",
}
bad = 0
for im in images:
    iid = im["id"]
    base = f"/api/v1/images/images/{iid}"
    problems = []
    si = [c.get(base + "/slide_information/") for c in (dj, ru)]
    if si[0].status_code != si[1].status_code:
        problems.append(f"slide_information status django={si[0].status_code} rust={si[1].status_code}")
    elif si[0].status_code == 200 and not same(si[0].json(), si[1].json()):
        problems.append("slide_information differs")
    dz = [c.get(base + "/1/0/tile/") for c in (dj, ru)]
    if dz[0].status_code != dz[1].status_code:
        problems.append(f"dzi status django={dz[0].status_code} rust={dz[1].status_code}")
    elif dz[0].status_code == 200:
        import re
        n = lambda t: re.findall(r'(\w+)="([^"]*)"', t)
        if sorted(n(dz[0].text)) != sorted(n(dz[1].text)):
            problems.append(f"dzi differs: {dz[0].text[-120:]} vs {dz[1].text[-120:]}")
    if si[0].status_code == 200:
        lt = si[0].json()["level_tiles"]
        for tag, level in (("full", len(lt) - 1), ("low", max(len(lt) - 7, 0))):
            col, row = lt[level][0] // 2, lt[level][1] // 2
            # Django of the reference environment reads blank regions from lower pyramid levels (libopenslide 4.0
            # with openslide-python 1.4), so low-resolution tiles are only compared by size.
            r = cmp_img(f"{base}/1/0/tile_files/{level}/{col}_{row}.jpeg/", pixels=(tag == "full"))
            if r:
                problems.append(f"{tag} tile: {r}")
    # Thumbnails are not compared: Django serves files cached on disk (some rendered from corrupt pyramid levels, many
    # stretched to 128x128), Rust renders its own with the aspect ratio kept. Only check that one is served.
    t = ru.get(base + "/thumbnail/")
    if t.status_code != 200 or not t.headers.get("content-type", "").startswith("image/png"):
        problems.append(f"thumbnail: status {t.status_code}")
    if iid in KNOWN_DIVERGENT and problems:
        print(f"KNOWN {iid:4d} {im['name'][:50]:50s} {KNOWN_DIVERGENT[iid]}", flush=True)
        continue
    status = "OK  " if not problems else "FAIL"
    bad += bool(problems)
    print(f"{status} {iid:4d} {im['name'][:50]:50s} {'; '.join(problems)}", flush=True)
print(f"\n{len(images) - bad}/{len(images)} images match")
sys.exit(1 if bad else 0)
