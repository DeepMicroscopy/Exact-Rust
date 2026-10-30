#!/usr/bin/env python3
"""Speed of two EXACT servers side by side (the old Django one and exact-rust), read-only, the same requests for both.

  tests/perf/compare_servers.py [--env .exact-perf.env] [--annotation-images 1702] [--reps 5] [--skip-slides] [--skip-annotations]
                                [--concurrency 4,8 --seconds 20]

The credentials come from a file of KEY=VALUE lines (never printed):
  PROD_URL, PROD_USER, PROD_PASSWORD     the old EXACT (Django)
  BETA_URL, BETA_USER, BETA_PASSWORD     exact-rust on a copy of the same data
Only GET requests. By default one request at a time (a single client), the two servers alternating so that the time of day and the file
cache do not favour one of them. Every request is timed to the first byte and to the end; the first look is reported as "cold", the median
of the repeats as "warm". The load phase (--concurrency) is separate and has to be asked for: it puts N clients on each server in turn.

Scenarios: the lists the interface and exact-sync ask for (image sets, images, teams), all annotations of a big image (the legacy call that
exact-sync uses), and for a few images of every file format the DeepZoom descriptor, a full-resolution and a low-resolution tile and the
thumbnail. "basic" is HTTP Basic on every request (exact-sync, workers), "session" a cookie after one login (the browser).
The report with every timing goes to tests/perf/reports/local/ (not committed: it names images).
"""
import argparse
import datetime
import json
import math
import pathlib
import re
import statistics
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import httpx

HERE = pathlib.Path(__file__).resolve().parent
PAUSE = 0.15  # seconds between two requests of the sequential phase
FORMATS = ["svs", "mrxs", "ndpi", "tiff", "tif", "vsi", "czi", "png", "jpg"]


def read_env(path: pathlib.Path) -> dict:
    out = {}
    for line in path.read_text().splitlines():
        m = re.match(r"\s*([A-Z_]+)\s*=\s*(.*?)\s*$", line)
        if m and not line.lstrip().startswith("#"):
            out[m.group(1)] = m.group(2).strip("\"'")
    return out


class Server:
    def __init__(self, name: str, base: str, user: str, password: str, timeout: float):
        self.name, self.base = name, base.rstrip("/")
        self.user, self.password = user, password
        self.basic = httpx.Client(base_url=self.base, auth=(user, password), timeout=timeout, follow_redirects=True)
        self.session = httpx.Client(base_url=self.base, timeout=timeout, follow_redirects=True)
        self.kind = "?"
        self.session_ok = False

    def login(self) -> None:
        self.kind = "rust" if self.session.get("/api/version").status_code == 200 else "django"
        if self.kind == "rust":
            r = self.session.post("/api/v2/auth/login", json={"username": self.user, "password": self.password})
            self.session_ok = r.status_code == 200
        else:
            r = self.session.get("/auth/login/")
            token = self.session.cookies.get("csrftoken")
            if not token:
                m = re.search(r'csrfmiddlewaretoken" value="([^"]+)', r.text)
                token = m.group(1) if m else ""
            self.session.post("/auth/login/", data={"username": self.user, "password": self.password, "csrfmiddlewaretoken": token}, headers={"Referer": self.base})
            self.session_ok = "sessionid" in self.session.cookies

    def get(self, mode: str, url: str, params: dict | None = None) -> dict:
        client = self.basic if mode == "basic" else self.session
        t0 = time.perf_counter()
        try:
            with client.stream("GET", url, params=params) as r:
                first = None
                size = 0
                chunks = []
                for chunk in r.iter_bytes():
                    if first is None:
                        first = time.perf_counter() - t0
                    size += len(chunk)
                    if size < 40_000_000:
                        chunks.append(chunk)
                total = time.perf_counter() - t0
                return {"status": r.status_code, "ttfb_ms": round((first if first is not None else total) * 1000, 1), "total_ms": round(total * 1000, 1), "bytes": size,
                        "body": b"".join(chunks) if "json" in r.headers.get("content-type", "") else b""}
        except httpx.HTTPError as e:
            return {"status": -1, "error": type(e).__name__, "ttfb_ms": None, "total_ms": round((time.perf_counter() - t0) * 1000, 1), "bytes": 0, "body": b""}


