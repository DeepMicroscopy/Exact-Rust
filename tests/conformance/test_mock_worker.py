"""A QueueRunner-like worker built on exact-sync (tests/mock-worker) against the server: legacy racy claim flow and the v2 claim."""
import concurrent.futures
import io
import pathlib
import sys
import uuid

import httpx
import pytest
from common import BASE, PW

pytest.importorskip("exact_sync")
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "mock-worker"))
from mock_worker import MockWorker  # noqa: E402

pytestmark = pytest.mark.skipif(httpx.get(BASE + "/api/version").status_code != 200, reason="server has no /api/version (Django)")

IMAGE = 2


def http():
    c = httpx.Client(base_url=BASE, timeout=60, auth=("aubreville", PW))
    return c


def make_jobs(plugin_id, n):
    c = http()
    return [c.post("/api/v1/processing/pluginjobs/", json={"plugin": plugin_id, "image": IMAGE}).json()["id"] for _ in range(n)]


def clear_queue(plugin_id):
    c = http()
    for j in c.get("/api/v1/processing/pluginjobs/", params={"limit": 1000}).json()["results"]:
        if j["plugin"] == plugin_id:
            for r in c.get("/api/v1/processing/pluginresults/", params={"job_id": j["id"]}).json()["results"]:
                c.delete(f"/api/v1/processing/pluginresults/{r['id']}/")
            c.delete(f"/api/v1/processing/pluginjobs/{j['id']}/")


def png():
    from PIL import Image
    b = io.BytesIO()
    Image.new("L", (16, 16), 120).save(b, "PNG")
    return b.getvalue()


@pytest.fixture
def worker(tmp_path):
    w = MockWorker(BASE, "aubreville", PW, f"w-{uuid.uuid4().hex[:6]}", claim="v2")
    clear_queue(w.plugin.id)
    yield w
    clear_queue(w.plugin.id)


def results_of(job_id):
    return http().get("/api/v1/processing/pluginresults/", params={"job_id": job_id}).json()["results"]


def test_plugin_is_registered_once(worker):
    again = MockWorker(BASE, "aubreville", PW, "other", claim="v2")
    assert again.plugin.id == worker.plugin.id


@pytest.mark.parametrize("mode", ["legacy", "v2"])
def test_job_runs_end_to_end(worker, mode, tmp_path):
    bitmap = tmp_path / "heat.png"
    bitmap.write_bytes(png())
    worker.claim_mode, worker.bitmap_path = mode, str(bitmap)
    (job_id,) = make_jobs(worker.plugin.id, 1)
    assert worker.run_once() == job_id
    c = http()
    job = c.get(f"/api/v1/processing/pluginjobs/{job_id}/").json()
    assert job["processing_complete"] == 100 and not job["attached_worker"] and not job["error_message"]
    (res,) = results_of(job_id)
    assert res["job"] == job_id and res["image"] == IMAGE
    entries = [e for e in c.get("/api/v1/processing/pluginresultentrys/", params={"expand": "annotation_results,bitmap_results", "limit": 1000}).json()["results"]
               if e["pluginresult"] == res["id"]]
    assert len(entries) == 1 and len(entries[0]["annotation_results"]) == 2 and len(entries[0]["bitmap_results"]) == 1
    assert entries[0]["annotation_results"][0]["generated"] is True and entries[0]["bitmap_results"][0]["bitmap"].startswith("http")
    assert worker.run_once() is None  # nothing left


def test_failing_handler_leaves_the_job_for_a_retry(worker):
    def boom(job, update_progress):
        update_progress(30.0)
        raise RuntimeError("model crashed")

    worker.handler = boom
    (job_id,) = make_jobs(worker.plugin.id, 1)
    assert worker.run_once() == job_id
    job = http().get(f"/api/v1/processing/pluginjobs/{job_id}/").json()
    assert job["error_message"] and "RuntimeError" in job["error_message"] and job["error_detail"] == "model crashed"
    assert not job["attached_worker"] and job["processing_complete"] == 30
    assert worker.run_once() is None  # a failed job is not taken again until somebody clears the error


def test_rerun_replaces_an_earlier_result(worker):
    (job_id,) = make_jobs(worker.plugin.id, 1)
    worker.run_once()
    (first,) = results_of(job_id)
    # an operator resets the job to 0 % (its result stays)
    http().patch(f"/api/v1/processing/pluginjobs/{job_id}/", json={"processing_complete": 0, "attached_worker": None})
    assert http().get(f"/api/v1/processing/pluginjobs/{job_id}/").json()["result"] == first["id"]
    assert worker.claim_v2() is None  # a job that has a result is not offered by the v2 claim
    # QueueRunner's old flow cannot tell (the generated client never fills `PluginJob.result`): it takes the job and the
    # handler replaces the earlier result
    worker.claim_mode = "legacy"
    assert worker.run_once() == job_id
    (second,) = results_of(job_id)
    assert second["id"] != first["id"]


def test_v2_claim_with_several_workers_processes_every_job_exactly_once(worker):
    ids = make_jobs(worker.plugin.id, 6)
    workers = [MockWorker(BASE, "aubreville", PW, f"w{i}", claim="v2") for i in range(3)]

    def drain(w):
        while w.run_once():
            pass
        return w.processed

    with concurrent.futures.ThreadPoolExecutor(3) as ex:
        done = [j for batch in ex.map(drain, workers) for j in batch]
    assert sorted(done) == sorted(ids)  # every job exactly once, none twice
    for j in ids:
        assert len(results_of(j)) == 1


def test_legacy_flow_with_two_workers_loses_no_job(worker):
    """The old flow can hand a job to two workers (that is why the v2 claim exists); what must hold is that nothing is lost."""
    ids = make_jobs(worker.plugin.id, 3)
    workers = [MockWorker(BASE, "aubreville", PW, f"l{i}", claim="legacy") for i in range(2)]

    def drain(w):
        for _ in range(8):
            if not w.run_once():
                break
        return w.processed

    with concurrent.futures.ThreadPoolExecutor(2) as ex:
        done = {j for batch in ex.map(drain, workers) for j in batch}
    assert done == set(ids)
    for j in ids:
        assert http().get(f"/api/v1/processing/pluginjobs/{j}/").json()["processing_complete"] == 100
