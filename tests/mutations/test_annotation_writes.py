"""Legacy annotation write endpoints: Rust must answer like Django and leave the same rows behind."""
import json

import pytest

from parity import normalize, sides

C = "/annotations/api/annotation"
BB = {"x1": 10, "y1": 20, "x2": 60, "y2": 90}


def steps(ctx):
    """(label, user, method, path, body); ctx maps labels of earlier steps to their response bodies."""
    a = lambda label: (ctx[label][1].get("annotations") or {}).get("id", 99999999)  # noqa: E731
    yield "create bbox", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 1, "vector": BB, "tempid": "t1"}
    yield "create floats", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 1, "vector": {"x1": 10.7, "y1": 20.2, "x2": 60.9, "y2": 90.1}}
    yield "create degenerate", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 1, "vector": {"x1": 10, "y1": 20, "x2": 10, "y2": 90}}
    yield "create polygon short", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 4, "vector": {"x1": 1, "y1": 2, "x2": 3, "y2": 4}}
    yield "create polygon", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 4, "vector": {"x1": 1, "y1": 2, "x2": 30, "y2": 4, "x3": 20, "y3": 40}}
    yield "create fixed", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 5, "vector": BB, "blurred": True, "concealed": True, "description": "d"}
    yield "create missing key", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "vector": BB}
    yield "create no image", "rt_member", "POST", f"{C}/create/", {"image_id": 99999, "annotation_type_id": 1, "vector": BB}
    yield "create no type", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 99999, "vector": BB}
    yield "create outsider", "rt_outsider", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 1, "vector": BB}
    yield "create anonymous-ish bad auth", "nobody", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 1, "vector": BB}
    yield "create null vector type", "rt_member", "POST", f"{C}/create/", {"image_id": 2, "annotation_type_id": 1, "vector": None}
    yield "update ok", "rt_member", "POST", f"{C}/update/", {"annotation_id": a("create bbox"), "annotation_type_id": 1, "vector": {"x1": 11, "y1": 21, "x2": 70, "y2": 95}}
    yield "update bad vector", "rt_member", "POST", f"{C}/update/", {"annotation_id": a("create bbox"), "annotation_type_id": 1, "vector": {"x1": 11}}
    yield "update foreign", "rt_outsider", "POST", f"{C}/update/", {"annotation_id": a("create bbox"), "annotation_type_id": 1, "vector": BB}
    yield "verify", "session:rt_teamadmin", "POST", f"{C}/verify/", {"annotation_id": a("create bbox"), "state": "accept"}
    yield "verify again", "session:rt_teamadmin", "POST", f"{C}/verify/", {"annotation_id": a("create bbox"), "state": "accept"}
    yield "unverify", "session:rt_teamadmin", "POST", f"{C}/verify/", {"annotation_id": a("create bbox"), "state": "reject"}
    yield "verify outsider", "session:rt_outsider", "POST", f"{C}/verify/", {"annotation_id": a("create bbox"), "state": "accept"}
    yield "blurred", "session:rt_member", "POST", f"{C}/blurred_concealed/", {"annotation_id": a("create bbox"), "blurred": True, "concealed": False}
    yield "delete outsider", "rt_outsider", "DELETE", f"{C}/delete/", {"annotation_id": a("create floats")}
    yield "delete keep", "rt_member", "DELETE", f"{C}/delete/", {"annotation_id": a("create floats"), "keep_deleted_element": "true"}
    yield "delete hard", "rt_member", "DELETE", f"{C}/delete/", {"annotation_id": a("create fixed")}
    yield "delete missing", "rt_member", "DELETE", f"{C}/delete/", {"annotation_id": 99999999}
    yield "delete versioned", "rt_teamadmin", "DELETE", f"{C}/delete/", {"annotation_id": 1}


STATE = [
    "select id, image_id, annotation_type_id, user_id, last_editor_id, vector, _blurred, _concealed, deleted, description, meta_data from annotations_annotation order by id",
    "select annotation_id, user_id, verified from annotations_verification order by annotation_id, user_id",
]


def run(side):
    ctx, out = {}, []
    for label, user, method, path, body in steps(ctx):
        r = side.request(user, method, path, body)
        ctx[label] = r
        out.append((label, r[0], normalize(r[1])))
    return out, [side.rows(q) for q in STATE]


def test_annotation_writes_match_django():
    d, r = sides()
    (dres, dstate), (rres, rstate) = run(d), run(r)
    diffs = [f"{a[0]}: django {a[1:]!r}\n    rust   {b[1:]!r}" for a, b in zip(dres, rres) if a != b]
    for i, (a, b) in enumerate(zip(dstate, rstate)):
        if a != b:
            diffs.append(f"state {i}: django {json.dumps(a)[:600]}\n    rust {json.dumps(b)[:600]}")
    assert not diffs, "\n" + "\n".join(diffs)