def count_of(body: bytes):
    """How many things a JSON answer holds (for a sanity comparison of the two servers)."""
    try:
        j = json.loads(body)
    except ValueError:
        return None
    if isinstance(j, list):
        return len(j)
    if isinstance(j, dict):
        for k in ("count", "annotations"):
            if k in j:
                return j[k] if isinstance(j[k], int) else len(j[k])
        if "results" in j:
            return len(j["results"])
    return None


def run_scenarios(servers: list[Server], scenarios: list[dict], reps: int, log) -> list[dict]:
    results = []
    for n, sc in enumerate(scenarios):
        order = servers if n % 2 == 0 else servers[::-1]  # who goes first alternates
        per = {s.name: [] for s in servers}
        for rep in range(sc.get("reps", reps)):
            for s in (order if rep % 2 == 0 else order[::-1]):
                if sc["mode"] == "session" and not s.session_ok:
                    per[s.name].append({"status": -2, "error": "no session", "ttfb_ms": None, "total_ms": None, "bytes": 0})
                    continue
                r = s.get(sc["mode"], sc["url"], sc.get("params"))
                r["count"] = count_of(r.pop("body")) if sc.get("count") else None
                per[s.name].append(r)
                time.sleep(PAUSE)
        row = {"name": sc["name"], "mode": sc["mode"], "url": sc["url"], "runs": per}
        results.append(row)
        log(row)
    return results


def summary(servers: list[Server], rows: list[dict]) -> list[tuple]:
    out = []
    for row in rows:
        cells = {}
        for s in servers:
            runs = row["runs"][s.name]
            ok = [r for r in runs if r["status"] == 200]
            cold = ok[0]["total_ms"] if ok and runs[0]["status"] == 200 else None
            warm_runs = [r["total_ms"] for r in runs[1:] if r["status"] == 200]
            cells[s.name] = {
                "cold": cold,
                "warm": statistics.median(warm_runs) if warm_runs else None,
                "status": sorted({r["status"] for r in runs}),
                "bytes": ok[0]["bytes"] if ok else None,
                "count": ok[0].get("count") if ok else None,
            }
        out.append((row["name"], row["mode"], cells))
    return out


def fmt(v):
    return "-" if v is None else (f"{v:,.0f}" if v >= 100 else f"{v:.1f}")


def print_table(servers: list[Server], summ: list[tuple]) -> None:
    a, b = servers[0].name, servers[1].name
    print(f"\n{'scenario':<46}{'mode':<8} {a + ' cold':>11}{a + ' warm':>11} {b + ' cold':>11}{b + ' warm':>11}  {'x warm':>7}  status / note")
    for name, mode, cells in summ:
        ca, cb = cells[a], cells[b]
        ratio = f"{ca['warm'] / cb['warm']:.1f}x" if ca["warm"] and cb["warm"] else "-"
        notes = []
        if ca["status"] != [200] or cb["status"] != [200]:
            notes.append(f"{a}:{ca['status']} {b}:{cb['status']}")
        if ca["count"] is not None and cb["count"] is not None and ca["count"] != cb["count"]:
            notes.append(f"counts differ {ca['count']} vs {cb['count']}")
        print(f"{name:<46}{mode:<8} {fmt(ca['cold']):>11}{fmt(ca['warm']):>11} {fmt(cb['cold']):>11}{fmt(cb['warm']):>11}  {ratio:>7}  {'; '.join(notes)}")
    print(f"\n(milliseconds to the last byte; 'x warm' = {a} warm / {b} warm, above 1 means {b} is faster)")


