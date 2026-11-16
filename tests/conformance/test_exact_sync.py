"""Acceptance for the mandatory `exact-sync` interface: ExactManager / generated-client calls.

Runs against EXACT_URL (Django reference or Rust). Read-only except the move test, which creates and deletes its own image sets.
"""
import json
import os
import uuid

import pytest

pytest.importorskip("exact_sync")
from exact_sync.exact_manager import ExactManager
from exact_sync.v1.api_client import ApiClient
from exact_sync.v1.configuration import Configuration
from exact_sync.v1.api.images_api import ImagesApi
from exact_sync.v1.api.image_sets_api import ImageSetsApi
from exact_sync.v1.api.annotations_api import AnnotationsApi
from exact_sync.v1.api.annotation_types_api import AnnotationTypesApi
from exact_sync.v1.api.processing_api import ProcessingApi
from exact_sync.v1.api.users_api import UsersApi
from exact_sync.v1.api.teams_api import TeamsApi
from exact_sync.v1.models import Annotation, ImageSet
from exact_sync.v1.rest import ApiException
from common import BASE, PW, client


@pytest.fixture(scope="module")
def apis():
    cfg = Configuration()
    cfg.username, cfg.password, cfg.host = "aubreville", PW, BASE
    cl = ApiClient(cfg)
    return dict(images=ImagesApi(cl), sets=ImageSetsApi(cl), annotations=AnnotationsApi(cl),
                types=AnnotationTypesApi(cl), processing=ProcessingApi(cl), users=UsersApi(cl), teams=TeamsApi(cl))


@pytest.fixture(scope="module")
def manager():
    return ExactManager(username="aubreville", password=PW, serverurl=BASE + "/", loglevel=100)


def test_manager_connects_and_lists_imagesets(manager):
    sets = manager.retrieve_imagesets()
    assert len(sets) >= 1
    assert {"id", "name"} <= set(sets[0])


def test_manager_loads_one_imageset_and_annotations(manager):
    s = manager.retrieve_imagesets()[0]
    assert manager.retrieve_imageset(s["id"])["id"] == s["id"]
    img = manager.retrieve_imageset(s["id"])["images"][0]
    assert isinstance(manager.retrieve_annotations(img["id"]), list)


def test_list_images_paginated(apis):
    r = apis["images"].list_images(limit=5)
    assert r.count >= 71 and len(r.results) == 5 and r.results[0].width


def test_list_images_unpaginated_with_omit(apis):
    r = apis["images"].list_images(pagination=False, omit="annotations")
    assert len(r.results) >= 71 and r.next is None


def test_retrieve_image_and_slide_information(apis):
    img = apis["images"].list_images(limit=1).results[0]
    assert apis["images"].retrieve_image(img.id).id == img.id
    assert apis["images"].get_slide_information(img.id) is not None


def test_annotations_and_types(apis):
    assert apis["annotations"].list_annotations(limit=10).count >= 50
    assert apis["types"].list_annotation_types().count >= 1


def test_users_and_teams(apis):
    assert apis["users"].list_users().count >= 2
    assert apis["teams"].list_teams().count >= 3


def test_processing_lists(apis):
    p = apis["processing"]
    for fn in (p.list_plugins, p.list_plugin_jobs, p.list_plugin_results):
        assert fn(limit=100000000).results is not None  # QueueRunner passes a huge limit


def test_download_image_roundtrip(manager, tmp_path):
    """Download a tiny image (64x64 jpg) through the legacy download endpoint, as exact-sync does."""
    from PIL import Image
    target = tmp_path / "small.jpg"
    manager.download_image(78, target, callback=lambda p: None)
    assert Image.open(target).size == (64, 64)


def _delete_image_set(set_id):
    """Django deletes image sets over v1; the Rust server only over v2 (see docs/api.md)."""
    c = client("aubreville")
    if c.get("/api/version").status_code == 200:
        c.delete(f"/api/v2/image-sets/{set_id}")
    else:
        c.delete(f"/api/v1/images/image_sets/{set_id}/")


def test_move_image_with_annotations_over_basic_auth(apis, tmp_path):
    """`ImagesApi.move_image` / `list_move_targets` as exact-sync sends them: HTTP Basic auth, no session, no CSRF token.

    The image moves with its annotation; a target that lacks the annotation type refuses (409) and nothing changes.
    """
    images = apis["images"]
    if not hasattr(images, "move_image"):
        pytest.skip("the installed exact_sync has no ImagesApi.move_image (EXACT-Sync branch feature/move-image)")
    from PIL import Image

    atype = apis["types"].retrieve_annotation_type(id=1)
    assert atype.product, "annotation type 1 must belong to a product"
    tag = uuid.uuid4().hex[:8]
    sets = {}
    try:
        # source and target offer the annotation type, "bare" does not
        for key, products in (("source", [atype.product]), ("bare", []), ("target", [atype.product])):
            body = ImageSet(name=f"sync-move-{key}-{tag}", team=1, product_set=products)
            sets[key] = apis["sets"].create_image_set(body=body).id
        path = tmp_path / f"sync-move-{tag}.png"
        Image.new("RGB", (20, 16), (9, 9, 9)).save(path)
        img = images.create_image(file_path=str(path), image_type=0, image_set=sets["source"]).results[0]
        assert img.image_set == sets["source"]
        ann = apis["annotations"].create_annotation(body=Annotation(
            annotation_type=atype.id, image=img.id, unique_identifier=str(uuid.uuid4()),
            vector={"x1": 1, "y1": 1, "x2": 9, "y2": 9}))

        target_ids = [t["id"] for t in images.list_move_targets()]
        assert sets["bare"] in target_ids and sets["target"] in target_ids

        with pytest.raises(ApiException) as refused:
            images.move_image(id=img.id, target_imageset_id=sets["bare"])
        body = refused.value.body
        detail = json.loads(body.decode() if isinstance(body, bytes) else body)["detail"]
        assert refused.value.status == 409 and atype.name in detail
        assert images.retrieve_image(id=img.id).image_set == sets["source"]

        assert images.move_image(id=img.id, target_imageset_id=sets["target"]) == {"id": img.id, "image_set": sets["target"]}
        assert images.retrieve_image(id=img.id).image_set == sets["target"]
        assert [a.id for a in apis["annotations"].list_annotations(image=img.id).results] == [ann.id]
        assert apis["annotations"].retrieve_annotation(id=ann.id).image == img.id
    finally:
        for set_id in sets.values():
            _delete_image_set(set_id)
