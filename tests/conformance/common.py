"""Shared helpers for the black-box conformance suite (works against any EXACT-compatible server)."""
import json, os, re
import httpx

BASE = os.environ.get("EXACT_URL", "http://127.0.0.1:8001").rstrip("/")
PW = os.environ.get("EXACT_TEST_PW", "rust-test-pw")
USERS = ["aubreville", "brummel", "rt_teamadmin", "rt_member", "rt_outsider"]

# Fields whose values legitimately differ between runs/servers.
VOLATILE = {"time", "last_edit_time", "created_time", "updated_time", "eta_time", "completed_time",
            "last_login", "date_joined", "last_modified", "unixtime", "creation_date"}


def client(user: str) -> httpx.Client:
    return httpx.Client(base_url=BASE, auth=(user, PW), timeout=60, follow_redirects=False)


# Django returns related-id lists in database order (no ORDER BY); compare them as sets.
UNORDERED_ID_LISTS = {"team_set", "members", "memberships", "image_sets", "product_set", "FrameDescriptions", "annotations",
                      "uploaded_media_files", "annotationversion_set", "images", "set_tags", "imagesets", "annotationtype_set",
                      "products", "results", "entries", "annotation_results", "bitmap_results"}


def normalize(o):
    """Strip volatile fields and host prefixes so responses from different servers compare."""
    if isinstance(o, dict):
        out = {}
        for k, v in sorted(o.items()):
            if k in VOLATILE:
                continue
            v = normalize(v)
            # list endpoints without an ORDER BY in Django come back in physical order; Rust uses id order
            # lists of objects are compared as sets: Django leaves many of them in unspecified (physical) order
            if isinstance(v, list) and v and all(isinstance(x, dict) and "id" in x for x in v):
                v = sorted(v, key=lambda x: x["id"])
            if k in UNORDERED_ID_LISTS and isinstance(v, list):
                v = sorted(v, key=lambda x: (x["id"] if isinstance(x, dict) and "id" in x else json.dumps(x, sort_keys=True) if isinstance(x, dict) else x))
            out[k] = v
        return out
    if isinstance(o, list):
        items = [normalize(v) for v in o]
        if items and all(isinstance(x, dict) and "id" in x for x in items):
            items.sort(key=lambda x: x["id"])  # top-level lists (legacy endpoints) are unordered in Django too
        return items
    if isinstance(o, float):
        if abs(o) < 1e-9:
            return 0.0  # numerical noise around zero differs between LAPACK and nalgebra
        return float(f"{o:.6g}")  # LAPACK vs nalgebra (ill-conditioned 3x3 pinv) differ around 1e-8
    if isinstance(o, str):
        return re.sub(r"https?://[^/\"]+", "", o)
    return o


def collections():
    """List endpoints of the versioned API that exact-sync uses (read-only)."""
    return [
        "users/users", "users/teams", "users/team_membership",
        "images/images", "images/image_sets", "images/set_tags", "images/set_versions",
        "images/screening_modes", "images/registration",
        "annotations/annotations", "annotations/annotation_types", "annotations/annotation_versions",
        "annotations/annotation_media_files", "annotations/verifications", "annotations/log_image_actions",
        "administration/products",
        "processing/plugins", "processing/pluginjobs", "processing/pluginresults",
        "processing/pluginresultentrys", "processing/pluginresultannotations", "processing/pluginresultbitmaps",
    ]


def endpoints(c: httpx.Client):
    """Yield (name, path, params) for every read-only call in the compat surface (see PLAN.md §2a)."""
    for col in collections():
        yield f"v1/{col}/list", f"/api/v1/{col}/", {"limit": 1000000}  # everything: Django has no ORDER BY on some lists
        r = c.get(f"/api/v1/{col}/", params={"limit": 1})
        if r.status_code == 200 and r.json().get("results"):
            first = r.json()["results"][0]["id"]
            yield f"v1/{col}/detail", f"/api/v1/{col}/{first}/", {}
    yield "legacy/list_imagesets", "/images/api/list_imagesets/", {}
    yield "legacy/timesync", "/timesync/", {}
    yield "legacy/loadannotationtypes", "/annotations/api/annotation/loadannotationtypes/", {}
    r = c.get("/api/v1/images/images/", params={"limit": 3})
    if r.status_code == 200:
        for img in r.json().get("results", []):
            yield f"legacy/annotation_load/{img['id']}", "/annotations/api/annotation/load/", {"image_id": img["id"]}
            yield f"v1/images/{img['id']}/slide_information", f"/api/v1/images/images/{img['id']}/slide_information/", {}
    r = c.get("/api/v1/images/image_sets/", params={"limit": 3})
    if r.status_code == 200:
        for s in r.json().get("results", []):
            yield f"legacy/imageset_load/{s['id']}", "/images/api/imageset/load/", {"image_set_id": s["id"]}


def fetch(c: httpx.Client, path: str, params: dict):
    r = c.get(path, params=params)
    try:
        body = normalize(r.json())
    except Exception:
        body = {"_non_json_len": len(r.content)}
    return {"status": r.status_code, "body": body}
