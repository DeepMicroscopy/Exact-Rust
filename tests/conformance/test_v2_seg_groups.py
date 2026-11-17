"""Groups of segmentation types: the masks of types in one group exclude each other on a volume (Rust only)."""
import uuid

import httpx
import pytest
from common import BASE
from test_v2_registration import client
from test_v2_seg3d import NIFTI, SEG_PRODUCT, SET, ops

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")


def make_type(c, name, group):
    """The types are kept between runs (a type that annotations ever used cannot be deleted): found by name, group set anew."""
    have = {t["name"]: t["id"] for t in c.get(f"/api/v2/products/{SEG_PRODUCT}/annotation-types").json()["items"]}
    body = {"name": name, "vector_type": 8, "product": SEG_PRODUCT, "color_code": "#00aa00", "seg_group": group}
    if name in have:
        r = c.patch(f"/api/v2/annotation-types/{have[name]}", json={"seg_group": group})
        assert r.status_code == 200, r.text
        return have[name]
    r = c.post("/api/v2/annotation-types", json=body)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def make_mask(c, type_id):
    r = c.post("/api/v2/annotations", json={"image": NIFTI, "annotation_type": type_id, "vector": {"tile_size": 256, "width": 185, "height": 232}, "unique_identifier": str(uuid.uuid4())})
    assert r.status_code == 201, r.text
    return r.json()["id"]


@pytest.fixture()
def trio():
    """Three masks: a and b in one group, c alone."""
    c = client("aubreville")
    c.put(f"/api/v2/image-sets/{SET}/products/{SEG_PRODUCT}")
    types = [make_type(c, "grp-a", "organs"), make_type(c, "grp-b", "organs"), make_type(c, "grp-c", None)]
    masks = [make_mask(c, t) for t in types]
    yield c, masks, types
    for m in masks:
        c.delete(f"/api/v2/annotations/{m}")


def disc(c, aid, x, y, mode="add"):
    return ops(c, aid, op="stroke", plane=0, frame=100, points=[[x, y]], radius_mm=4, mode=mode)


def count(c, aid):
    return c.get(f"/api/v2/segmentation/{aid}/volume").json()["count"]


def test_the_group_is_listed_and_stored(trio):
    c, masks, types = trio
    groups = {g["annotation_type"]: g["group"] for g in c.get("/api/v2/segmentation-groups").json()}
    assert groups[types[0]] == "organs" and groups[types[1]] == "organs" and types[2] not in groups
    shown = {t["id"]: t["seg_group"] for t in c.get(f"/api/v2/products/{SEG_PRODUCT}/annotation-types").json()["items"]}
    assert shown[types[0]] == "organs" and shown[types[2]] is None
    assert c.patch(f"/api/v2/annotation-types/{types[2]}", json={"seg_group": "x" * 51}).status_code == 400


def test_painting_over_a_mask_of_the_group_takes_the_voxels_and_undo_gives_them_back(trio):
    c, (a, b, free), _ = trio
    disc(c, a, 90.5, 120.5)
    n_a = count(c, a)
    assert n_a > 20
    # b paints over a part of a's disc: a loses exactly what b gained there
    r = disc(c, b, 96.5, 120.5)
    assert r["changed_others"] == [a]
    assert 0 < count(c, a) < n_a
    both = count(c, a) + count(c, b)
    assert both < n_a + r["count"]  # the overlap exists once, not twice
    # undo of b's stroke: b is gone and a is whole again
    u = c.post(f"/api/v2/segmentation/{b}/undo").json()
    assert u["changed_others"] == [a] and u["count"] == 0
    assert count(c, a) == n_a
    # redo takes them again
    c.post(f"/api/v2/segmentation/{b}/redo")
    assert count(c, a) < n_a and count(c, b) == r["count"]


def test_a_mask_outside_the_group_keeps_its_voxels(trio):
    c, (a, b, free), _ = trio
    disc(c, a, 90.5, 120.5)
    n_a = count(c, a)
    r = disc(c, free, 90.5, 120.5)
    assert r["changed_others"] == []
    assert count(c, a) == n_a and count(c, free) > 0


def test_erasing_changes_nobody_else(trio):
    c, (a, b, _), _ = trio
    disc(c, a, 90.5, 120.5)
    disc(c, b, 120.5, 120.5)
    n_a, n_b = count(c, a), count(c, b)
    r = disc(c, a, 90.5, 120.5, mode="remove")
    assert r["changed_others"] == [] and count(c, a) == 0 and count(c, b) == n_b and n_a > 0


def test_leaving_the_group_ends_the_exclusion(trio):
    c, (a, b, _), (ta, tb, _t) = trio
    assert c.patch(f"/api/v2/annotation-types/{tb}", json={"seg_group": ""}).status_code == 200
    disc(c, a, 90.5, 120.5)
    n_a = count(c, a)
    disc(c, b, 90.5, 120.5)
    assert count(c, a) == n_a


def test_a_type_in_use_can_be_saved_with_the_same_shape_but_not_with_another(trio):
    """The administration screen sends the whole type: the unchanged shape of a type that annotations use is no error."""
    c, masks, (ta, _tb, _tc) = trio
    r = c.patch(f"/api/v2/annotation-types/{ta}", json={"vector_type": 8, "seg_group": "airways"})
    assert r.status_code == 200, r.text
    assert c.patch(f"/api/v2/annotation-types/{ta}", json={"vector_type": 1}).status_code == 400
    c.patch(f"/api/v2/annotation-types/{ta}", json={"seg_group": "organs"})


def test_deleting_a_type_that_is_still_referenced_says_what_references_it():
    """A soft-deleted annotation does not count in the list of the type, but blocks its deletion: the answer names it and its image;
    the usage lists the places; deleting with purge_deleted removes the deleted annotations with the type, live ones still block."""
    c = client("aubreville")
    c.put(f"/api/v2/image-sets/{SET}/products/{SEG_PRODUCT}")
    t = make_type(c, "del-detail", None)
    live = make_mask(c, t)
    gone = make_mask(c, t)
    assert c.delete(f"/api/v2/annotations/{gone}").status_code in (200, 204)
    r = c.delete(f"/api/v2/annotation-types/{t}?purge_deleted=true")
    assert r.status_code == 409 and "image" in r.json()["detail"], r.text  # a live annotation blocks, purge or not
    u = c.get(f"/api/v2/annotation-types/{t}/usage").json()
    assert u["annotations"] >= 1 and u["deleted"] >= 1 and any(p["image"] == NIFTI and p["image_set_name"] for p in u["places"]), u
    assert c.delete(f"/api/v2/annotations/{live}").status_code in (200, 204)
    r = c.delete(f"/api/v2/annotation-types/{t}")
    assert r.status_code == 409, r.text
    detail = r.json()["detail"]
    assert "deleted annotations" in detail and f"image {NIFTI}" in detail and "for good" in detail, detail
    r = c.delete(f"/api/v2/annotation-types/{t}?purge_deleted=true")
    assert r.status_code == 204, r.text
    assert c.get(f"/api/v2/annotation-types/{t}/usage").status_code == 404
    assert c.get(f"/api/v2/annotations/{gone}").status_code == 404