def discover(prod: Server, max_images: int) -> list[dict]:
    images, off = [], 0
    while len(images) < max_images:
        r = prod.basic.get("/api/v1/images/images/", params={"limit": 100, "offset": off, "omit": "annotations"})
        if r.status_code != 200:
            break
        j = r.json()
        images += j["results"]
        if not j.get("next"):
            break
        off += 100
    return images


def pick_per_format(images: list[dict], per: int) -> list[dict]:
    chosen = []
    for ext in FORMATS:
        of = [i for i in images if i["name"].rsplit(".", 1)[-1].lower() == ext and i.get("width") and i.get("height")]
        of.sort(key=lambda i: i["id"])
        step = max(1, len(of) // per)
        chosen += of[::step][:per]
    return chosen


def slide_scenarios(images: list[dict]) -> list[dict]:
    sc = []
    for im in images:
        iid, w, h = im["id"], im["width"], im["height"]
        ext = im["name"].rsplit(".", 1)[-1].lower()
        top = math.ceil(math.log2(max(w, h, 1)))
        tag = f"{ext} #{iid}"
        sc.append({"name": f"slide info (DZI) {tag}", "mode": "session", "url": f"/images/image/{iid}/1/0/tile/", "reps": 3})
        for label, level in (("tile full-res", top), ("tile low-res", max(top - 6, 0))):
            n = 2 ** (top - level)
            col, row = math.ceil(w / n / 254) // 2, math.ceil(h / n / 254) // 2
            sc.append({"name": f"{label} {tag}", "mode": "session", "url": f"/images/image/{iid}/1/0/tile_files/{level}/{col}_{row}.jpeg", "reps": 3})
        sc.append({"name": f"thumbnail {tag}", "mode": "session", "url": f"/api/v1/images/images/{iid}/thumbnail/", "reps": 3})
    return sc


def load_phase(servers: list[Server], urls: list[str], levels: list[int], seconds: float) -> list[dict]:
    """N clients per server, one server after the other, each looping over `urls`; throughput and latency."""
    out = []
    for n in levels:
        for s in servers:
            if not s.session_ok:
                continue
            lat, errors = [], 0
            stop = time.time() + seconds

            def worker(i):
                nonlocal errors
                mine, k = [], i
                while time.time() < stop:
                    r = s.get("session", urls[k % len(urls)])
                    k += 1
                    if r["status"] == 200:
                        mine.append(r["total_ms"])
                    else:
                        errors += 1
                return mine

            t0 = time.time()
            with ThreadPoolExecutor(max_workers=n) as pool:
                for part in pool.map(worker, range(n)):
                    lat += part
            took = time.time() - t0
            lat.sort()
            out.append({"server": s.name, "clients": n, "requests": len(lat), "errors": errors, "per_second": round(len(lat) / took, 1),
                        "median_ms": round(statistics.median(lat), 1) if lat else None, "p95_ms": round(lat[int(len(lat) * 0.95) - 1], 1) if len(lat) > 20 else None})
            print(f"  {s.name:<5} {n:>2} clients: {out[-1]['per_second']:>6} requests/s, median {out[-1]['median_ms']} ms, p95 {out[-1]['p95_ms']} ms, {errors} errors", flush=True)
            time.sleep(5)  # let the server settle before the other one
    return out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--env", default=str(HERE.parents[1] / ".exact-perf.env"))
    ap.add_argument("--reps", type=int, default=5, help="repeats of the list scenarios (the first one is the cold one)")
    ap.add_argument("--annotation-images", default="1702", help="ids of images with very many annotations (comma separated, '' for none)")
    ap.add_argument("--per-format", type=int, default=2, help="images per file format for the slide scenarios")
    ap.add_argument("--max-images", type=int, default=800, help="how many images to look at when picking")
    ap.add_argument("--skip-slides", action="store_true")
    ap.add_argument("--skip-annotations", action="store_true")
    ap.add_argument("--concurrency", default="", help="load phase: clients per server, e.g. 4,8 (ASK FIRST for the production server)")
    ap.add_argument("--seconds", type=float, default=20, help="length of each load step")
    ap.add_argument("--timeout", type=float, default=180)
    a = ap.parse_args()

    env = read_env(pathlib.Path(a.env))
    servers = [Server("prod", env["PROD_URL"], env["PROD_USER"], env["PROD_PASSWORD"], a.timeout),
               Server("beta", env["BETA_URL"], env["BETA_USER"], env["BETA_PASSWORD"], a.timeout)]
    for s in servers:
        s.login()
        probe = s.basic.get("/api/v1/images/image_sets/", params={"limit": 1})
        print(f"{s.name}: {s.base}  ({s.kind}), basic login {'ok' if probe.status_code == 200 else 'FAILED ' + str(probe.status_code)}, session {'ok' if s.session_ok else 'not available'}", flush=True)
        if probe.status_code != 200:
            sys.exit(f"cannot log in to {s.name}: check the credentials in {a.env}")

    scenarios = []
    for mode in ("basic", "session"):
        scenarios += [
            {"name": "image sets (limit 100)", "mode": mode, "url": "/api/v1/images/image_sets/", "params": {"limit": 100}, "count": True},
            {"name": "images (limit 100, no annotations)", "mode": mode, "url": "/api/v1/images/images/", "params": {"limit": 100, "omit": "annotations"}, "count": True},
            {"name": "teams", "mode": mode, "url": "/api/v1/users/teams/", "params": {"limit": 100}, "count": True},
        ]
    if not a.skip_annotations:
        for iid in [x for x in a.annotation_images.split(",") if x.strip()]:
            scenarios.append({"name": f"all annotations of image {iid}", "mode": "basic", "url": "/annotations/api/annotation/load/", "params": {"image_id": iid}, "count": True, "reps": 2})
    picked = []
    if not a.skip_slides:
        images = discover(servers[0], a.max_images)
        picked = pick_per_format(images, a.per_format)
        print(f"{len(images)} images visible to the production account; {len(picked)} picked for the slide scenarios: "
              + ", ".join(sorted({p['name'].rsplit('.', 1)[-1].lower() for p in picked})), flush=True)
        scenarios += slide_scenarios(picked)

    print(f"{len(scenarios)} scenarios, one request at a time, the servers alternating\n", flush=True)
    done = []

    def log(row):
        done.append(row)
        w = {s.name: [r['total_ms'] for r in row['runs'][s.name] if r['status'] == 200] for s in servers}
        print(f"  {len(done):>3}/{len(scenarios)} {row['name'][:48]:<48} {row['mode']:<7} " + "  ".join(f"{k} {fmt(v[0]) if v else 'FAIL'}" for k, v in w.items()), flush=True)

    rows = run_scenarios(servers, scenarios, a.reps, log)
    summ = summary(servers, rows)
    print_table(servers, summ)

    load = []
    if a.concurrency.strip():
        urls = ["/api/v1/images/images/?limit=100&omit=annotations", "/api/v1/images/image_sets/?limit=100"]
        urls += [s["url"] for s in scenarios if s["name"].startswith("tile low-res")][:6]
        print("\nload phase:", flush=True)
        load = load_phase(servers, urls, [int(x) for x in a.concurrency.split(",")], a.seconds)

    out = HERE / "reports" / "local"
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"compare-{datetime.datetime.now():%Y%m%d-%H%M}.json"
    path.write_text(json.dumps({"servers": {s.name: {"base": s.base, "kind": s.kind} for s in servers}, "summary": summ, "rows": rows, "load": load}, indent=1, default=str))
    print(f"\nfull report: {path}")


if __name__ == "__main__":
    main()
