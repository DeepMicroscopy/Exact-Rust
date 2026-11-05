"""Annotations written by one server and changed, verified and deleted by the other: both must read the same thing, and the rows must be what either
server alone would have left."""
import json
import re

from coex import BOTH, django, rust, sql

C = "/annotations/api/annotation"
R = "/api/v1/annotations/annotations"
VOLATILE = {"time", "last_edit_time", "unique_identifier", "last_modification_time"}
OK = (200, 201)  # the legacy create answers 201 on both servers, the others 200
BB = {"x1": 10, "y1": 20, "x2": 60, "y2": 90}


def norm(o):
    if isinstance(o, dict):
        return {k: norm(v) for k, v in sorted(o.items()) if k not in VOLATILE}
    if isinstance(o, list):
        return [norm(v) for v in o]
    if isinstance(o, str):
        return re.sub(r"https?://[^/]+/", "http://HOST/", o)
    return o


def read_both(aid, user="rt_member"):
    """The annotation as each server shows it; they must agree."""
    got = {}
    for s in BOTH:
        r = s.basic(user).get(f"{R}/{aid}/")
        got[s.name] = (r.status_code, norm(r.json()) if r.status_code == 200 else None)
    assert got["django"] == got["rust"], f"the servers show the annotation differently:\n{json.dumps(got, indent=1, default=str)}"
    return got["django"]


def row(aid):
    r = sql(f"select * from annotations_annotation where id = {aid}")
    return r[0] if r else None


def create(server, vector=BB, type_id=1, image=2):
    r = server.basic("rt_member").post(f"{C}/create/", json={"image_id": image, "annotation_type_id": type_id, "vector": vector})
    assert r.status_code in OK, f"{server.name}: {r.status_code} {r.text[:300]}"
    return r.json()["annotations"]["id"]


def test_create_on_one_server_change_on_the_other_and_both_always_agree():
    for first, second in ((django, rust), (rust, django)):
        aid = create(first)
        assert read_both(aid)[0] == 200
        edited = row(aid)["last_edit_time"]
        r = second.basic("rt_member").post(f"{C}/update/", json={"annotation_id": aid, "image_id": 2, "annotation_type_id": 1, "vector": {"x1": 11, "y1": 21, "x2": 70, "y2": 95}})
        assert r.status_code in OK, f"{second.name}: {r.status_code} {r.text[:300]}"
        status, body = read_both(aid)
        assert body["vector"] == {"x1": 11, "y1": 21, "x2": 70, "y2": 95}, body
        r = first.basic("rt_member").post(f"{C}/update/", json={"annotation_id": aid, "image_id": 2, "annotation_type_id": 1, "vector": {"x1": 12, "y1": 22, "x2": 72, "y2": 96}})
        assert r.status_code in OK
        assert read_both(aid)[1]["vector"]["x1"] == 12
        assert row(aid)["last_edit_time"] > edited, "last_edit_time did not move"
        assert row(aid)["last_editor_id"] is not None


def test_verify_and_flags_set_on_one_server_show_on_the_other():
    aid = create(django)
    admin = sql("select id from users_user where username = 'rt_teamadmin'")[0]["id"]
    # the verifier's own row: accepted -> verified, rejected -> not verified (or no row)
    mine = lambda: sum(1 for v in sql(f"select verified from annotations_verification where annotation_id = {aid} and user_id = {admin}") if v["verified"])  # noqa: E731
    for writer, other in ((rust, django), (django, rust)):
        r = writer.session("rt_teamadmin").post(f"{C}/verify/", json={"annotation_id": aid, "state": "accept"})
        assert r.status_code in OK, f"{writer.name}: {r.status_code} {r.text[:200]}"
        assert mine() == 1
        read_both(aid)
        r = writer.session("rt_teamadmin").post(f"{C}/verify/", json={"annotation_id": aid, "state": "reject"})
        assert r.status_code in OK
        assert mine() == 0
    # the flags are stored in the columns _blurred / _concealed (what the serializer shows is derived from them)
    for writer in (rust, django):
        for blurred, concealed in ((True, False), (False, True)):
            r = writer.session("rt_member").post(f"{C}/blurred_concealed/", json={"annotation_id": aid, "blurred": blurred, "concealed": concealed})
            assert r.status_code in OK, f"{writer.name}: {r.status_code} {r.text[:200]}"
            stored = row(aid)
            assert (stored["_blurred"], stored["_concealed"]) == (blurred, concealed), f"{writer.name} stored {stored['_blurred']}, {stored['_concealed']}"
            read_both(aid)


