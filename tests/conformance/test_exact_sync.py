"""Acceptance for the mandatory `exact-sync` interface: read-only ExactManager / generated-client calls.

Runs against EXACT_URL (Django reference or Rust). Write-path calls are added in Phase 5.
"""
import os
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
from common import BASE, PW


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
