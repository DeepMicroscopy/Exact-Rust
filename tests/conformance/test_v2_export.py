"""Annotation exports from export formats (Rust only): creating formats, exporting an image set, the download, permissions."""
import httpx
import pytest
from common import BASE
from test_v2_registration import client

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

SET = 1


def all_items(c, path):
    out, cursor = [], None
    while True:
        r = c.get(path + ("&cursor=" + cursor if cursor else "")).json()
        out += r["items"]
        cursor = r["next_cursor"]
        if not cursor:
            return out


def test_export_formats_and_exports():
    c = client()
    types = [t["id"] for t in all_items(c, "/api/v2/annotation-types?limit=1000&fields=id")]
    fmt = c.post("/api/v2/export-formats", json={"name": "e2e pipe", "team": 1, "annotation_types": types, "base_format": "set %%imageset team %%team%%content", "annotation_format": "%%imagename|%%type|{%%vector}|%%width|%%relwidth|%%UUID"})
    assert fmt.status_code == 201, fmt.text
    fid = fmt.json()["id"]
    try:
        assert c.post("/api/v2/export-formats", json={"name": "e2e pipe", "team": 1}).status_code == 400  # name taken
        listed = c.get(f"/api/v2/image-sets/{SET}/export-formats").json()["items"]
        assert any(f["id"] == fid for f in listed)
        r = c.post(f"/api/v2/image-sets/{SET}/exports", json={"format": fid})
        assert r.status_code == 201, r.text
        ex = r.json()
        anns = [a for a in all_items(c, f"/api/v2/annotations?image__image_set={SET}&limit=1000&fields=id,deleted,annotation_type") if not a["deleted"]]
        assert ex["annotation_count"] == len(anns)
        assert ex["filename"] == f"export_{ex['id']}.txt"
        d = c.get(f"/api/v2/exports/{ex['id']}/download")
        assert d.status_code == 200 and "attachment" in d.headers["content-disposition"] and ex["filename"] in d.headers["content-disposition"]
        lines = [l for l in d.text.split("\n")[1:] if l]  # after the header line; "not in image" annotations have their own format
        assert len(lines) == len(anns)
        assert d.text.startswith("set ") and "team " in d.text.split("\n")[0]
        assert all(l.count("|") in (2, 5) for l in lines)
        assert any(e["id"] == ex["id"] for e in c.get(f"/api/v2/image-sets/{SET}/exports").json()["items"])
        # others do not get at it
        o = client("rt_outsider")
        assert o.get(f"/api/v2/exports/{ex['id']}/download").status_code in (403, 404)
        assert o.post(f"/api/v2/image-sets/{SET}/exports", json={"format": fid}).status_code in (403, 404)
        assert c.delete(f"/api/v2/exports/{ex['id']}").status_code == 204
        assert c.post(f"/api/v2/image-sets/{SET}/exports", json={"format": 999999}).status_code == 400
    finally:
        assert c.delete(f"/api/v2/export-formats/{fid}").status_code == 204
