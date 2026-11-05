"""Both servers writing at the same moment, as they will on the same database."""
from concurrent.futures import ThreadPoolExecutor

from coex import BOTH, django, rust, sql
from test_annotations import C, OK, create

N = 40


def test_parallel_creates_on_both_servers_all_land_with_distinct_ids():
    def one(i):
        s = BOTH[i % 2]
        r = s.basic("rt_member").post(f"{C}/create/", json={"image_id": 2, "annotation_type_id": 1, "vector": {"x1": 100 + i, "y1": 20, "x2": 160 + i, "y2": 90}})
        return s.name, r.status_code, (r.json().get("annotations") or {}).get("id") if r.status_code in OK else r.text[:200]

    with ThreadPoolExecutor(12) as ex:
        out = list(ex.map(one, range(N)))
    bad = [o for o in out if o[1] not in OK]
    assert not bad, bad
    ids = [o[2] for o in out]
    assert len(set(ids)) == N, "an id was handed out twice"
    rows = sql(f"select id, vector from annotations_annotation where id in ({','.join(map(str, ids))})")
    assert len(rows) == N
    # each row is the one that was asked for (nothing crossed between the two servers' requests)
    assert sorted(r["vector"]["x1"] for r in rows) == [100 + i for i in range(N)]


def test_parallel_updates_of_one_annotation_from_both_servers_end_in_one_of_them():
    aid = create(django)
    vecs = [{"x1": 200 + i, "y1": 20, "x2": 260 + i, "y2": 90} for i in range(30)]

    def one(i):
        s = BOTH[i % 2]
        r = s.basic("rt_member").post(f"{C}/update/", json={"annotation_id": aid, "image_id": 2, "annotation_type_id": 1, "vector": vecs[i]})
        return s.name, r.status_code

    with ThreadPoolExecutor(10) as ex:
        out = list(ex.map(one, range(30)))
    assert all(o[1] in OK for o in out), [o for o in out if o[1] not in OK]
    final = sql(f"select vector from annotations_annotation where id = {aid}")[0]["vector"]
    assert final in vecs, final


def test_a_delete_racing_an_update_leaves_a_consistent_state():
    for _ in range(5):
        aid = create(rust)

        def upd():
            return django.basic("rt_member").post(f"{C}/update/", json={"annotation_id": aid, "image_id": 2, "annotation_type_id": 1, "vector": {"x1": 5, "y1": 5, "x2": 50, "y2": 50}}).status_code

        def dele():
            return rust.basic("rt_member").request("DELETE", f"{C}/delete/", params={"annotation_id": aid}).status_code

        with ThreadPoolExecutor(2) as ex:
            a, b = ex.submit(upd), ex.submit(dele)
            codes = (a.result(), b.result())
        assert all(c < 500 for c in codes), codes
        # whichever won, no orphan version rows point at nothing
        assert not sql("select 1 from annotations_annotationversion v left join annotations_annotation a on a.id = v.annotation_id where a.id is null limit 1")


def _race(servers):
    from test_files import make_set, upload
    from coex import png, unique

    sid, _ = make_set(django)
    name = unique("race") + ".png"
    data = png(300, 200, seed=9)

    def one(i):
        s = servers[i % len(servers)]
        try:
            upload(s, sid, name, data)
        except AssertionError:
            pass  # refused as a duplicate

    with ThreadPoolExecutor(6) as ex:
        list(ex.map(one, range(6)))
    return sql(f"select count(*) n from images_image where image_set_id = {sid} and name = '{name}'")[0]["n"]


def test_the_same_file_uploaded_at_once_twice_over_makes_no_more_duplicates_across_servers_than_within_one():
    # Django checks "does this image exist?" and then inserts, with no unique constraint behind it, so six simultaneous uploads of one file can
    # all get in even on Django alone. What coexistence must not do is make that worse.
    alone = max(_race([django]), _race([django]))
    both = _race([django, rust])
    assert both <= max(alone, 1), (alone, both)
    print(f"duplicates from 6 simultaneous uploads of one file: Django alone {alone}, Django + Rust {both}")
