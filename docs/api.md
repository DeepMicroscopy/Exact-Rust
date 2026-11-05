---
title: API
nav_order: 5
---

# API

## `/api/v1` — compatible with EXACT
The REST interface of the Django version, byte for byte for everything that existed: the resources of `/api/v1/…`, the legacy
endpoints used by exact-sync (`/annotations/api/…`, `/images/api/…`) and token authentication. exact-sync, QueueRunner and existing
notebooks work unchanged. Registration jobs and plugins are not part of v1: it reports image analyses only.

```python
from exact_sync.v1.api_client import ApiClient
from exact_sync.v1.configuration import Configuration
cfg = Configuration(); cfg.host = "https://exact.example.org"; cfg.username = "…"; cfg.password = "…"
client = ApiClient(cfg)
```

## `/api/v2` — the new interface
JSON, session cookie or token. The interface of the browser UI, free to evolve.

| Area | Endpoints |
|---|---|
| Authentication | `POST /auth/login`, `/auth/logout`, `GET /auth/me`, passkeys under `/auth/passkey*` |
| Catalogue | `GET /image-sets`, `/images`, `/annotation-types`, `/products`, `/teams` and the generic `/{resource}` lists |
| Annotations | `POST /annotations`, `PATCH`/`DELETE /annotations/{id}` with conditional edits (409 if somebody else changed it), `/annotations/{id}/media-files` |
| Images | upload, `/images/{id}/crop`, `/move`, `/repair`, `/metadata`, `/download`, `/register` |
| Image sets | `/image-sets/{id}/images`, `/tags`, `/settings`, `/exports`, `/auxiliary-files` |
| Registration | `/registrations/manual`, `/registrations/{id}`, `/convert`, `/inverse`, `/points`, `/registration-plugins` |
| Jobs | `GET /jobs`, `POST /jobs/claim`, `/jobs/{kind}/{id}`, `/restart`, workers use `/plugin-jobs/claim`, `/plugin-jobs/{id}/progress`, `/complete`, `/fail`, `/registration-jobs/claim`, `/complete`, `/fail` |
| Administration | `/admin/plugins`, `/admin/users/{id}/…`, `/invitations`, `/teams/{id}/members`, `/teams/{id}/statistics` |

Slides are served as DeepZoom: `/images/api/image/…` (tiles), thumbnails and `/api/v2/segmentation/{annotation}/tiles/…` for masks.

### Claiming jobs
Workers take a job with a single request instead of listing, patching and re-reading:

```
POST /api/v2/plugin-jobs/claim   {"worker": "gpu-1", "plugin": 3}
200 {"id": 17, "plugin": 3, "images": [42], …}     204 nothing to do
```

A claimed job also carries `image_path` (the file on the server) and `annotation_types` (what a detection can be stored as). The worker then
reports with `POST /api/v2/plugin-jobs/{id}/progress {"worker", "progress"}`, finishes with `POST /api/v2/plugin-jobs/{id}/complete
{"worker", "annotation_type", "name", "default_threshold", "detections": [{"vector": {...}, "score": 0.9}]}` (201; result, entry and all annotations in
one transaction instead of one request each) or `POST /api/v2/plugin-jobs/{id}/fail {"worker", "error", "detail"}`. 409 when the job is not attached to that worker.

Details and the comparison with the old QueueRunner flow are in [QueueRunner and the v2 claim](queuerunner-v2).
