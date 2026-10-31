"""3D segmentation: the mask of a volume on all three planes, brush / wand / interpolation / morphology, undo (Rust only)."""
import gzip
import io
import uuid

import httpx
import pytest
from common import BASE
from test_v2_registration import client

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

NIFTI, SET, SEG_TYPE, SEG_PRODUCT = 80, 1, 2, 2  # CT_Philips.nii.gz: 185 x 232 pixels, 256 slices


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


def ops(c, aid, **body):
    r = c.post(f"/api/v2/segmentation/{aid}/ops", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def slice_alpha(c, aid, plane, frame):
    from PIL import Image
    r = c.get(f"/api/v2/segmentation/{aid}/slice/{plane}/{frame}")
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    im = Image.open(io.BytesIO(r.content)).convert("RGBA")
    return im.size, {(x, y) for y in range(im.height) for x in range(im.width) if im.getpixel((x, y))[3] > 0}


def near(points, p, tol=1):
    return any(abs(x - p[0]) <= tol and abs(y - p[1]) <= tol for x, y in points)


def test_the_volume_and_its_planes(seg):
    c, aid = seg
    v = c.get(f"/api/v2/segmentation/{aid}/volume").json()
    assert (v["width"], v["frames"]) == (185, 256) and v["height"] in (232, 233)
    assert v["voxels"][0] == 185 and v["voxels"][2] == 256
    assert [p["plane"] for p in v["planes"]] == [0, 1, 2]
    assert v["planes"][1]["frames"] == v["voxels"][1] and v["planes"][2]["frames"] == 185
    assert v["count"] == 0 and v["bbox"] is None and v["slices"] == [] and not v["can_undo"]
    assert c.get(f"/api/v2/segmentation/{aid}/slice/3/0").status_code == 400
    assert c.get(f"/api/v2/segmentation/{aid}/slice/0/999").status_code == 400


def test_a_stroke_on_one_plane_shows_on_the_other_two_where_the_voxel_is(seg):
    c, aid = seg
    v = c.get(f"/api/v2/segmentation/{aid}/volume").json()
    W, H, N = v["width"], v["height"], v["frames"]
    nx, ny, nz = v["voxels"]
    sx, sy, sz = v["voxel_mm"]
    # a disc of 3 voxels on axial slice 100 around pixel (90, 120)
    s = ops(c, aid, op="stroke", plane=0, frame=100, points=[[90.5, 120.5]], radius_mm=3 * max(sx, sy), mode="add")
    assert s["count"] > 5 and s["can_undo"] and s["slices"] == [100]
    (w, h), ax = slice_alpha(c, aid, 0, 100)
    assert (w, h) == (W, H) and (90, 120) in ax and (150, 120) not in ax
    assert slice_alpha(c, aid, 0, 101)[1] == set()
    # coronal frame = y voxel; axial row 120 shows y voxel ny - 1 - 120 * ny / H; the plane row of slice 100 is nz - 1 - 100
    cor = v["planes"][1]
    yv = ny - 1 - int((120.5) / H * ny)
    (cw, ch), co = slice_alpha(c, aid, 1, yv)
    assert (cw, ch) == (cor["width"], cor["height"])
    assert co and near(co, (90, ch - 1 - int(100.5 / N * ch)), 2)
    assert slice_alpha(c, aid, 1, max(0, yv - 8))[1] == set()
    # sagittal frame = x voxel; plane columns run along y voxels with the posterior on the left: the picture's column is the y voxel
    sag = v["planes"][2]
    xv = nx - 1 - int(90.5 / W * nx)
    (sw, sh), sa = slice_alpha(c, aid, 2, xv)
    assert (sw, sh) == (sag["width"], sag["height"])
    assert near(sa, (yv * sw // ny, sh - 1 - int(100.5 / N * sh)), 3), "mirrored against the picture it would be near column %d" % (sw - 1 - yv * sw // ny)
    assert slice_alpha(c, aid, 2, max(0, xv - 8))[1] == set()


def test_drawing_on_the_coronal_plane_lands_on_the_right_axial_row(seg):
    c, aid = seg
    v = c.get(f"/api/v2/segmentation/{aid}/volume").json()
    H, N, ny = v["height"], v["frames"], v["voxels"][1]
    yv = 111
    row = int((ny - 1 - yv + 0.5) / ny * H)
    ch = v["planes"][1]["height"]
    pr = ch - 1 - int(155.5 / N * ch)
    ops(c, aid, op="stroke", plane=1, frame=yv, points=[[60.5, pr + 0.5], [80.5, pr + 0.5]], radius_mm=0.5, mode="add")
    (_, _), ax = slice_alpha(c, aid, 0, 155)
    assert ax and {y for _, y in ax} == {row} and 60 in {x for x, _ in ax} and 80 in {x for x, _ in ax}
    ops(c, aid, op="stroke", plane=1, frame=yv, points=[[60.5, pr + 0.5], [80.5, pr + 0.5]], radius_mm=4.0, mode="remove")
    assert slice_alpha(c, aid, 0, 155)[1] == set()


def test_a_ball_reaches_through_the_slices_and_undo_redo_go_back_and_forth(seg):
    c, aid = seg
    v0 = c.get(f"/api/v2/segmentation/{aid}/volume").json()
    s = ops(c, aid, op="stroke", plane=0, frame=100, points=[[90.5, 120.5]], radius_mm=6.0, ball=True, mode="add")
    assert len(s["slices"]) >= 3 and 100 in s["slices"] and s["volume_mm3"] > 0
    n = s["count"]
    u = c.post(f"/api/v2/segmentation/{aid}/undo").json()
    assert u["count"] == 0 and u["slices"] == [] and u["can_redo"] and not u["can_undo"]
    assert slice_alpha(c, aid, 0, 100)[1] == set()
    r = c.post(f"/api/v2/segmentation/{aid}/redo").json()
    assert r["count"] == n and not r["can_redo"]
    assert c.post(f"/api/v2/segmentation/{aid}/redo").status_code == 409
    # the tiles are really stored: the old axial tile route sees them, and what it writes is seen by the 3D view
    t = c.get(f"/api/v2/segmentation/{aid}/tiles/0/0/0?frame=100&x=1")
    assert t.status_code == 200
    assert c.delete(f"/api/v2/segmentation/{aid}/tiles/0/0/0?frame=100&x=1").status_code == 204
    assert 100 not in c.get(f"/api/v2/segmentation/{aid}/volume").json()["slices"]
    assert v0["count"] == 0


def test_the_wand_grows_through_the_volume_within_its_limits(seg):
    c, aid = seg
    s = ops(c, aid, op="wand", plane=0, frame=128, point=[92.5, 116.5], tolerance=20, volume=True, max_radius_mm=15.0)
    assert 0 < s["count"] < 200_000 and len(s["slices"]) > 1
    r = ops(c, aid, op="wand", plane=0, frame=128, point=[92.5, 116.5], tolerance=20, volume=False, mode="add", max_radius_mm=15.0)
    assert r["count"] >= s["count"]
    big = c.post(f"/api/v2/segmentation/{aid}/ops", json={"op": "wand", "plane": 0, "frame": 128, "point": [92.5, 116.5], "tolerance": 255, "volume": True, "max_voxels": 1000})
    assert big.status_code == 400 and "too large" in big.json()["detail"]
    assert c.post(f"/api/v2/segmentation/{aid}/ops", json={"op": "wand", "plane": 0, "frame": 128, "point": [1, 1], "mode": "paint"}).status_code == 400


def test_interpolation_morphology_and_components(seg):
    c, aid = seg
    ops(c, aid, op="stroke", plane=0, frame=100, points=[[90.5, 120.5]], radius_mm=10.0, mode="add")
    ops(c, aid, op="stroke", plane=0, frame=110, points=[[90.5, 120.5]], radius_mm=4.0, mode="add")
    s = ops(c, aid, op="interpolate")
    assert s["slices"] == list(range(100, 111))
    assert ops(c, aid, op="interpolate").get("note", "").startswith("There are no gaps")
    n = s["count"]
    assert ops(c, aid, op="grow", steps=2)["count"] > n
    assert ops(c, aid, op="shrink", steps=2)["count"] <= n + 50
    ops(c, aid, op="stroke", plane=0, frame=200, points=[[30.5, 30.5]], radius_mm=2.0, mode="add")
    k = ops(c, aid, op="keep_largest")
    assert 200 not in k["slices"] and "removed" in k["note"]
    assert ops(c, aid, op="copy", **{"from": 100, "to": 120, "through": 122})["slices"][-3:] == [120, 121, 122]
    assert ops(c, aid, op="fill_holes")["count"] > 0
    assert ops(c, aid, op="clear")["count"] == 0
    assert c.post(f"/api/v2/segmentation/{aid}/undo").json()["count"] > 0
    assert c.post(f"/api/v2/segmentation/{aid}/ops", json={"op": "grow", "steps": 99}).status_code == 400


def test_a_mask_made_elsewhere_is_taken_in(seg):
    c, aid = seg
    v = c.get(f"/api/v2/segmentation/{aid}/volume").json()
    W, H, N = v["width"], v["height"], v["frames"]
    vol = bytearray(W * H * N)
    for z in range(50, 60):
        for r in range(100, 110):
            for col in range(80, 90):
                vol[(z * H + r) * W + col] = 1
    r = c.put(f"/api/v2/segmentation/{aid}/labels", content=gzip.compress(bytes(vol)), headers={"Content-Encoding": "gzip", "Content-Type": "application/octet-stream"})
    assert r.status_code == 200, r.text
    assert r.json()["count"] == 1000 and r.json()["slices"] == list(range(50, 60))
    assert c.put(f"/api/v2/segmentation/{aid}/labels", content=b"short").status_code == 400
    again = c.put(f"/api/v2/segmentation/{aid}/labels?mode=add", content=bytes(W * H * N))
    assert again.json()["count"] == 1000
    assert c.post(f"/api/v2/segmentation/{aid}/undo").status_code in (200, 409)


def test_permissions_and_kinds(seg):
    c, aid = seg
    out = client("rt_outsider")
    assert out.get(f"/api/v2/segmentation/{aid}/volume").status_code == 404
    assert out.post(f"/api/v2/segmentation/{aid}/ops", json={"op": "clear"}).status_code in (403, 404)
    # an annotation that is not a segmentation
    bbox = c.post("/api/v2/annotations", json={"image": NIFTI, "annotation_type": 1, "vector": {"x1": 1, "y1": 1, "x2": 5, "y2": 5}, "unique_identifier": str(uuid.uuid4())})
    if bbox.status_code == 201:
        assert c.get(f"/api/v2/segmentation/{bbox.json()['id']}/volume").status_code == 400
        c.delete(f"/api/v2/annotations/{bbox.json()['id']}")


def ct_volume(path, n=(64, 48, 40)):
    """A multi-frame CT DICOM (nx x ny x nz, 0.8 x 0.8 x 2.5 mm) with a bright ball centred at (40, 20, 25) and a dim one at (15, 30, 10)."""
    import numpy as np
    import pydicom
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import ExplicitVRLittleEndian, generate_uid
    nx, ny, nz = n
    z, y, x = np.mgrid[0:nz, 0:ny, 0:nx]
    vol = np.full((nz, ny, nx), 100, np.int16)
    vol[((x - 40) * 0.8) ** 2 + ((y - 20) * 0.8) ** 2 + ((z - 25) * 2.5) ** 2 <= 8.0**2] = 1000
    vol[((x - 15) * 0.8) ** 2 + ((y - 30) * 0.8) ** 2 + ((z - 10) * 2.5) ** 2 <= 5.0**2] = 600
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = "1.2.840.10008.5.1.4.1.1.2.1"
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = FileDataset(str(path), {}, file_meta=meta, preamble=b"\0" * 128)
    ds.SOPClassUID, ds.SOPInstanceUID, ds.Modality = meta.MediaStorageSOPClassUID, meta.MediaStorageSOPInstanceUID, "CT"
    ds.Rows, ds.Columns, ds.NumberOfFrames = ny, nx, str(nz)
    ds.SamplesPerPixel, ds.PhotometricInterpretation = 1, "MONOCHROME2"
    ds.BitsAllocated = ds.BitsStored = 16
    ds.HighBit, ds.PixelRepresentation = 15, 1
    ds.PixelSpacing, ds.SpacingBetweenSlices, ds.SliceThickness = [0.8, 0.8], 2.5, 2.5
    ds.RescaleSlope, ds.RescaleIntercept = 1, 0
    ds.WindowCenter, ds.WindowWidth = 500, 1200
    ds.PixelData = vol.tobytes()
    ds.save_as(str(path), enforce_file_format=False) if hasattr(ds, "save_as") else None


@pytest.fixture()
def dicom_seg(tmp_path):
    pytest.importorskip("pydicom")
    c = client("aubreville")
    name = f"ct-{uuid.uuid4().hex[:8]}.dcm"
    f = tmp_path / name
    ct_volume(f)
    up = c.post("/api/v2/image-sets/1/images", files={"file": (name, f.read_bytes())})
    assert up.status_code == 201, up.text
    item = up.json()["items"][0]
    assert "error" not in item, item
    iid = item["id"]
    c.put(f"/api/v2/image-sets/{SET}/products/{SEG_PRODUCT}")
    made = c.post("/api/v2/annotations", json={"image": iid, "annotation_type": SEG_TYPE, "vector": {"tile_size": 256, "width": 64, "height": 48}, "unique_identifier": str(uuid.uuid4())})
    assert made.status_code == 201, made.text
    aid = made.json()["id"]
    yield c, aid, iid
    c.delete(f"/api/v2/annotations/{aid}")
    c.delete(f"/api/v2/images/{iid}")
    c.delete(f"/api/v2/image-sets/{SET}/products/{SEG_PRODUCT}")


def test_a_dicom_volume_has_planes_and_takes_3d_tools(dicom_seg):
    c, aid, iid = dicom_seg
    meta = c.get(f"/api/v2/images/{iid}/metadata").json()
    assert [p["frames"] for p in meta["planes"]] == [40, 48, 64], meta["planes"]
    v = c.get(f"/api/v2/segmentation/{aid}/volume").json()
    assert (v["width"], v["height"], v["frames"], v["voxels"]) == (64, 48, 40, [64, 48, 40])
    assert [round(m, 2) for m in v["extent_mm"]] == [51.2, 38.4, 100.0]
    assert v["planes"][1]["height"] == 125 and v["planes"][1]["width"] == 64  # 40 slices x 2.5 mm at 0.8 mm per pixel
    # a click inside the bright ball (column 40, row 20, slice 25 on the axial plane) grows over the whole ball and only it
    s = ops(c, aid, op="wand", plane=0, frame=25, point=[40.5, 20.5], tolerance=40, volume=True)
    # the ball has radius 8 mm: 10 voxels across in x and y, 3.2 slices each way
    assert 1100 < s["count"] < 1600, s["count"]  # 4/3 pi 8^3 = 2144 mm3 at 1.6 mm3 per voxel
    assert s["slices"][0] >= 21 and s["slices"][-1] <= 29 and 25 in s["slices"]
    x0, x1, y0, y1, z0, z1 = [s["bbox"][i] for i in (0, 1, 2, 3, 4, 5)]
    assert 28 <= x0 and x1 <= 52 and 8 <= y0 and y1 <= 32
    # the other ball is not connected: a second click adds it, and the volume is the sum
    t = ops(c, aid, op="wand", plane=0, frame=10, point=[15.5, 30.5], tolerance=40, volume=True)
    assert t["count"] > s["count"] and 10 in t["slices"]
    # on the coronal plane the same ball is where the picture shows it: the bright disc at plane row 125 - 25*2.5/0.8..
    (cw, ch), co = slice_alpha(c, aid, 1, 48 - 1 - 20)
    assert (cw, ch) == (64, 125) and co
    cx = sum(x for x, _ in co) / len(co)
    assert abs(cx - 40) < 3
    # grow, then remove with the eraser ball
    n = t["count"]
    assert ops(c, aid, op="grow", steps=1)["count"] > n
    ops(c, aid, op="stroke", plane=0, frame=25, points=[[40.5, 20.5]], radius_mm=100, ball=True, mode="remove")
    assert ops(c, aid, op="keep_largest")["count"] == 0