def test_delete_on_one_server_is_a_delete_for_the_other():
    for deleter, other in ((rust, django), (django, rust)):
        # a soft delete (the annotation is kept, marked deleted) and a hard one
        keep, hard = create(other), create(other)
        r = deleter.basic("rt_member").request("DELETE", f"{C}/delete/", params={"annotation_id": keep, "keep_deleted_element": "true"})
        assert r.status_code in OK, f"{deleter.name}: {r.status_code} {r.text[:200]}"
        assert row(keep)["deleted"] is True
        assert read_both(keep)[1]["deleted"] is True
        r = deleter.basic("rt_member").request("DELETE", f"{C}/delete/", params={"annotation_id": hard})
        assert r.status_code in OK
        assert row(hard) is None
        assert read_both(hard)[0] == 404


def test_the_rest_api_of_one_server_and_the_legacy_api_of_the_other_meet_in_the_same_rows():
    for rest_server, legacy_server in ((django, rust), (rust, django)):
        r = rest_server.basic("aubreville").post(f"{R}/", json={"image": 2, "annotation_type": 1, "vector": BB, "unique_identifier": "aaaaaaaa-1111-4111-8111-%012d" % (len(sql("select id from annotations_annotation")) + 1000)})
        assert r.status_code in (200, 201), f"{rest_server.name}: {r.status_code} {r.text[:200]}"
        aid = r.json()["id"]
        r = legacy_server.basic("rt_member").post(f"{C}/update/", json={"annotation_id": aid, "image_id": 2, "annotation_type_id": 1, "vector": {"x1": 1, "y1": 2, "x2": 30, "y2": 40}})
        assert r.status_code in OK, f"{legacy_server.name}: {r.status_code} {r.text[:200]}"
        assert read_both(aid)[1]["vector"] == {"x1": 1, "y1": 2, "x2": 30, "y2": 40}
        assert rest_server.basic("aubreville").delete(f"{R}/{aid}/").status_code in (200, 204)
        assert row(aid) is None


def test_the_lists_of_both_servers_are_the_same_after_all_of_it():
    lists = {}
    for s in BOTH:
        r = s.basic("rt_member").get(f"{R}/", params={"image": 2, "limit": 1000})
        assert r.status_code in OK
        lists[s.name] = sorted(a["id"] for a in r.json()["results"])
    assert lists["django"] == lists["rust"] and lists["django"], lists


def test_the_rest_api_answers_a_write_in_the_same_shape_on_both_servers():
    """exact-sync parses the answer of a create / update: flat, with ids for the related objects, on either server."""
    shapes = {}
    for i, s in enumerate(BOTH):
        c = s.basic("aubreville")
        uid = "dddddddd-2222-4222-8222-%012d" % (i + 1 + len(sql("select id from annotations_annotation")) * 10)
        made = c.post(f"{R}/", json={"image": 2, "annotation_type": 1, "vector": BB, "unique_identifier": uid, "deleted": False})
        assert made.status_code == 201, (s.name, made.text[:200])
        aid = made.json()["id"]
        patched = c.patch(f"{R}/{aid}/", json={"description": "x"})
        put = c.put(f"{R}/{aid}/", json={"image": 2, "annotation_type": 1, "vector": BB, "deleted": False, "annotationversion_set": [], "uploaded_media_files": []})
        many = c.post(f"{R}/", json=[{"image": 2, "annotation_type": 1, "vector": BB, "unique_identifier": uid[:-1] + "9"}])
        got = c.get(f"{R}/{aid}/")
        shapes[s.name] = {
            "create": sorted(made.json()), "patch": (patched.status_code, sorted(patched.json())), "put": (put.status_code, sorted(put.json())),
            "list create": (many.status_code, sorted(many.json()[0]) if many.status_code == 201 else many.text[:100]), "get": sorted(got.json()),
        }
        assert sorted(made.json()) == sorted(got.json()), f"{s.name}: the answer to a create is not what a GET shows"
    assert shapes["django"] == shapes["rust"], json.dumps(shapes, indent=1)


def test_both_servers_stamp_times_in_the_same_zone():
    """`time` columns have no zone: Django writes local time (settings TIME_ZONE), Rust the zone of its TIME_ZONE. When the two are configured
    differently, rows written by one are hours off for the other (and 'last edited' lists sort wrongly)."""
    from datetime import datetime

    stamps = {}
    for s in BOTH:
        aid = create(s)
        stamps[s.name] = row(aid)["time"]
    t = {k: datetime.fromisoformat(v) for k, v in stamps.items()}
    assert abs((t["django"] - t["rust"]).total_seconds()) < 60, f"the servers stamp different local times: {stamps} (set TIME_ZONE of the Rust server to Django's)"
