"""Segmentation masks: PNG tiles per annotation, axial storage with derived coronal / sagittal planes (Rust only)."""
import io
import uuid

import httpx
import pytest
from common import BASE
from test_v2_registration import client

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

NIFTI, SET, SEG_TYPE, SEG_PRODUCT = 80, 1, 2, 2  # CT_Philips.nii.gz: 185 x 232 pixels, 256 slices


def png(rects):
    from PIL import Image
    im = Image.new("RGB", (256, 256), (0, 0, 0))
    for (r0, r1, c0, c1) in rects:
        for r in range(r0, r1):
            for c in range(c0, c1):
                im.putpixel((c, r), (255, 0, 0))
    b = io.BytesIO()
    im.save(b, format="PNG")
    return b.getvalue()


def mask_of(content):
    from PIL import Image
    im = Image.open(io.BytesIO(content)).convert("L")
    return [[im.getpixel((c, r)) > 127 for c in range(256)] for r in range(256)]


@pytest.fixture()
def seg():
    c = client("aubreville")
    c.put(f"/api/v2/image-sets/{SET}/products/{SEG_PRODUCT}")
    made = c.post("/api/v2/annotations", json={"image": NIFTI, "annotation_type": SEG_TYPE, "vector": {"tile_size": 256, "width": 185, "height": 232}, "unique_identifier": str(uuid.uuid4())})
    assert made.status_code == 201, made.text
    aid = made.json()["id"]
    yield c, aid
    c.delete(f"/api/v2/annotations/{aid}")
    c.delete(f"/api/v2/image-sets/{SET}/products/{SEG_PRODUCT}")


def tile(aid, plane, tx, ty, **q):
    extra = "".join(f"&{k}={v}" for k, v in q.items())
    return f"/api/v2/segmentation/{aid}/tiles/{plane}/{tx}/{ty}?x=1{extra}"


def test_axial_tiles_round_trip_and_the_other_planes_are_derived(seg):
    c, aid = seg
    # axial slice 10: a block at rows 20..29, columns 40..59
    assert c.get(tile(aid, 0, 0, 0, frame=10)).status_code == 204
    assert c.put(tile(aid, 0, 0, 0, frame=10), content=png([(20, 30, 40, 60)])).status_code == 204
    got = c.get(tile(aid, 0, 0, 0, frame=10))
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    m = mask_of(got.content)
    assert m[25][50] and not m[19][50] and not m[25][39]
    assert c.get(tile(aid, 0, 0, 0, frame=11)).status_code == 204
    # coronal plane at axial row 25 (y voxel 206 of 232: frame = voxel - 1): the block is at z = 10, plane row 255 - 10
    cor = c.get(tile(aid, 1, 0, 0, frame=205))
    assert cor.status_code == 200
    m = mask_of(cor.content)
    assert m[245][50] and m[245][40] and not m[245][60] and not m[244][50]
    assert c.get(tile(aid, 1, 0, 0, frame=100)).status_code == 204  # another y: empty
    # sagittal plane at axial column 40 (x voxel 144 of 185): columns of the tile are axial rows
    sag = c.get(tile(aid, 2, 0, 0, frame=143))
    assert sag.status_code == 200
    m = mask_of(sag.content)
    assert m[245][25] and m[245][20] and not m[245][30] and not m[245][19]
    # the index lists the axial tiles of a slice
    assert c.get(f"/api/v2/segmentation/{aid}/tiles?frame=10").json() == {"tiles": [[0, 0]]}
    assert c.get(f"/api/v2/segmentation/{aid}/tiles?frame=11").json() == {"tiles": []}
    # drawing in the coronal plane writes through to the axial slices: one row at z = 155
    assert c.put(tile(aid, 1, 0, 0, frame=205), content=png([(100, 101, 5, 10)])).status_code == 204
    assert mask_of(c.get(tile(aid, 0, 0, 0, frame=155)).content)[25][7]
    block = mask_of(c.get(tile(aid, 0, 0, 0, frame=10)).content)
    assert not block[25][50] and block[24][50]  # the written plane row replaced axial row 25 of the slices it covers
    # an empty tile (all black) removes the axial tile of that slice
    assert c.put(tile(aid, 1, 0, 0, frame=205), content=png([])).status_code == 204
    assert c.get(tile(aid, 0, 0, 0, frame=155)).status_code == 204
    # delete (axial)
    assert c.delete(tile(aid, 0, 0, 0, frame=10)).status_code == 204
    assert c.get(tile(aid, 0, 0, 0, frame=10)).status_code == 204


def test_rules_and_permissions(seg):
    c, aid = seg
    assert c.put(tile(aid, 0, 0, 0, frame=1), content=b"").status_code == 400
    assert c.put(tile(aid, 0, 0, 0, frame=1), content=b"not a png").status_code == 400
    assert c.put(tile(aid, 1, 0, 0, frame=1), content=png([]).replace(b"\x00\x00\x01\x00", b"\x00\x00\x00\x80", 1)).status_code in (204, 400)
    # not a segmentation annotation
    other = c.post("/api/v2/annotations", json={"image": NIFTI, "annotation_type": 1, "vector": {"x1": 1, "y1": 1, "x2": 5, "y2": 5}, "unique_identifier": str(uuid.uuid4())})
    if other.status_code == 201:
        assert c.get(tile(other.json()["id"], 0, 0, 0)).status_code == 400
        c.delete(f"/api/v2/annotations/{other.json()['id']}")
    assert client("rt_outsider").get(tile(aid, 0, 0, 0)).status_code == 404
    assert client("rt_outsider").put(tile(aid, 0, 0, 0), content=png([])).status_code == 404
    assert c.get(tile(999999, 0, 0, 0)).status_code == 404
    # the old path works as well
    assert c.get(f"/annotations/api/segmentation/{aid}/tiles/0/0/0/?frame=3").status_code == 204
