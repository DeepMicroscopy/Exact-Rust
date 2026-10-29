---
title: QueueRunner and the v2 claim
nav_order: 8
---

# EXACT-QueueRunner and the v2 claim

`EXACT-QueueRunner` takes a job in four steps (`QueueRunner.py`, lines 92-145): list *all* jobs, filter the free ones on
the client, PATCH `attached_worker`, wait a random time below one second, read the job again and give up if another
worker's name is there. Two workers that PATCH at slightly different moments can both read their own name back
and both run the model (`tests/conformance/test_mock_worker.py::test_legacy_flow_with_two_workers_loses_no_job` documents
that the old flow is only checked for losing no job, not for exclusivity). The server answers all of it unchanged
(`/api/v1/processing/pluginjobs/` with `limit=100000000`, PATCH of `attached_worker`), so an unmodified QueueRunner keeps working.

The Rust server adds one request that replaces the four steps:

```
POST /api/v2/plugin-jobs/claim      {"worker": "<name>", "plugin": <plugin id>}      (plugin optional)
200 {"id": 17, "plugin": 3, "image": 42, ...}     the job, now attached to the worker (one statement, FOR UPDATE SKIP LOCKED)
204                                               nothing to do
```

A job is free when it has no worker, is below 100 %, has no error and no result. Only jobs of images in the caller's teams
are offered. The caller needs the Django permission `processing.change_pluginjob`.

## Proposed change in QueueRunner (not applied: the checkout has local changes)

Replace the body of the `while True:` loop in `main()` by a claim per handler:

```python
import requests  # or httpx

def claim(plugin_id):
    r = requests.post(f"{url}/api/v2/plugin-jobs/claim", json={"worker": worker_name, "plugin": plugin_id},
                      auth=(user, password), timeout=60)
    if r.status_code == 204:
        return None
    r.raise_for_status()
    return apis['processing'].retrieve_plugin_job(id=r.json()["id"])

while True:
    busy = False
    for k in plugins:
        plugin = plugins[k].plugin
        job = claim(plugins_exact[plugin['package']].id)
        if job is None:
            continue
        busy = True
        update_progress = lambda progress, job=job: processing_api.partial_update_plugin_job(
            id=job.id, processing_complete=progress, updated_time=datetime.datetime.now())
        success = plugin['inference_func'](apis=apis, job=job, update_progress=update_progress)
        if success:
            update_progress(100.0)
            apis['processing'].partial_update_plugin_job(id=job.id, error_message=None, error_detail=None, attached_worker=None)
        else:
            apis['processing'].partial_update_plugin_job(id=job.id, attached_worker=None)
    if not busy:
        time.sleep(5)
```

The handlers (`inference_func`) stay as they are: they call `create_plugin_result`, `create_plugin_result_entry`,
`create_plugin_result_annotation` of exact-sync, which the server supports (the mock worker in `tests/mock-worker/mock_worker.py`
does the same calls). A job that failed (handler returned `False`) keeps its `error_message` and is not claimed again until
somebody clears it, which is the same as QueueRunner's `if job.error_message: continue`.

## Findings from building the mock worker

* exact-sync's `create_plugin(**kwargs)` posts nothing (the generated client picks `application/json` but sends the keyword
  arguments as form fields), and its `Plugin` model refuses a plugin without an icon, so `list_plugins()` fails for plugins
  that have none. QueueRunner's "register missing plugins" step only works when the plugins exist already; the mock creates
  them with a multipart request.
* `PluginJob.result` is never filled by the generated client (a bug in `models/plugin_job.py`: `if self.result is not None:`), so
  QueueRunner's `job.result is None` check is always true.
* `create_plugin_result_bitmap(bitmap=...)` sends no file for the same reason as `create_plugin`; bitmaps need a multipart request.
