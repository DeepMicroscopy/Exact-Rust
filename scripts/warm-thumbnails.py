#!/usr/bin/env python3
"""Renders the thumbnails of a server ahead of time, a few at a time, so that the first look at a team's image sets is not the one that waits.

  scripts/warm-thumbnails.py --url https://exact.example.org --user NAME [--password ... | EXACT_PASSWORD] [--jobs 3] [--all-images]

By default only the cover of every image set (its first image) is rendered: what the overview of a team shows. --all-images renders every
image's thumbnail (the image set pages). The server keeps a limit of its own (EXACT_THUMBNAIL_JOBS); --jobs is how many requests this script
has open. Already rendered thumbnails answer at once. Stop with Ctrl+C: what is done stays done. Needs `requests`.
"""
import argparse
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", required=True)
    ap.add_argument("--user", required=True)
    ap.add_argument("--password", default=os.environ.get("EXACT_PASSWORD"))
    ap.add_argument("--jobs", type=int, default=3, help="requests at a time (default 3)")
    ap.add_argument("--all-images", action="store_true", help="every image, not only the cover of each image set")
    ap.add_argument("--team", type=int, action="append", help="only image sets of this team id (repeatable)")
    ap.add_argument("--timeout", type=int, default=300, help="seconds to wait for one thumbnail (default 300)")
    a = ap.parse_args()
    if not a.password:
        sys.exit("a password: --password or the environment variable EXACT_PASSWORD")
    base = a.url.rstrip("/")
    s = requests.Session()
    r = s.post(f"{base}/api/v2/auth/login", json={"username": a.user, "password": a.password}, timeout=60)
    r.raise_for_status()

    ids, cursor = [], None
    while True:
        params = {"fields": "id,team,images", "limit": 500}
        if cursor:
            params["cursor"] = cursor
        if a.team:
            params["team"] = a.team
        page = s.get(f"{base}/api/v2/image-sets", params=params, timeout=120).json()
        for st in page["items"]:
            if st["images"]:
                ids.extend(st["images"] if a.all_images else st["images"][:1])
        cursor = page.get("next_cursor")
        if not cursor:
            break
    print(f"{len(ids)} thumbnails to look at", flush=True)

    t0, done, fresh, failed = time.time(), 0, 0, 0

    def one(i):
        t = time.time()
        try:
            r = s.get(f"{base}/api/v2/images/{i}/thumbnail", timeout=a.timeout)
            return i, r.status_code, time.time() - t
        except requests.RequestException as e:
            return i, str(e), time.time() - t

    with ThreadPoolExecutor(max_workers=max(1, a.jobs)) as pool:
        for i, status, took in pool.map(one, ids):
            done += 1
            if status != 200:
                failed += 1
                print(f"  image {i}: {status}", flush=True)
            elif took > 0.5:
                fresh += 1
            if done % 50 == 0 or done == len(ids):
                rate = done / max(1e-9, time.time() - t0)
                print(f"{done}/{len(ids)}  ({fresh} rendered now, {failed} failed, {rate:.1f}/s)", flush=True)


if __name__ == "__main__":
    main()
