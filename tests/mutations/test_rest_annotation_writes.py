"""REST v1 annotation writes (POST single/list, PUT, PATCH, DELETE, multiple_delete, count): Rust must answer like Django."""
import json

from parity import normalize, sides
from test_annotation_writes import STATE

R = "/api/v1/annotations/annotations"
BB = {"x1": 10, "y1": 20, "x2": 60, "y2": 90}
U1 = "11111111-1111-4111-8111-111111111111"
U2 = "22222222-2222-4222-8222-222222222222"


def steps(ctx):
    a = lambda label: (ctx[label][1] or {}).get("id", 99999999) if isinstance(ctx[label][1], dict) else 99999999  # noqa: E731
    ids = lambda label: [x.get("id") for x in ctx[label][1]] if isinstance(ctx[label][1], list) else []  # noqa: E731
    yield "create", "rt_member", "POST", f"{R}/", {"image": 2, "annotation_type": 1, "vector": BB, "unique_identifier": U1, "deleted": False}
    yield "create again same uuid", "rt_member", "POST", f"{R}/", {"image": 2, "annotation_type": 1, "vector": {"x1": 1, "y1": 2, "x2": 30, "y2": 40}, "unique_identifier": U1, "deleted": False}
    yield "create other type same uuid", "rt_member", "POST", f"{R}/", {"image": 2, "annotation_type": 4, "vector": BB, "unique_identifier": U1, "deleted": False}
    yield "create fixed type switch", "rt_member", "POST", f"{R}/", {"image": 2, "annotation_type": 5, "vector": BB, "unique_identifier": U1, "deleted": False}
    yield "create with times", "rt_member", "POST", f"{R}/", {"image": 2, "annotation_type": 1, "vector": BB, "unique_identifier": U2, "deleted": False, "description": "x", "meta_data": {"a": 1}, "time": "2024-01-02T03:04:05.123456", "last_edit_time": "2024-02-03T04:05:06.000007"}
    yield "create missing image", "rt_member", "POST", f"{R}/", {"annotation_type": 1, "vector": BB, "unique_identifier": "33333333-3333-4333-8333-333333333333"}
    yield "create bad pk", "rt_member", "POST", f"{R}/", {"image": 99999, "annotation_type": "x", "unique_identifier": "33333333-3333-4333-8333-333333333333"}
    yield "create bad uuid", "rt_member", "POST", f"{R}/", {"image": 2, "annotation_type": 1, "unique_identifier": "nope"}
    yield "create bad deleted", "rt_member", "POST", f"{R}/", {"image": 2, "annotation_type": 1, "unique_identifier": "33333333-3333-4333-8333-333333333333", "deleted": "maybe"}
    yield "create null vector", "rt_member", "POST", f"{R}/", {"image": 2, "annotation_type": 1, "vector": None, "unique_identifier": "44444444-4444-4444-8444-444444444444", "deleted": False}
    yield "create list", "rt_member", "POST", f"{R}/", [
        {"image": 2, "annotation_type": 1, "vector": BB, "unique_identifier": "55555555-5555-4555-8555-555555555555"},
        {"image": 2, "annotation_type": 4, "vector": {"x1": 1, "y1": 2, "x2": 3, "y2": 4, "x3": 5, "y3": 9}, "description": "p", "deleted": True},
    ]
    yield "create not a dict", "rt_member", "POST", f"{R}/", "text"
    yield "patch", "rt_member", "PATCH", f"{R}/{a('create')}/", {"vector": {"x1": 11, "y1": 21, "x2": 71, "y2": 91}, "description": "patched"}
    yield "patch convert", "rt_member", "PATCH", f"{R}/{a('create')}/", {"annotation_type": 5}
    yield "patch bad convert", "rt_member", "PATCH", f"{R}/{a('create')}/", {"annotation_type": 4}
    yield "patch null desc", "rt_member", "PATCH", f"{R}/{a('create')}/", {"description": None}
    yield "patch last_editor", "rt_member", "PATCH", f"{R}/{a('create')}/", {"last_editor": 1}
    yield "patch ignores times", "rt_member", "PATCH", f"{R}/{a('create')}/", {"time": "2020-01-01T00:00:00.000000"}
    yield "put", "rt_member", "PUT", f"{R}/{a('create')}/", {"image": 2, "annotation_type": 1, "vector": BB, "deleted": True, "last_edit_time": "2024-05-06T07:08:09.000010"}
    yield "put incomplete", "rt_member", "PUT", f"{R}/{a('create')}/", {"vector": BB}
    yield "patch outsider", "rt_outsider", "PATCH", f"{R}/{a('create')}/", {"description": "no"}
    yield "patch missing", "rt_member", "PATCH", f"{R}/99999999/", {"description": "no"}
    yield "count", "rt_member", "GET", f"{R}/count/", None
    yield "count filtered", "rt_member", "GET", f"{R}/count/?image=2&deleted=False", None
    yield "delete outsider", "rt_outsider", "DELETE", f"{R}/{a('create with times')}/", None
    yield "delete", "rt_member", "DELETE", f"{R}/{a('create with times')}/", None
    yield "delete again", "rt_member", "DELETE", f"{R}/{a('create with times')}/", None
    yield "multiple delete no param", "rt_member", "DELETE", f"{R}/multiple_delete/", None
    yield "multiple delete", "rt_member", "DELETE", f"{R}/multiple_delete/?id__in={','.join(map(str, ids('create list')))}", None
    yield "multiple delete foreign", "rt_outsider", "DELETE", f"{R}/multiple_delete/?id__in={a('create')}", None
    yield "get after", "rt_member", "GET", f"{R}/{a('create')}/", None
    yield "anonymous create", "nobody", "POST", f"{R}/", {"image": 2, "annotation_type": 1}


def run(side):
    ctx, out = {}, []
    for label, user, method, path, body in steps(ctx):
        r = side.request(user, method, path, body)
        ctx[label] = r
        out.append((label, r[0], normalize(r[1])))
    return out, [side.rows(q) for q in STATE]


def test_rest_annotation_writes_match_django():
    d, r = sides()
    (dres, dstate), (rres, rstate) = run(d), run(r)
    diffs = [f"{a[0]}: django {a[1:]!r}\n    rust   {b[1:]!r}" for a, b in zip(dres, rres) if a != b]
    for i, (a, b) in enumerate(zip(dstate, rstate)):
        if a != b:
            diffs.append(f"state {i}: django {json.dumps(a)[:900]}\n    rust {json.dumps(b)[:900]}")
    assert not diffs, "\n" + "\n".join(diffs)
