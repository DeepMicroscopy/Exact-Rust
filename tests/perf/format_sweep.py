"""Format sweep + tile latency baseline against any EXACT-compatible server (EXACT_URL).

For every image: request the DeepZoom descriptor and one tile at the full-resolution level near the
image centre (plus a low-res tile), record status, content-type, decoded tile size and latency.
Output: JSON report (default tests/perf/reports/<label>.json) and a summary table.
Usage: python format_sweep.py <label> [--user aubreville]
"""
import argparse, io, json, math, os, pathlib, re, statistics, sys, time
import httpx
from PIL import Image

BASE = os.environ.get("EXACT_URL", "http://127.0.0.1:8001").rstrip("/")
PW = os.environ.get("EXACT_TEST_PW", "rust-test-pw")

ap = argparse.ArgumentParser()
ap.add_argument("label")
ap.add_argument("--user", default="aubreville")
ap.add_argument("--limit", type=int, default=0)
a = ap.parse_args()

c = httpx.Client(base_url=BASE, timeout=300, follow_redirects=True)
r = c.get("/auth/login/")
tok = c.cookies.get("csrftoken") or re.search(r'csrfmiddlewaretoken" value="([^"]+)', r.text).group(1)
r = c.post("/auth/login/", data={"username": a.user, "password": PW, "csrfmiddlewaretoken": tok}, headers={"Referer": BASE})
assert "sessionid" in c.cookies, "login failed"
api = httpx.Client(base_url=BASE, auth=(a.user, PW), timeout=300)

images = []
off = 0
while True:
    j = api.get("/api/v1/images/images/", params={"limit": 100, "offset": off, "omit": "annotations"}).json()
    images += j["results"]
    if not j.get("next"):
        break
    off += 100
if a.limit:
    images = images[: a.limit]

rows = []
for im in sorted(images, key=lambda i: i["id"]):
    iid, w, h = im["id"], im["width"], im["height"]
    ext = im["name"].rsplit(".", 1)[-1].lower()
    max_level = math.ceil(math.log2(max(w, h, 1)))
    row = {"id": iid, "name": im["name"], "ext": ext, "width": w, "height": h}
    for tag, level in (("full", max_level), ("low", max(max_level - 6, 0))):
        n = 2 ** (max_level - level)
        cols, rws = math.ceil(w / n / 254), math.ceil(h / n / 254)
        col, rw = cols // 2, rws // 2
        t = time.perf_counter()
        try:
            resp = c.get(f"/images/image/{iid}/1/0/tile_files/{level}/{col}_{rw}.jpeg")
            ms = (time.perf_counter() - t) * 1000
            size = None
            if resp.status_code == 200 and resp.headers.get("content-type", "").startswith("image"):
                size = list(Image.open(io.BytesIO(resp.content)).size)
            row[tag] = {"level": level, "col": col, "row": rw, "status": resp.status_code, "ms": round(ms, 1), "tile_size": size}
        except Exception as e:  # noqa
            row[tag] = {"level": level, "status": -1, "error": str(e)[:120]}
    rows.append(row)
    print(f"{iid:4d} {ext:5s} full={row['full'].get('status')} {row['full'].get('ms','-'):>8}ms low={row['low'].get('status')} {row['low'].get('ms','-'):>8}ms", flush=True)

out = pathlib.Path(__file__).parent / "reports"
out.mkdir(exist_ok=True)
(out / f"{a.label}.json").write_text(json.dumps({"base": BASE, "rows": rows}, indent=1))
ok = [r for r in rows if r["full"].get("status") == 200]
lat = [r["full"]["ms"] for r in ok]
print(f"\n{len(ok)}/{len(rows)} images served a full-res tile; "
      + (f"median {statistics.median(lat):.0f} ms, p95 {sorted(lat)[int(len(lat)*0.95)-1]:.0f} ms" if lat else "no data"))
by = {}
for r in rows:
    by.setdefault(r["ext"], []).append(r["full"].get("status") == 200)
print("per format (ok/total):", {k: f"{sum(v)}/{len(v)}" for k, v in sorted(by.items())})
