"""Segmentation files (3D Slicer `.seg.nrrd`) linked to a NIfTI volume: upload, link, read-only slices (Rust only).

The NRRD is made here from the geometry of CT_Philips.nii.gz (nibabel), once as the volume's own axes and once with the first two
axes swapped and in LPS like Slicer writes it: both must land on the same voxels of the volume.
"""
import gzip
import io
import os
import pathlib
import uuid

import httpx
import numpy as np
import pytest
from common import BASE
from test_v2_registration import client

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

NIFTI, SET = 80, 1  # CT_Philips.nii.gz
IMAGES = pathlib.Path(os.environ.get("IMAGE_PATH", pathlib.Path(__file__).resolve().parents[2] / "reference/instance/images"))


def nrrd(swap=False, shift=(0.0, 0.0, 0.0), img=None):
    """A two-segment label volume on the grid of the NIfTI (CT_Philips unless `img` is given), and where its ball is in the volume's
    reoriented voxels."""
    import nibabel as nib

    img = img or nib.load(IMAGES / "exact_1_1" / "CT_Philips.nii.gz")
    a, shape = img.affine, img.shape[:3]
    data = np.zeros(shape, np.uint8)
    c = [s // 2 for s in shape]
    ii, jj, kk = np.indices(shape)
    data[(ii - c[0]) ** 2 + (jj - c[1]) ** 2 + (kk - c[2]) ** 2 <= 36] = 1
    q = [s // 4 for s in shape]
    data[q[0] : q[0] + 5, q[1] : q[1] + 5, q[2] : q[2] + 5] = 2
    lps = np.diag([-1.0, -1.0, 1.0])
    cols = [lps @ a[:3, i] for i in range(3)]
    origin = lps @ a[:3, 3] + np.array(shift)
    if swap:
        data, cols = data.transpose(1, 0, 2), [cols[1], cols[0], cols[2]]
    head = (
        "NRRD0004\ntype: unsigned char\ndimension: 3\nspace: left-posterior-superior\n"
        f"sizes: {' '.join(str(s) for s in data.shape)}\n"
        f"space directions: {' '.join('(' + ','.join(repr(float(v)) for v in col) + ')' for col in cols)}\n"
        "kinds: domain domain domain\nencoding: gzip\n"
        f"space origin: ({','.join(repr(float(v)) for v in origin)})\n"
        "Segment0_ID:=ball\nSegment0_Name:=Ball\nSegment0_Color:=1 0 0\nSegment0_LabelValue:=1\nSegment0_Layer:=0\n"
        "Segment1_ID:=cube\nSegment1_Name:=Cube\nSegment1_Color:=0 0 1\nSegment1_LabelValue:=2\nSegment1_Layer:=0\n\n"
    )
    ras_center = a @ np.array([*c, 1.0])
    canon = nib.as_closest_canonical(img).affine
    vox = np.rint(np.linalg.inv(canon) @ ras_center)[:3].astype(int)
    return head.encode() + gzip.compress(data.tobytes(order="F")), [int(v) for v in vox]


@pytest.fixture()
def made():
    c = client("aubreville")
    ids = []

    def make(swap=False, shift=(0.0, 0.0, 0.0), name=None):
        body, center = nrrd(swap, shift)
        name = name or f"CT_Philips segmentation_{uuid.uuid4().int % 100000}.seg.nrrd"
        r = c.post(f"/api/v2/image-sets/{SET}/images", files={"file": (name, body)})
        assert r.status_code == 201, r.text
        item = r.json()["items"][0]
        assert item["type"] == "segmentation", item
        ids.append(item["id"])
        return item["id"], center

    yield c, make
    for i in ids:
        c.delete(f"/api/v2/linked-volumes/{i}")


def alpha_pixels(c, fid, plane, frame, hide=""):
    from PIL import Image

    r = c.get(f"/api/v2/linked-volumes/{fid}/slice/{plane}/{frame}", params={"hide": hide})
    assert r.status_code == 200 and r.headers["content-type"] == "image/png", r.text
    im = Image.open(io.BytesIO(r.content)).convert("RGBA")
    return im.size, {(x, y): im.getpixel((x, y)) for y in range(im.height) for x in range(im.width) if im.getpixel((x, y))[3] > 0}


@pytest.mark.parametrize("swap", [False, True])
def test_upload_link_and_look_at_the_labels(made, swap):
    c, make = made
    fid, (cx, cy, cz) = make(swap=swap)
    f = c.get(f"/api/v2/linked-volumes/{fid}").json()
    assert f["image"] is None and [s["name"] for s in f["segments"]] == ["Ball", "Cube"]
    assert f["segments"][0]["color"] == "#ff0000" and f["segments"][0]["volume_mm3"] > 0
    # the name says which volume: Slicer's `<volume> segmentation` naming, the best match first
    assert f["volumes"][0]["id"] == NIFTI and f["volumes"][0]["score"] == 1.0
    assert c.get(f"/api/v2/linked-volumes/{fid}/slice/0/0").status_code == 409  # not linked yet

    linked = c.put(f"/api/v2/linked-volumes/{fid}", json={"image": NIFTI})
    assert linked.status_code == 200, linked.text
    assert linked.json()["geometry"]["fits"] is True and linked.json()["geometry"]["kept"] > 0.99

    # the ball is on the axial slice of its centre, at the pixel where the crosshair of that voxel would be
    size, px = alpha_pixels(c, fid, 0, cz)
    assert size[0] > 0
    reds = [p for p, v in px.items() if v[:3] == (255, 0, 0)]
    assert len(reds) > 20
    mx, my = sum(p[0] for p in reds) / len(reds), sum(p[1] for p in reds) / len(reds)
    shape = c.get(f"/api/v2/images/{NIFTI}/metadata").json()["planes"]
    nx, ny = shape[2]["frames"], shape[1]["frames"]
    assert abs(mx - (nx - 1 - cx + 0.5) / nx * size[0]) < 2 and abs(my - (ny - 1 - cy + 0.5) / ny * size[1]) < 2
    # hiding the segment removes it; the other planes show it too
    assert not [p for p, v in alpha_pixels(c, fid, 0, cz, hide="0")[1].items() if v[:3] == (255, 0, 0)]
    assert alpha_pixels(c, fid, 1, cy)[1] and alpha_pixels(c, fid, 2, cx)[1]
    assert alpha_pixels(c, fid, 0, 0)[1] == {}
    assert c.get(f"/api/v2/linked-volumes/{fid}/slice/0/9999").status_code == 400

    at = c.get(f"/api/v2/linked-volumes/{fid}/at", params={"x": cx, "y": cy, "z": cz}).json()
    assert at["segment"]["name"] == "Ball"
    assert c.get(f"/api/v2/linked-volumes/{fid}/at", params={"x": 0, "y": 0, "z": 0}).json()["segment"] is None

    # listed with the volume and in its related items
    assert [x["id"] for x in c.get(f"/api/v2/images/{NIFTI}/linked-volumes").json()] == [fid]
    assert [x["id"] for x in c.get(f"/api/v2/image-sets/{SET}/linked-volumes").json()] == [fid]
    rel = [r for r in c.get(f"/api/v2/images/{NIFTI}/related").json() if r["kind"] == "segmentation"]
    assert [(r["id"], r["name"]) for r in rel] == [(NIFTI, f["name"])]

    unlinked = c.put(f"/api/v2/linked-volumes/{fid}", json={"image": None})
    assert unlinked.status_code == 200 and unlinked.json()["image"] is None
    assert c.get(f"/api/v2/linked-volumes/{fid}/slice/0/0").status_code == 409


def test_a_segmentation_beside_the_volume_is_not_linked(made):
    c, make = made
    fid, _ = make(shift=(5000.0, 0.0, 0.0))
    r = c.put(f"/api/v2/linked-volumes/{fid}", json={"image": NIFTI})
    assert r.status_code == 422 and "outside" in r.json()["detail"]
    assert c.get(f"/api/v2/linked-volumes/{fid}").json()["image"] is None


def test_only_a_volume_of_the_same_set_and_a_nifti_can_be_linked(made):
    c, make = made
    fid, _ = make()
    other = c.get("/api/v2/images", params={"image_set": 2, "fields": "id", "limit": 1}).json()["items"][0]["id"]
    assert c.put(f"/api/v2/linked-volumes/{fid}", json={"image": other}).status_code == 400
    plain = [i["id"] for i in c.get("/api/v2/images", params={"image_set": SET, "fields": "id,filename", "limit": 200}).json()["items"] if not i["filename"].lower().endswith((".nii", ".nii.gz"))][0]
    r = c.put(f"/api/v2/linked-volumes/{fid}", json={"image": plain})
    assert r.status_code == 400 and "NIfTI" in r.json()["detail"]
    assert c.put(f"/api/v2/linked-volumes/{fid}", json={"image": 99999999}).status_code == 404


def test_a_damaged_file_is_refused_and_not_kept(made):
    c, _ = made
    name = f"bad-{uuid.uuid4().hex[:6]}.nrrd"
    r = c.post(f"/api/v2/image-sets/{SET}/images", files={"file": (name, b"NRRD0004\ntype: float\ndimension: 3\n\nxx")})
    item = r.json()["items"][0]
    assert "cannot be read" in item["error"]
    assert not (IMAGES / "exact_1_1" / name).exists()


def test_delete_removes_the_file(made):
    c, make = made
    fid, _ = make()
    f = c.get(f"/api/v2/linked-volumes/{fid}").json()
    assert (IMAGES / "exact_1_1" / f["filename"]).exists()
    assert c.get(f"/api/v2/linked-volumes/{fid}/file").content[:4] == b"NRRD"
    assert c.delete(f"/api/v2/linked-volumes/{fid}").status_code == 204
    assert c.get(f"/api/v2/linked-volumes/{fid}").status_code == 404
    assert not (IMAGES / "exact_1_1" / f["filename"]).exists()


def test_a_member_of_another_team_does_not_see_it(made):
    c, make = made
    fid, _ = make()
    o = client("rt_outsider")
    assert o.get(f"/api/v2/linked-volumes/{fid}").status_code == 404
    assert o.put(f"/api/v2/linked-volumes/{fid}", json={"image": None}).status_code == 404
    assert o.get(f"/api/v2/image-sets/{SET}/linked-volumes").status_code == 404


def test_the_card_has_a_picture_linked_or_not(made):
    c, make = made
    fid, _ = make()
    for _ in range(2):  # not linked: the labels alone; linked: over the slice of the volume
        r = c.get(f"/api/v2/linked-volumes/{fid}/thumbnail")
        assert r.status_code == 200 and r.headers["content-type"] == "image/png"
        from PIL import Image
        im = Image.open(io.BytesIO(r.content)).convert("RGB")
        assert max(im.size) <= 256 and any(px[0] > 150 and px[2] < 120 for px in im.getdata())  # the red ball is in it
        if c.put(f"/api/v2/linked-volumes/{fid}", json={"image": NIFTI}).status_code != 200:
            break
    assert c.get("/api/v2/linked-volumes/999999/thumbnail").status_code == 404


def test_a_second_upload_of_the_same_file_keeps_the_first(made):
    c, make = made
    name = f"CT_Philips segmentation_{uuid.uuid4().int % 100000}.seg.nrrd"
    fid, _ = make(name=name)
    assert c.put(f"/api/v2/linked-volumes/{fid}", json={"image": NIFTI}).status_code == 200
    again = c.post(f"/api/v2/image-sets/{SET}/images", files={"file": (name, nrrd()[0])}).json()["items"][0]
    assert "already exists" in again["error"]
    # the file the first upload owns is still there and still works
    assert (IMAGES / "exact_1_1" / name).exists()
    assert c.get(f"/api/v2/linked-volumes/{fid}/slice/0/128").status_code == 200
    # a row whose file has gone says so, with no server path in the message
    (IMAGES / "exact_1_1" / name).rename(IMAGES / "exact_1_1" / (name + ".gone"))
    try:
        c.put(f"/api/v2/linked-volumes/{fid}", json={"image": None})
        r = c.put(f"/api/v2/linked-volumes/{fid}", json={"image": NIFTI})
        assert r.status_code == 404 and "missing on the server" in r.json()["detail"] and "/" not in r.json()["detail"].replace("Delete this entry and upload the file again.", "")
    finally:
        (IMAGES / "exact_1_1" / (name + ".gone")).rename(IMAGES / "exact_1_1" / name)


def test_the_labels_for_the_3d_render(made):
    c, make = made
    fid, _ = make()
    assert c.get(f"/api/v2/linked-volumes/{fid}/render-mask").status_code == 409  # not linked
    assert c.put(f"/api/v2/linked-volumes/{fid}", json={"image": NIFTI}).status_code == 200
    r = c.get(f"/api/v2/linked-volumes/{fid}/render-mask", params={"max": 64})
    assert r.status_code == 200 and r.headers["x-channels"] == "2"
    dims = [int(v) for v in r.headers["x-dims"].split(",")]
    assert max(dims) == 64 and len(r.content) == 2 * dims[0] * dims[1] * dims[2]
    pairs = list(zip(r.content[0::2], r.content[1::2]))
    assert {seg for cov, seg in pairs if cov} == {1, 2}  # the ball and the cube, by their segment numbers
    assert all(seg == 0 for cov, seg in pairs if not cov)
    hidden = c.get(f"/api/v2/linked-volumes/{fid}/render-mask", params={"max": 64, "hide": "0"}).content
    assert {seg for cov, seg in zip(hidden[0::2], hidden[1::2]) if cov} == {2}


def tiny_volume(c):
    """A 16 x 16 x 16 NIfTI uploaded into the set, with a segmentation file linked to it: (image id, file id)."""
    import nibabel as nib

    img = nib.Nifti1Image((np.arange(16**3) % 200).astype(np.int16).reshape(16, 16, 16), np.diag([1.0, 1.0, 1.0, 1.0]))
    name = f"tiny-{uuid.uuid4().hex[:8]}"
    up = c.post(f"/api/v2/image-sets/{SET}/images", files={"file": (name + ".nii", img.to_bytes())}).json()["items"][0]
    assert up["type"] == "image", up
    seg = c.post(f"/api/v2/image-sets/{SET}/images", files={"file": (f"{name} segmentation_1.seg.nrrd", nrrd(img=img)[0])}).json()["items"][0]
    assert seg["type"] == "segmentation", seg
    r = c.put(f"/api/v2/linked-volumes/{seg['id']}", json={"image": up["id"]})
    assert r.status_code == 200, r.text
    return up["id"], seg["id"], name


def test_deleting_the_volume_keeps_its_segmentation_files_unlinked(made):
    c, _ = made
    image, fid, name = tiny_volume(c)
    try:
        assert c.delete(f"/api/v2/images/{image}").status_code == 204
        f = c.get(f"/api/v2/linked-volumes/{fid}")
        assert f.status_code == 200 and f.json()["image"] is None
        assert (IMAGES / "exact_1_1" / f"{name} segmentation_1.seg.nrrd").exists()
        assert c.get(f"/api/v2/linked-volumes/{fid}/slice/0/0").status_code == 409
    finally:
        c.delete(f"/api/v2/linked-volumes/{fid}")


def test_deleting_the_volume_can_delete_its_segmentation_files_with_it(made):
    c, _ = made
    image, fid, name = tiny_volume(c)
    assert c.delete(f"/api/v2/images/{image}", params={"segmentations": "delete"}).status_code == 204
    assert c.get(f"/api/v2/linked-volumes/{fid}").status_code == 404
    assert not (IMAGES / "exact_1_1" / f"{name} segmentation_1.seg.nrrd").exists()
    assert c.delete(f"/api/v2/images/{image}", params={"segmentations": "nonsense"}).status_code in (400, 404)
