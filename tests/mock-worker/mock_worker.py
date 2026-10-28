"""A worker that behaves like EXACT-QueueRunner, without a model, for testing servers.

It uses `exact-sync` exactly like QueueRunner does (`list_plugins`/`create_plugin` at start; per job `retrieve_plugin_job`,
`partial_update_plugin_job` for claiming and progress, `create_plugin_result`, `create_plugin_result_entry`,
`create_plugin_result_annotation`, `create_plugin_result_bitmap`, `destroy_plugin_result` of an earlier result).

Two ways to take a job:
  claim="legacy"  QueueRunner's flow: PATCH `attached_worker`, sleep a random time below 1 s, read the job again, back off
                  when another worker's name is there. Racy by design: nothing stops two workers from both finishing it.
  claim="v2"      `POST /api/v2/plugin-jobs/claim`: the server hands every job to exactly one worker.
"""
import datetime
import logging
import random
import time

import httpx
from exact_sync.v1.api.annotation_types_api import AnnotationTypesApi
from exact_sync.v1.api.images_api import ImagesApi
from exact_sync.v1.api.processing_api import ProcessingApi
from exact_sync.v1.api_client import ApiClient
from exact_sync.v1.configuration import Configuration
from exact_sync.v1.models import PluginResult, PluginResultAnnotation, PluginResultEntry

PLUGIN = {"name": "Mock detector", "author": "tests", "package": "mock.detector", "contact": "t@example.org", "abouturl": "https://example.org"}


class MockWorker:
    def __init__(self, base_url, user, password, name, claim="legacy", handler=None, bitmap_path=None):
        cfg = Configuration()
        cfg.username, cfg.password, cfg.host = user, password, base_url
        client = ApiClient(cfg)
        self.apis = dict(processing=ProcessingApi(client), images=ImagesApi(client), types=AnnotationTypesApi(client))
        self.base_url, self.auth, self.name, self.claim_mode = base_url.rstrip("/"), (user, password), name, claim
        self.handler = handler or self.detect
        self.bitmap_path = bitmap_path
        self.processed = []
        self.plugin = self.register_plugin()

    def register_plugin(self):
        """QueueRunner: list the plugins and create the ones of its handlers that are missing."""
        processing = self.apis["processing"]
        plugins = {p.name: p for p in processing.list_plugins().results}
        if PLUGIN["name"] not in plugins:
            # exact-sync's `create_plugin` cannot be used as it is (the kwargs form sends no body), so the plugin is created
            # with a plain multipart request; the client's Plugin model insists on an icon, so there is one
            from PIL import Image
            import io
            icon = io.BytesIO()
            Image.new("RGB", (8, 8), (30, 90, 160)).save(icon, "PNG")
            httpx.post(f"{self.base_url}/api/v1/processing/plugins/", data=PLUGIN, files={"icon": ("icon.png", icon.getvalue())},
                       auth=self.auth, timeout=60).raise_for_status()
            plugins = {p.name: p for p in processing.list_plugins().results}
        return plugins[PLUGIN["name"]]

    # ---- the "model" -------------------------------------------------------------------------------------------------
    def detect(self, job, update_progress):
        """Reports progress, then uploads a result with one entry, two annotations and optionally a bitmap."""
        processing = self.apis["processing"]
        image = self.apis["images"].retrieve_image(id=job.image)
        annotation_type = self.apis["types"].list_annotation_types(limit=1).results[0]
        for p in (10.0, 50.0, 90.0):
            update_progress(p)
        existing = [r.id for r in processing.list_plugin_results().results if r.job == job.id]
        if existing:
            processing.destroy_plugin_result(existing[0])
        result = processing.create_plugin_result(body=PluginResult(job=job.id, image=image.id, plugin=job.plugin, entries=[]))
        entry = processing.create_plugin_result_entry(
            body=PluginResultEntry(pluginresult=result.id, name="Detections", annotation_results=[], bitmap_results=[], default_threshold=0.5))
        for k in range(2):
            vector = {"x1": 10 + k, "y1": 10, "x2": 40 + k, "y2": 40}
            processing.create_plugin_result_annotation(
                body=PluginResultAnnotation(annotation_type=annotation_type.id, pluginresultentry=entry.id, image=image.id, vector=vector, score=0.9 - 0.1 * k))
        if self.bitmap_path:
            # the generated client sends no multipart body for this call (it picks JSON), so a file is posted directly
            with open(self.bitmap_path, "rb") as f:
                r = httpx.post(f"{self.base_url}/api/v1/processing/pluginresultbitmaps/", auth=self.auth, timeout=120,
                               data={"name": "heat", "channels": "1", "pluginresultentry": str(entry.id), "image": str(image.id)}, files={"bitmap": ("heat.png", f)})
            r.raise_for_status()
        return True

    # ---- taking jobs -------------------------------------------------------------------------------------------------
    def claim_v2(self):
        r = httpx.post(f"{self.base_url}/api/v2/plugin-jobs/claim", json={"worker": self.name, "plugin": self.plugin.id}, auth=self.auth, timeout=60)
        if r.status_code == 204:
            return None
        r.raise_for_status()
        return self.apis["processing"].retrieve_plugin_job(id=r.json()["id"])

    def claim_legacy(self):
        processing = self.apis["processing"]
        jobs = processing.list_plugin_jobs(limit=100000000).results
        for job in [j for j in jobs if j.processing_complete != 100]:
            try:
                job = processing.retrieve_plugin_job(id=job.id)
            except Exception:  # noqa: BLE001 - removed meanwhile
                continue
            if job.error_message or job.plugin != self.plugin.id or job.result is not None or job.attached_worker:
                continue
            processing.partial_update_plugin_job(id=job.id, attached_worker=self.name, updated_time=datetime.datetime.now())
            time.sleep(random.random())
            job = processing.retrieve_plugin_job(id=job.id)
            if job.attached_worker != self.name:
                logging.info("conflict: %s got the job", job.attached_worker)
                continue
            return job
        return None

    def run_once(self):
        """Takes one job, runs the handler, reports; returns the job id or None when the queue has nothing for this worker."""
        job = self.claim_v2() if self.claim_mode == "v2" else self.claim_legacy()
        if job is None:
            return None
        processing = self.apis["processing"]

        def update_progress(progress):
            processing.partial_update_plugin_job(id=job.id, processing_complete=progress, updated_time=datetime.datetime.now())

        try:
            ok = self.handler(job, update_progress)
        except Exception as e:  # noqa: BLE001 - handlers report their errors on the job
            processing.partial_update_plugin_job(id=job.id, error_message="Error: " + str(type(e)), error_detail=str(e))
            ok = False
        if ok:
            update_progress(100.0)
            processing.partial_update_plugin_job(id=job.id, error_message=None, error_detail=None, attached_worker=None)
        else:
            processing.partial_update_plugin_job(id=job.id, attached_worker=None)
        self.processed.append(job.id)
        return job.id
