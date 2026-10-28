# EXACT → Rust: Porting Plan

Source: `~/code/Exact` (Django 4.2, DRF 3.15, PostgreSQL, Python ≈16k LOC in app code, 129 migrations, 43 documented paths in `EXACT-API.yml`).
Decisions so far:
- **In-process Python server plugins are dropped** (`plugins/ExactServerPlugin.py`, `pluginFinder.py`, `proc_EIPH.py`, and the navigator-overlay/plugin-statistics hooks that use them).
- **Decisions from review (2026-10-27):** browser **runtime** speed matters, but a clean architecture wins over absolute maximum speed; all slide formats EXACT supports today are in scope; `/api/v1` byte-compatibility is *not* required (a v2 API is fine) but **interface compatibility with the `exact-sync` Python module is mandatory** (§2a); passkeys, registration and impersonation are in use and must be ported; `zarr` and `h5py` are unused and dropped; **image registration is heavily used** (kept, §6a); the navigator overlay is **rebuilt** on `PluginResultBitmap`; forced re-login at cutover is OK; **React + TypeScript + Vite** is the frontend stack; QueueRunner moves to the v2 atomic-claim API in this project; registration runs as a Python worker; **first milestone is a beta deployment checked against a backup of the production system (§5a)**, no staffed schedule yet; compatibility with any other API consumers is kept where cheap; target is **single binary + PostgreSQL** (no Redis, no Celery).
- **The `processing` app stays.** It is the interface for *external* ML plugins (workers that poll jobs and push results over the REST API). It is ported as part of the public contract (see §6).

## 1. Phase 0 inventory (what is actually in the repo)

### 1.1 Django apps

| App | Role | Size (views/models/api LOC) | Port? |
|---|---|---|---|
| `images` | Image, ImageSet, SetTag, SetVersion, ScreeningMode, ImageRegistration, FrameDescription, AuxiliaryFile; upload, tile serving, crop, move, search, statistics | views 2575, models 888, api_views 888 | Yes – core |
| `annotations` | Annotation, AnnotationType, AnnotationVersion, Verification, AnnotationMediaFile, SegmentationTile, Export/ExportFormat, LogImageAction | views 1526, models 782, api_views 557 | Yes – core |
| `users` | User (AbstractUser), Team, TeamMembership, UserPreferences, PersonalAccessToken (scoped), passkeys | views 426, models 148 | Yes – core |
| `administration` | Products, annotation-type admin, user admin API (impersonate, reset pw, toggle staff…), slide cache stats | views 987 | Yes (trimmed) |
| `datasets` | Dataset export/management views | views 909 | Phase 6 |
| `tables` | TableDataset/TableVersion/TableViewSettings (spreadsheet-like data, CSV/XLSX import/export) | views 423, models 208 | Phase 6 |
| `tools`, `tagger_messages` | Tool + ToolVote, Message (small) | ~150–240 | Phase 6 (low priority) |
| `base` | active-user tracking middleware, home, flex-fields | small | Yes |
| `processing` | Plugin, PluginJob, PluginResult, PluginResultEntry/Bitmap/Annotation (7 models); REST for external ML workers + small UI (job list/detail/stop/restart/cleanup/submit) | api 143, ser 144, models 168, views 149 | **Yes – REST contract in Phase 3/5, UI in Phase 7** (see §6) |

~33 models total, all of which are ported.

### 1.2 API surface (three layers, all must be classified)

1. **Versioned REST (DRF routers, `/api/v1/…`)**: users, teams, team_membership, images, image_sets, set_tags, set_versions, screening_modes, registration, annotations, annotation_versions, annotation_types, annotation_media_files, verifications, log_image_actions, products, and the 6 `processing/*` routes (plugins, pluginjobs, pluginresults, pluginresultentrys, pluginresultannotations, pluginresultbitmaps) used by ML workers. This is the **public contract** used by `EXACT-Sync`/`exact-client`, SlideRunner, and scripts. Features: `LimitOffsetPagination` (50), `django-filter` query params, `drf-flex-fields` (`?expand=`/`?fields=`), OpenAPI at `/api/v1/openapi`.
2. **Legacy "explore" routers** (`*_explore`) used by the UI tables (same viewsets, different mount).
3. **Ad-hoc JSON endpoints** (`/annotations/api/annotation/{create,update,delete,load,loadset,verify,copy,…}`, `/images/api/image/{crop,metadata,move,opened,closed,…}`, `/images/api/imageset/{create,tag,product…}`, `/tables/api/…`, `/administration/…/api/…`). These are called by the project's own JS only; they are **not** a stable contract and can be redesigned once the frontend is touched.
4. **Tile endpoints**: DeepZoom descriptor + `tile_files/<level>/<col>_<row>.{png,jpeg}`, navigator overlay tiles, segmentation tiles (`/annotations/api/segmentation/<id>/tiles/…`), crops.
5. **Auth**: Session (Django), Basic, personal access tokens with scopes (`users/scope.py`, `tokens.py`), JWT (simplejwt/djoser, largely commented out), RemoteUser backend, passkeys (WebAuthn), django-registration (email activation), password reset.

### 1.3 Hard dependencies and their Rust story

| Python dep / feature | Use | Rust approach | Risk |
|---|---|---|---|
| Django ORM + **PostgreSQL only** ("relies on Postgres features") | all data | `sqlx` (Postgres), reuse existing schema | Low; need to grep exact PG-specific features (JSON/Array/FTS) in Phase 1 |
| openslide / `DeepZoomGenerator` | WSI read + tiling (patched `zDeepZoomGenerator` w/ frame + plane) | `openslide` C lib via FFI (`openslide-sys`/own thin binding) + own DeepZoom math (small, well specified) | Medium |
| tifffile, ome-types, `tiffzstack.py` (425 LOC) | OME-TIFF, z-stacks | `tiff` crate + own OME-XML parse (`quick-xml`) | High |
| slideio (`util/slideio.py`) | CZI, other formats | No Rust equivalent → **FFI to slideio C++** or out-of-process converter | High |
| pydicom | DICOM WSI | `dicom-rs`, or openslide ≥4.0 DICOM | Medium |
| pyvips | conversion | `libvips` binding or drop | Low–Med |
| opencv (`video_handler.py`, `cellvizio.py` MKT) | MP4/AVI/MKT video frames | `opencv` crate (heavy) or ffmpeg subprocess; MKT is custom → port by hand (321 LOC) | Medium |
| nibabel (`nifti.py`, MPR planes) | NIfTI 3D | `nifti` crate | Medium |
| iSyntax (`ISyntaxContainer.py`, 547 LOC, separate Docker image with Philips SDK) | Philips iSyntax | Keep as **sidecar service** (don't port) | n/a |
| zarr, h5py | unused (confirmed) | **Dropped** | None |
| pandas, xlsx | `tables` import/export | `csv`, `calamine` (read xlsx), `rust_xlsxwriter` | Low |
| Redis (django-redis, session cache backend) | sessions + tile cache | **Removed**: sessions in Postgres, tile/slide caches in-process (`moka`) + on-disk | Low |
| Pillow | PNG/JPEG encode, palette PNG for segmentation | `image`, `png`, `mozjpeg`/`zune-jpeg` | Low |
| `qt-wsi-registration` | WSI registration (ImageRegistration model; `exact-sync` calls `register_images`, `convert_coodinates`, `create_inverse_registration`) | Keep data model + endpoints; check what the registration lib needs (verify in Phase 1) | Verify |
| Django templates + static JS (annotation tool ~8.8 MB static, OpenSeadragon, jQuery, jCanvas, Bootstrap) | the UI | see §4 | **Largest unknown** |
| `django.contrib.admin` | admin UI | replace with small admin pages or drop | Low |
| gunicorn + nginx | serving | single binary with built-in static files, TLS optional behind any reverse proxy | Low |

Image formats listed in `slide_server.py` `FileType` classes (**all in scope for v1**, per decision): BigTIFF, TIFF, Hamamatsu (NDPI), Olympus VSI, JPEG, PNG, Philips iSyntax, MIRAX, DICOM, Zeiss CZI, MKT (Cellvizio), MP4, AVI, NIfTI-1/2/GZ.

### 1.4 Behaviour hidden in Python (must be ported explicitly, with tests)

- `AnnotationType.validate_vector` + vector-type conversion rules (`can_convert`) and size-unit→pixel conversion (`unit_to_pixel_factor`) – pure logic, easy to port; existing tests `test_size_unit.py`, `test_frames.py` give a head start.
- `Annotation.similar_annotations` / `equal_annotation` (duplicate detection), `verify`, `AnnotationQuerySet.annotate_verification_difference`.
- Signals: `annotation_type_changed_handler`, `users/signals.py`; `AnnotationVersion` bookkeeping.
- Permission logic spread over views (team membership, `is_staff`, imageset `public`/`collaborators`/`team`) and `administration/permissions.py`, token scopes.
- Image move (`images/move.py`), crop with source link, backfill command, management commands in `annotations/`, `base/`, `images/`, `tagger_messages/`, `users/`.
- Active-user tracking middleware; image opened/closed tracking.
- Statistics endpoints (team + image).
- ImageSet "version" snapshots; screening mode.

### 1.5 Existing tests (the seed of a conformance suite)
`annotations/{tests,test_frames,test_size_unit}.py`, `base/test_api_queries.py`, `images/test_{move_image,crop_source,backfill_crop_source}.py`, `users/test_token_scope{,_api}.py`, plus `EXACT-API.yml` and the `test.ipynb` notebooks. Coverage is thin → we build a black-box HTTP conformance suite (§3).

## 2. Guiding decisions

1. **Strangler, not big bang.** Rust server runs against the **existing Postgres schema** (no schema change until cutover); Django can be reverted to at any time. nginx routes path-by-path to Rust or Django.
2. **Contract first, but v2 is allowed.** A new `/api/v2` is designed cleanly (see §2a); `/api/v1` and the legacy endpoints that `exact-sync` uses are served by a thin **compat layer** until `exact-sync` is migrated, not as the primary design.
3. **Postgres only.** No SQLite support (Django version doesn't have it either). **Single binary + DB:** no Redis/Celery; sessions, job queue and (optionally) cache locks live in Postgres; slide/tile caches are in-process plus on disk.
4. **Out-of-process for the awkward formats** (iSyntax, possibly CZI/slideio): a small tile/convert sidecar behind a stable internal HTTP interface, so Rust core stays pure and the long tail doesn't block cutover.
5. **In-process Python plugins removed; the external-plugin API (`processing`) is kept** and treated as a first-class public contract (§6).

## 2a. API v2 and `exact-sync` interface compatibility

Mandatory: the **Python interface of `exact-sync`** (`ExactManager` and the generated `v1/api/*` client classes in `~/code/EXACT-Sync`) keeps working for users' scripts. The HTTP wire format underneath may change.

What `exact-sync` actually calls today (Phase 0 finding) is the compat surface:

| Group | Endpoints |
|---|---|
| Auth | HTTP Basic; `Authorization: Bearer <personal access token>`; `GET /timesync/` on connect |
| `/api/v1` CRUD | users/users, users/teams, users/team_membership, images/{images, image_sets, set_tags, screening_modes, registration}, annotations/{annotations, annotation_types, annotation_media_files, verifications, log_image_actions}, administration/products, processing/{plugins, pluginjobs, pluginresults, pluginresultentrys, pluginresultannotations, pluginresultbitmaps} |
| `/api/v1` custom actions | `annotations/multiple_delete/`, `image_sets/list_server/`, `images/index_image/`, `images/{id}/{thumbnail, get_patch, slide_information, update_image_cache, register_images}/`, `registration/{id}/{convert_coodinates, create_inverse_registration}/` |
| Legacy ad-hoc JSON | `annotations/api/annotation/{create,update,load,loadannotationtypes}/`, `annotations/api/annotation/mediafile/upload/<id>/<type>/`, `images/api/{list_imagesets/, imageset/create/, imageset/load, imageset/product/add/, image/download/<id>/?original_image=}`, `images/image/upload/<imageset>/`, `administration/api/{products/create/, products/filter/, annotation_type/create/, annotation_type/delete/}`, `users/api/team/filter/`, `processing/api/plugin_job/create/` |

Strategy:
1. **Design `/api/v2` as the real API**: consistent resource names, JSON bodies everywhere, typed errors, cursor pagination, OpenAPI generated from the Rust types (`utoipa`). The new UI and new `exact-sync` use only v2.
2. **Compat layer** (`/api/v1/*` plus the legacy paths above) as thin adapters over the same service layer. Only the ~45 paths in the table are carried over; other legacy UI-only endpoints are not.
3. **Migrate `exact-sync`** in a separate release, keeping its Python interface: add a v2 transport, auto-detect the server version on connect (`/timesync/` or a new `/api/version`), fall back to v1. Deprecate the compat layer later.
4. **Acceptance:** the `exact-sync` test suite and the notebooks (`SyncImageAndAnnotations.ipynb`, `ClusterAndSync.ipynb`) run in CI against the Rust server. Every `ExactManager` method and generated client method must work; the JSON need not be byte-equal.

## 3. Test strategy (builds in Phase 0/1, drives everything)

- **Conformance suite** (language-neutral, e.g. Python `pytest` + `httpx`, kept in `tests/conformance/`): fixtures load a seeded Postgres dump; every route in the compat surface (§2a) is exercised through `exact-sync` itself and via raw HTTP; responses are recorded as golden JSON (volatile fields normalized) against Django and compared semantically (field-by-field, not byte-wise) with the Rust compat layer. v2 gets its own contract tests from the OpenAPI spec. This is the source of truth for "done".
- **Image golden tests**: for a sample of each supported format, compare Rust DeepZoom tiles to openslide/Python output (SSIM threshold; byte-equality is not expected for JPEG).
- **Rust unit/property tests** for vector validation, unit conversion, similarity.
- **Load test** (k6/oha) on tile endpoint and annotation load of large sets (this is where Rust should win; set budget from Django baseline).

## 4. Frontend (decision: fast at runtime, clean architecture first)

Phase 0 finding: the UI is a large server-rendered Django-template + jQuery/jCanvas/OpenSeadragon app (~9 MB static for the annotation tool, templates in every app). A line-by-line template port would carry the old rendering performance over, so the plan is a new SPA on v2, served from the binary.

**Architecture (separates the fast part from the maintainable part):**
- **`viewer-core`** (framework-agnostic TypeScript package, the only place where speed is engineered): tile scheduler/cache, WebGL (fallback Canvas2D) tile + annotation rendering, R-tree spatial index with viewport culling, hit-testing and geometry in Web Workers, annotation tools as a state machine. No UI-framework imports; unit-testable headless; later reusable (e.g. embeddable viewer).
- **App shell** (routing, forms, tables, admin, auth screens) in a UI framework; it only talks to `viewer-core` through a small typed interface.
- **API client generated from the v2 OpenAPI spec** (`openapi-typescript`), so the Rust types are the single source of truth.
- Assets embedded in the binary (`rust-embed`, precompressed, hashed). Fast transport: immutable tile URLs + ETags, HTTP/2, optional WebP, compact/streamed annotation loads, server-side tile warm-up on `image_opened`.

**Framework recommendation: React + TypeScript + Vite** (TanStack Query for server state, TanStack Table/Router, Radix/shadcn-style components, Vitest + Playwright).
- Why: for a team of 2–8 people that changes over time, hiring/onboarding, library coverage (tables, forms, a11y, i18n) and AI/tooling support matter more than framework microbenchmarks. The performance-critical code is in `viewer-core` and doesn't use React at all, so React's overhead is irrelevant to pan/zoom.
- Alternative: **Svelte 5** (smaller bundles, less boilerplate, smaller talent pool/ecosystem). Reasonable if the team already knows it; the architecture above makes the choice reversible for the shell.
- Not recommended: Rust/WASM UI (Leptos/Dioxus): slower iteration, larger bundles, smaller ecosystem, and no benefit for DOM-heavy admin screens. WASM can be used *inside* `viewer-core` for hot geometry if profiling justifies it.

**Transition:** until the new UI reaches parity, Django keeps serving the old UI (nginx path routing); there is no template port. API clients (`exact-sync`, ML workers) can move to Rust earlier. Cutover to the single binary happens when the new viewer + pages (Phase 7) reach parity.

**Team shape (2–8 people):** (1) backend core/API/auth, (2) slide pipeline/formats, (3) viewer-core, (4) app shell/admin pages, (5) QA/conformance + devops; a team of 2 does these sequentially in the order of §5, 4+ can run Phases 4, 5 and 7 in parallel after the Phase 1–3 foundations are in place.

## 5. Phases

Estimates are for one experienced developer; with two people (one backend, one frontend) the calendar time is roughly 60%. New SPA frontend (§4) assumed.

**Phase 1 – Foundation & conformance harness (2–3 wks)**
- Cargo workspace: `exact-core` (domain types, vector logic), `exact-db` (sqlx, queries), `exact-api` (axum routes, OpenAPI via `utoipa`), `exact-wsi` (slide readers, DeepZoom), `exact-server` (binary), `exact-cli` (management commands).
- Dump the Django schema (`manage.py sqlmigrate`/`pg_dump -s`) → commit as baseline; `sqlx` models checked against it in CI.
- Config via the existing `SQL_*`/`UPLOAD_*` env vars where they still apply (`CACHE_*` and Redis go away).
- Seed DB + conformance harness (§3) incl. running `exact-sync` against Django to record goldens; Docker compose with Django, Rust and nginx.
- Exit: CI green, `/health`, DB connectivity, harness records Django goldens.

**Phase 2 – Auth & users (2–3 wks)**
- Django password-hash verification (PBKDF2, argon2, bcrypt) so existing accounts keep working; new sessions in Postgres (existing Django sessions need not be honoured: users log in again at cutover); CSRF for browser flows.
- Personal access tokens with scopes, Basic auth, RemoteUser header.
- Users, Teams, TeamMembership, UserPreferences endpoints; permission model as one `authz` module with exhaustive tests.
- **In use, so required for cutover:** registration + email activation + password reset (`lettre`, activation-token format compatible or users re-request), **passkeys** (`webauthn-rs`; must read existing `django-passkeys` credential table so enrolled keys keep working, keep the same RP ID/origin), **impersonation** (admin-only, audited, with a visible banner and a way to end it).

**Phase 3 – Read-only core API (3 wks)**
- ImageSet, Image, SetTag, SetVersion, ScreeningMode, Annotation, AnnotationType, AnnotationVersion, Verification, Product, LogImageAction **and the `processing` GET endpoints** (plugins, jobs, results, entries, annotations, bitmaps) in **v2**, plus the v1/legacy compat adapters for the same resources (§2a): pagination, `django-filter`-compatible filters and `expand`/`fields` only where `exact-sync` uses them.
- Exit: `exact-sync` read paths pass against Rust; nginx routes API GETs to Rust.

**Phase 4 – Slide pipeline (4–6 wks, highest risk)**
- **All formats supported today are in scope** (BigTIFF/TIFF, NDPI, VSI, JPEG/PNG, iSyntax, MRXS, DICOM, CZI, MKT, MP4/AVI, NIfTI incl. gz, OME-TIFF z-stacks). Order: openslide formats (SVS/NDPI/MRXS/TIFF/…) → plain JPEG/PNG → DeepZoom with frame/plane → OME-TIFF + z-stack → DICOM → NIfTI → video/MKT → CZI/slideio → iSyntax.
- Because "single binary" conflicts with C/C++ deps, decide per format: statically link (openslide, libvips) where it is feasible; for CZI (slideio), iSyntax (Philips SDK, proprietary) and MKT use a **helper executable shipped next to the binary** (spawned over a pipe/unix socket, restartable), not a separate service. Core server stays one process + helper(s).
- Slide handle cache (replaces `SlideCache`), tile cache (`moka` in memory + on-disk spill), segmentation tiles, **navigator overlay generated from `PluginResultBitmap`** (see §6), crop endpoint, thumbnails, metadata.
- Upload pipeline (chunked; `jQuery-File-Upload` protocol must be matched, or the JS adjusted), file-type sniffing (port `getSlideHandler`), conversion jobs, aux files.
- Exit: golden tiles match for every format; tile p95 latency and throughput measurably better than the Django baseline (set targets from a measured baseline in Phase 1).

**Phase 5 – Write API & annotation logic (4 wks)**
- Create/update/delete/copy/verify annotations, versions, media files, annotation-type admin, image move/delete, image set create/tag/product, screening.
- `processing` writes (job create/update/stop/restart/cleanup, result/entry/bitmap/annotation POST/PATCH/DELETE) incl. `DjangoModelPermissions`-compatible authz and the fake-worker test; bitmap storage/serving.
- Transaction boundaries, optimistic concurrency, similarity detection, signals replacement (explicit domain events), LogImageAction.
- Exit: full conformance suite green incl. writes; Django and Rust can run in parallel against one DB.

**Phase 6 – Secondary features (3–4 wks)**
- **Image registration (heavily used, see §6a):** storage, coordinate conversion, inverse registration, the `register_images` job lifecycle, and the compute worker.
- Export formats (Export/ExportFormat; check what exports exist, e.g. COCO/VOC/CSV), statistics endpoints, datasets, tables (CSV/XLSX), tools/votes, tagger messages, active-user tracking, administration APIs (impersonation, user toggles, cache stats), management commands → `exact-cli`.
- Migrate **EXACT-QueueRunner** to the v2 atomic-claim API (keeping the legacy flow working for unmigrated workers).
- Background jobs: Postgres-backed queue (`sqlx` + `SKIP LOCKED`) with tokio workers inside the same binary; `LISTEN/NOTIFY` for wake-ups; no Redis/Celery.

**Phase 7 – New UI (8–12 wks; starts in parallel with Phase 3 once v2 read endpoints exist)**
- Viewer first (tile rendering, annotation layer, tools, verification, screening mode), then image-set explorer, upload, annotation-type/product/team admin, processing job pages, tables/datasets, statistics, user pages (login, registration, passkeys, preferences, impersonation).
- Embedded in the binary; i18n via JSON catalogues (existing locales to be checked, `LocaleMiddleware` is active).
- Exit: feature-parity checklist signed off; Lighthouse/interaction budgets met (to be defined, e.g. first tile < 300 ms on a local network, 60 fps pan with 50k annotations).

**Phase 8 – Hardening & cutover (2–3 wks)**
- Shadow traffic/mirroring, load tests, security review (authz, SSRF in `gdown`/URL import, path traversal on uploads, token scope enforcement), docs (`mkdocs`), `UPGRADE.md`, Docker images (multi-stage; openslide + vips runtime deps), rollback runbook.
- Cutover: Redis and Django removed, nginx optional. Rust takes over schema migrations (`sqlx migrate`) from the baseline; drop unused tables/columns (zarr/h5py-related if any) in a first migration, after a backup.
- Release a matching `exact-sync` version.

**Total:** ≈ 8–10 months single-developer (backend/API only ≈ 5–6, which is also the point where `exact-sync` and ML workers can move to Rust); with one backend + one frontend developer ≈ 5–6 months. Biggest variance: Phase 4 (formats) and Phase 7 (viewer).

## 5a. Beta deployment against a production backup (first milestone)

Goal: run the Rust server on a **restored copy of the current production system** and prove it behaves like Django on real data, before any cutover. No production traffic is touched.

**Inputs needed from you:** (1) a `pg_dump` of the production DB, (2) the matching media/image files (DB rows reference slide files, aux files, annotation media files, segmentation data, registration files, plugin icons and result bitmaps on disk; a DB-only backup is not enough to test tiles), or a representative subset with a consistent DB subset, (3) the production `settings`/env (Django `SECRET_KEY` only if we want to test session or signed-token compatibility, otherwise not needed), (4) the Django/EXACT version of the dump.

**Safety and privacy:** the backup contains real users, password hashes, emails, PATs, and possibly patient-related image data. Restore only into an isolated environment (own Postgres instance, no outbound email, no external network); disable email sending (`lettre` to a file/log sink); consider scrubbing tokens, emails and session tables (script in the repo); never commit dumps or paths to them (`.gitignore`).

**Steps:**
1. **Restore & baseline (week 1):** restore dump + files; boot **Django** on it (same version as production) as the reference; record goldens (conformance suite, `exact-sync`, mock worker) and performance baselines (tile latency, annotation load of the largest image set).
2. **Schema/data audit:** compare the real schema with `makemigrations`-state: unapplied/extra migrations, indexes, nullability drift, orphaned rows, odd values (invalid vectors, huge JSON, NaN, unknown file types). Output a data-quality report; each finding is a decision: fix in Rust, tolerate, or clean in DB.
3. **Rust on the restored DB, read-only first:** point the Rust server at the same DB (separate DB user with `SELECT` only, then a writable clone). Run the conformance suite and the `exact-sync`/mock-worker tests, then compare Rust and Django results over **all** image sets/annotations (bulk diff job: counts, ids, per-annotation fields, per-user visibility under each team/role).
4. **Authz equivalence test:** for a sample of real users (all roles, team admins, staff, worker accounts) compare the set of visible/editable objects in Django vs Rust. This is the highest-value check for security regressions.
5. **Format sweep:** run every slide in the restored files through the Rust reader; report which fail to open, differ in dimensions/levels/MPP, or produce visibly different tiles vs Django (golden SSIM). This gives the real list of format gaps.
6. **Login/credential compatibility:** real password hashes verify; real PATs and scopes work; passkey credentials load; account activation/reset flows work with the sink mailer.
7. **Writable beta:** on a *clone*, run write paths (create/update/verify annotations, uploads, jobs, registration) via `exact-sync` and the new UI; then run Django's `manage.py check`/read paths against the Rust-modified DB to prove the schema stays Django-compatible (this keeps rollback possible).
8. **Beta users (optional, later):** a small group uses the beta instance on the cloned data (clearly marked as non-production, data discarded), feedback via the parity checklist.

**Exit criteria for beta → cutover planning:**
- 100% of restored slides open or have a documented gap; golden tile checks pass.
- Authz equivalence: zero unexplained differences.
- Bulk diff of annotations/image sets: zero unexplained differences.
- `exact-sync` suite + mock worker green against the clone; QueueRunner smoke test OK.
- Performance targets from the Django baseline met.
- A rehearsed restore → cutover → rollback runbook on the backup.

**What the beta needs from the project (scope cut):** Phases 1–5 plus the minimum of 6 needed by those tests (auth/users, read+write API, slide pipeline, processing, registration) and a first viewer slice (open slide, view/create/verify annotations). The rest of the new UI (admin pages, tables/datasets, statistics) can follow after beta feedback.

### 5b. Local test environment (set up 2026-10-27)

Before the server beta, everything runs against the **local EXACT instance**:
- **DB:** Postgres 16.3 (Postgres.app, `127.0.0.1:5432`, database `exact`, role `exact`; the `exact` role cannot create databases, use the local superuser for scratch DBs). Content: 71 images, 50 annotations, 5 image sets, 2 users, 154 applied migrations, 190 permissions, 15 MB. Note: a Docker `freeleaf-postgres` container also maps port 5432; Postgres.app is the one that answers on localhost today, so always check the target DB name before running tests.
- **Backup:** `backups/exact-local-20261027-111310.dump` (custom format, `pg_dump -Fc`) plus `…schema.sql`, checksum in `backups/SHA256SUMS`. Verified by restoring into a scratch DB (row counts for images, annotations, users, image sets, migrations, permissions matched) and dropping it. `backups/` is mode 700 and in `.gitignore` (contains password hashes).
- **Files:** `~/code/Exact/exact/images` (47 GB; `exact_<team>_<set>` folders, mostly one 44 GB set). Rust tests must treat it as **read-only** (never point write paths at it); writable tests use a copy or a small subset with a consistent DB subset. `image.name` + `imageset.path` form the file path.
- **Rule:** the Rust server and tests never connect to the live local `exact` DB with a writable role; they use a restored copy (`exact_rust_test`, recreated from the dump by script).

### 5c. Phase 1 status (completed 2026-10-27, local environment)

**Delivered** (`make` targets in `Makefile`):
- **Cargo workspace** (`crates/`): `exact-core` (config from the Django `SQL_*` env names, errors), `exact-db` (sqlx pool + schema introspection/diff), `exact-wsi` (DeepZoom pyramid geometry), `exact-api` (axum: `/health`, `/api/version`, `/timesync/` in Django's `{"unixtime": …}` shape), `exact-server`, `exact-cli` (`schema-dump`, `schema-check`). `cargo fmt`, `clippy -D warnings` and `cargo test` are clean (9 unit tests); GitHub Actions workflow in `.github/workflows/ci.yml`.
- **Schema baseline** from the real dump: `baseline/schema-local-20261027.json` (56 tables); `exact-cli schema-check` passes against the restored DB, and Django reports no pending migrations or model drift (154 applied).
- **Restore tooling:** `scripts/restore-backup.sh` (recreates `exact_rust_test`, refuses to touch `exact`), `reference/seed-users.sh` (known test accounts, scratch DB only: `aubreville` superuser, `brummel` staff, `rt_teamadmin`, `rt_member`, `rt_outsider`; password `rust-test-pw`).
- **Reference Django** (unmodified EXACT 4.2.30 code from `~/code/Exact`) on :8001 via `reference/run-django.sh` with its own settings module, so logs/uploads/caches go to `reference/instance/` and the live image folder is only read (symlinks).
- **Conformance harness** (`tests/conformance`): 46 endpoint calls × 5 roles = 230 goldens recorded from Django (`record_goldens.py`; passes 230/230 against Django, i.e. normalization is stable) plus 9 `exact-sync` interface tests (generated client, `ExactManager`, QueueRunner-style `limit=100000000`, legacy image download). Rust currently fails them as expected (225/230 goldens, red baseline, because Phase 2+ is not built yet).
- **Format sweep + tile latency baseline** (`tests/perf`, report `reports/django-baseline.json`): 69/71 images serve a full-resolution tile; median 47 ms, p95 1.6 s (slowest: CZI 3.6 s, two NIfTI 4–5 s, VSI and some NIfTI 0.5–1 s).

**Findings that change the plan:**
1. **The local data is a good format corpus:** 71 images covering tiff (22), png (8), nii.gz (13), vsi (5), mrxs (3), ndpi (3), czi (3), tif/OME (2), dcm (4), mkt (2), mp4 (2), avi (1), jpg (3). Not covered locally: iSyntax, SVS, and other formats the server backup may contain, so the production-backup sweep is still needed.
2. **Tile requests need a session login** (they return a 302 to login for Basic auth); only the REST API accepts Basic/token. The Rust tile route must accept session cookies (browser) and should additionally accept Basic/PAT for API clients (decision for v2: yes).
3. **Two images fail my sweep with HTTP 400** (a NIfTI and a DICOM multi-frame): likely my sweep's tile geometry for 3D/multi-frame images, not necessarily a Django bug; to be checked in Phase 4.
4. **Registration dependencies don't install here:** `qt-wsi-registration`/`probreg` were not installed in the reference env (they need compilation and are not needed for the baselines). Registration golden tests (§6a) need them; deferred to Phase 4/6.
5. **Dev machine toolchain quirk:** pip builds against the Command Line Tools SDK fail (`libSystem.tbd` "unknown architecture"); building with `SDKROOT=/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk` works. Rust builds and links normally. `brew install openslide vips` was run for the reference environment (libopenslide 4.0.0).
6. The local DB is tiny (50 annotations; largest image has 13), so it is not a load benchmark for annotation loading; the production backup is needed for that.
7. `PLAN.md` open point: the legacy `timesync` response shape is `{"unixtime": …}` (done).

**Not done in Phase 1 (moved):** performance baseline for annotation loading (needs production-size data, see 6), ML mock worker (Phase 3/5, needs the processing endpoints), `/api/v2` skeleton and OpenAPI generation (start of Phase 3).

### 5d. Phase 2 status (auth & users; core done 2026-10-27, local environment)

**Delivered**
- **`exact-auth` crate:** verifies every Django hash format (pbkdf2_sha256, pbkdf2_sha1, argon2, bcrypt_sha256, bcrypt) against vectors generated by Django itself; PAT token format/hash (identical to `users.tokens`); random session/CSRF tokens; `make_password` in Django's default format for future resets.
- **Authentication** (`exact-api::auth`) in the exact order and with the exact error messages of the Django deployment: Bearer PAT → Basic → session cookie. Failures are 403 (DRF coerces 401, because the first authenticator has no challenge), including: expired/revoked tokens, read-only tokens on unsafe methods, malformed headers, inactive users. Timing is equalized for unknown usernames.
- **Authorization:** `DjangoModelPermissions` semantics read from Django's `auth_permission`/`users_user_user_permissions`/group tables (superuser = all, inactive = none). Token team restriction reproduces Django's `ScopedTeamSet` (see findings).
- **`/api/v1/users/{users,teams,team_membership}/`** list + retrieve with DRF `LimitOffsetPagination` (default 50, huge limits allowed, sorted-query next/previous links), django-filter filters (`id`, `username[__contains]`, booleans with Django's widget semantics, `team`, `members`, `memberships`, `image_sets`, `is_admin`, `user`), drf-flex-fields `expand`/`fields`/`omit`, DRF-shaped 400/403/404 bodies, `Allow` headers, naive Europe/Berlin datetimes. Writes pass the permission check and then answer **501** (implemented in Phase 5).
- **`/api/v2/auth/{login,logout,me,stop-impersonating}` and `/api/v2/admin/users/{id}/impersonate`:** server-side sessions in our own additive table `exact_rust_session` (created by `exact-cli migrate --confirm-db <name>`; Django tables untouched), HttpOnly + SameSite=Lax cookie, CSRF double-submit header for unsafe session requests (Basic/Bearer exempt). Impersonation reproduces Django's rules (site-admin flag from `UserPreferences`, not yourself, no nesting, only superusers may impersonate superusers) and is audit-logged.
- **Tests:** 8 + 6 + 2 + 2 + 3 Rust unit tests; Django-vs-Rust conformance now **99/294 green** (all 30 users goldens across 5 roles + 64 auth/paging/filter/flex/permission cases + timesync; the other 195 belong to Phases 3–5); 13 + 5 v2 session/CSRF/impersonation tests; Django self-check 294/294 (the harness is stable).

**Findings (behaviour that exists only in Django's code, not in any API doc)**
1. `User.team_set` is monkey-patched at startup (`users/apps.py: ScopedTeamSet`): for **team-restricted tokens every `user.team_set` is narrowed to the token's teams**, which silently scopes the whole API, including `users/*`. Ported via `Viewer.token_teams`. Every later resource must use the viewer scope, not raw memberships.
2. Django runs with `USE_TZ = False`, `TIME_ZONE = 'Europe/Berlin'`: all API datetimes are **naive local time** (e.g. `2026-10-27T11:00:00.500000`), and naive input is read as Berlin time. Ported for output; input handling comes with the write APIs.
3. Related-id lists (`team_set`, `members`, `image_sets`, …) have **no defined order** in Django; Rust returns them sorted by id and the harness compares them as sets.
4. Authentication failures are **403, not 401**, with `{"detail": ...}`; the harness records status, body and `Allow`.
5. Django bug, not replicated: a Basic header with an **empty password returns HTTP 500**. Rust answers 403 like any wrong password.
6. Deliberate hardening vs. Django: tokens of **deactivated users are refused** (Django still accepts them). Please confirm this is acceptable for existing worker accounts (it is only relevant if a service account is deactivated but its token is still used).
7. Impersonation and user administration are gated by `UserPreferences.is_site_admin`, **not** `is_staff`/`is_superuser`.
8. `exact-sync` auth: Basic and `Bearer pat_…`; nothing else needed.
9. Mistake caught: a CSRF comparison bug (operator precedence) was found by the first v2 test run and fixed before anything depended on it; a stray `exact_rust_session` table was created once in the live local `exact` database by a `migrate` call without `SQL_DATABASE` (empty, additive, dropped immediately). `exact-cli migrate` now requires `--confirm-db <name>` matching the configured database, and `make migrate`/`make restore` pin the scratch DB.

**Phase 2 completed (second round, 2026-10-27), after your answers**
- **Decisions:** token hardening for deactivated users confirmed; no `REMOTE_USER`/SSO; the production server has no mail server and **self-registration is abolished**: users are invited.
- **Invite-only onboarding (no e-mail):** `POST /api/v2/invitations` (site admin: any teams or none; team admin: only teams they administer) returns a one-time link `/invite/<token>` that the admin hands over; the token is stored only as sha256 and shown once. `GET /api/v2/invitations/token/{token}` (public) tells the accept page which teams the person joins; `POST …/accept` creates the user in one transaction (username + password policy equal to Django's validators incl. its common-password list, preferences row, team memberships, not an admin), logs them in and burns the link. Links expire (default 7 days = Django's `ACCOUNT_ACTIVATION_DAYS`, max 30), can be listed and revoked. There is no registration endpoint at all (tested). Django's `/accounts/register/` disappears at cutover.
- **Forgotten passwords without mail:** site admins create a one-time reset link (`POST /api/v2/admin/users/{id}/reset-link`, default 1 day, audit-logged); accepting it sets the password under the same policy and **ends all existing sessions** of that user. Only superusers can reset superusers.
- **Passkeys (WebAuthn) in Rust:** `exact-auth::webauthn` reads the `django-passkeys` table and stored credential format (`websafe(AttestedCredentialData)`), verifies assertions (rpIdHash, origin by python-fido2's rule incl. public-suffix check, challenge, user presence, ES256/RS256 signature) and registrations (writes byte-identical tokens). Endpoints: `POST /api/v2/auth/passkey/{begin,finish}` (usernameless/discoverable or by username; uniform failure message; one-time challenges in `exact_rust_challenge`), `POST …/passkeys/register/{begin,finish}` (session + CSRF), `GET/PATCH/DELETE …/passkeys`. The test passkey was **enrolled through the real django-passkeys endpoints** with a software authenticator (`reference/enroll_passkey.py`, `tests/conformance/softkey.py`), proven to log in to Django, saved as `tests/fixtures/passkey.json` and re-seeded on every restore; Rust accepts it (a Django-enrolled key works in Rust) and 14 further passkey tests cover tampering, replay, disabled keys and ownership.
- **Verification:** `make verify` (script `scripts/verify.sh`) restores the scratch DB, starts both servers, runs unit tests + lint, then read-only suites, then the mutating suites. Current result: unit tests 28/28; Django self-check 294/294; Rust vs Django goldens 99/294 (the rest are Phase 3+); `exact-sync` 1/9 (rest Phase 3); v2 auth/passkey/invitation suites 39/39.

**More findings**
10. `django-passkeys` sends `displayName: []` and a **double-encoded user handle** (`websafe(urlsafe_b64encode(username))`); Rust copies the handle encoding for compatibility. Django ignores `userHandle` and signature counters and does not require user verification; Rust matches that (documented parity, not a recommendation: we should consider requiring UV and counters after cutover).
11. The dev setting `FIDO_SERVER_ID="127.0.0.1"` cannot work in browsers (IP addresses are not valid RP IDs and need https), so the **production RP ID is unknown to me**: it must be taken from the production `settings.py` and set as `FIDO_SERVER_ID` for Rust, otherwise every enrolled passkey fails. Safari beta test: the Rust beta must be served over https on a host that matches that RP ID (or a subdomain of it).
12. Supported credential algorithms are ES256 and RS256 (what Safari/Touch ID, Chrome, Windows Hello and most security keys use). Django would also have accepted EdDSA and the ECDSA P-384/521 variants; **the production-backup audit must parse every stored passkey token and report any other algorithm**.
13. Test hygiene lesson: tests that create users change what the recorded Django goldens should say, so suites are ordered (restore → read-only → mutating) in `scripts/verify.sh`.

**Not done / deliberately postponed**
- Login rate limiting and lockout (Django has none; invitation/reset/login endpoints are unthrottled). Do before exposing the beta beyond your network.
- Admin user-management endpoints (`administration/users/api/*`: list, toggle staff/active, update, delete, team add/remove/toggle-admin, random password): UI-only, Phase 6/7 with the new UI.
- The accept/invite pages themselves belong to the new UI (Phase 7); until then links can be used through the API.

### 5e. Beta host: exact-beta.deepmicroscopy.org

- **Serving:** https only (WebAuthn and `Secure` cookies need it); set `EXACT_COOKIE_SECURE=1`, `FIDO_SERVER_NAME=EXACT`, and `FIDO_SERVER_ID` per the rule below. TLS termination by any reverse proxy (Caddy/nginx) in front of `exact-server`; the single binary listens on `EXACT_LISTEN`.
- **Passkey relying-party rule (browser-enforced, cannot be worked around):** a passkey is bound to its RP ID and works only on that host or its subdomains. Production is `exact.hs-flensburg.de`, so its RP ID can only be `exact.hs-flensburg.de` or `hs-flensburg.de`. **`exact-beta.deepmicroscopy.org` is in a different domain, so production-enrolled passkeys can never work on it**, whatever the setting is. Consequences:
  - On the beta host (`FIDO_SERVER_ID=exact-beta.deepmicroscopy.org`) everyone re-enrolls a passkey. That tests enrollment, login, Safari/iCloud Keychain and the whole flow, but not the production keys.
  - Compatibility with **production-enrolled keys** is tested separately by the software-key tests (done, §5d) and finally at cutover on `exact.hs-flensburg.de` with `FIDO_SERVER_ID` set to production's exact value. To test it earlier with real production keys, a second beta hostname under `hs-flensburg.de` would be needed (works if production's RP ID is `hs-flensburg.de`, not if it is `exact.hs-flensburg.de`).
  - **Resolved: production `FIDO_SERVER_ID` = `exact.hs-flensburg.de`** (a second beta host under `hs-flensburg.de` could therefore only test production keys if it is exactly that host). **Cutover must keep the production host name and RP ID unchanged** (same `exact.hs-flensburg.de`, same `FIDO_SERVER_ID`); otherwise all existing passkeys are lost and users must re-enroll (password login keeps working).
- **Beta data and safety:** the beta runs on the restored copy of the production backup (never the live database), outbound mail is not configured anyway, invitations/reset links are the only way in, and the beta must not be indexed or open to the public: restrict it (VPN, IP allow-list or basic-auth at the proxy) until login rate limiting exists (§5d).
- **Mixed-content/URL note:** invite links are returned as paths (`/invite/<token>`); the new UI (or the admin) prefixes the beta host.

### 5f. Phase 3 status (read-only core API; compat layer done 2026-10-27, local environment)

**Delivered**
- **Resource engine** (`exact-api::compat::{engine,specs,computed}`): every `/api/v1` resource is one declarative `Spec` (table, visibility SQL, serializer fields in Django's order, relations, filters); a single implementation provides scoped querysets, django-filter semantics (query parameter names and validation messages taken from Django's own FilterSets via `reference/dump-filters.sh`: `exact`, `contains`, `in`, `range`, `lte/gte`, `ModelChoice`/`ModelMultipleChoice` incl. existence checks, `Choice`, naive-Berlin datetimes, both boolean widgets), `LimitOffsetPagination`, related-id lists, and drf-flex-fields `expand`/`fields`/`omit`. The users/teams/memberships code of Phase 2 now runs on the same engine (hand-written handlers deleted).
- **22 resources, list + retrieve:** users, teams, team_membership, images, image_sets, set_tags, set_versions, screening_modes, registration (incl. `rotation_angle`, `inv_matrix`, `get_scale`, `get_inv_scale` with pseudo-inverse math), annotations (incl. `concealed`/`blurred`/`verified_by_user`), annotation_versions (`has_changes`), annotation_types, annotation_media_files, verifications, log_image_actions, administration/products, and the six `processing/*` resources used by ML workers.
- **Legacy JSON endpoints used by `exact-sync`:** `images/api/list_imagesets/`, `images/api/imageset/load[/]` (all `filter_annotation_type_id` modes incl. Verified/Unverified/NoAnnotations/ComputerGenerated, collaboration types, `ImageSet.has_perm('read')` incl. public sets), `annotations/api/annotation/load/` (all parameters), `annotations/api/annotation/loadannotationtypes/`, `users/api/team/filter/`.
- **Authentication cache:** successful Basic-auth password checks are remembered in memory for 5 minutes (`AUTH_CACHE_SECONDS`), keyed by a per-process-secret digest of (user, password) and bound to the stored hash, so a password change invalidates immediately (tested through the reset-link flow). This matters because Django's 600 000 PBKDF2 rounds cost ~100 ms on *every* API request of `exact-sync` and the ML workers.
- **Seed data** for resources that are empty locally (plugins, jobs, results, entries, bitmaps, result annotations, set versions, annotation versions, media files) so comparisons are not vacuous; recorded and replayed with all three roles and token scopes.

**Results (`make verify`)**
- Rust unit tests 39/39 (workspace), clippy clean; v2 auth/passkey/invitation suites 39/39.
- Django vs Rust: **1701 recorded cases (every resource × every filter × `expand`/`fields`/`omit`/pagination × roles superuser, member, outsider, team-restricted token, read-only token, legacy params and permission edge cases): 1686 pass; the 15 failures are all `slide_information` (Phase 4). The same 1701 cases pass 1701/1701 against Django itself (the harness is stable).**
- `exact-sync` interface tests: 7/9; the 2 failures need slide reading and file download (Phase 4).
- Performance, release build, same machine, Basic auth on every request (Django 4.2 + gunicorn-less `runserver --noreload` vs Rust): 14–50× faster, e.g. images list 150 ms → 7 ms, annotations expand 194 → 8 ms, 3 834 log rows 230 → 17 ms, users 105 → 2 ms. (Django's own cost is dominated by the password hash; once an API client uses a session or token the gap shrinks, but `exact-sync` and the ML workers use Basic.)

**Findings (Django behaviour to know about; all reproduced for compatibility unless noted)**
1. **Processing data is visible to every authenticated user**: plugins, jobs, results, bitmaps, results' annotations have no team scoping, so any user (e.g. an outsider) can list other teams' ML jobs and results. ML worker accounts probably rely on it. Kept in `/api/v1`; **recommendation for v2: scope by team, with an explicit "worker" permission for the queue runner.**
2. `loadannotationtypes` without `imageset_id` returns the active annotation types of *all* teams; `users/api/team/filter/` and `list_imagesets` use plain team membership (ignoring token team restrictions), and the legacy endpoints let non-members read **public** image sets. Kept.
3. Django returns **HTTP 500** (not reproduced; no clients can depend on it) for: `annotations?deleted=<bool>`, `images?expand=annotations`, an empty Basic password; `administration/api/products/filter/` (used by `exact-sync.filter_products`) is **broken in Django itself** (`request.QUERY_PARAMS` no longer exists), so it is not ported; `exact-sync.filter_products` already fails against the current server.
4. Many list endpoints have **no ORDER BY** in Django (images, log actions, versions …): physical order, so pagination windows are not stable. Rust orders by id. The harness compares object lists as sets.
5. Django's `vector_x_min`/`vector_y_min` annotation filters have a bug (the `gte` is never applied, only `vector IS NOT NULL`) and `vector_y_max` filters on `y1`; reproduced exactly.
6. `SetVersionViewSet` joins through image sets without `DISTINCT`, so a version shared between two of the user's image sets is listed twice in Django; Rust lists it once (hardening).
7. Harness lessons: seed data must be deterministic (random UUIDs in the seed made Django disagree with its own recordings), Django's `Allow` header lists methods in per-process random order, and several Django lists are unordered, so the harness compares headers and object lists as sets.
8. Environment: with Postgres.app, the **first connection of a new binary takes several seconds** (its `auth_permission_dialog` extension); `DB_CONNECT_TIMEOUT` (default 10 s) is now configurable; `verify.sh` uses 60 s.

**Not done (moved)**
- **Slide-dependent endpoints → Phase 4:** `images/{id}/slide_information`, `thumbnail`, `get_patch`, tiles/DZI, `images/api/image/download`, `update_image_cache`.
- **Writes → Phase 5** (all POST/PUT/PATCH/DELETE answer 501 after the permission check) incl. the custom write actions (`multiple_delete`, `register_images`, `create_inverse_registration`, `index_image`, uploads).
- **Small read actions:** `annotations/count/`, `image_sets/list_server/`, `registration/{id}/convert_coodinates/` (pure geometry, goes with registration in Phase 5/6).
- **`/api/v2` resource endpoints and the OpenAPI spec:** not started. They need design decisions (below) rather than porting, so they are a separate step "3b".

**Decisions needed for v2 (3b):** (a) team-scope the processing resources in v2 (finding 1); (b) cursor pagination and a stable default order; (c) one URL scheme without trailing slashes and real REST verbs; (d) datetimes in RFC 3339 UTC instead of naive Berlin time; (e) JSON field names: keep Django's (`objectivePower`, `FrameDescriptions`) or normalize to snake_case. My recommendation: yes to (a), (b), (c), (d); (e) normalize in v2 only (v1 stays as is).

### 5g. v2 read API (3b; done 2026-10-27, local environment)

Decisions (user, 2026-10-27): (1) processing data is team-scoped in v2 (v1 keeps the Django behaviour; an explicit worker permission for the queue runner arrives with the processing write API); (2) cursor pagination with stable id order; (3) no trailing slashes, real REST verbs; (4) RFC 3339 UTC timestamps; (5) snake_case field names in v2 only.

Implemented: `GET /api/v2/{resource}` (`items`, `next_cursor`, optional `count=true`, `limit` 1..1000) and `/api/v2/{resource}/{id}` for all 22 resources, on the same engine as v1 (`Ctx.v2`, `list_v2`, `effective_scope`). Filters, `expand`, `fields`, `omit` work with v1 semantics but snake_case names. `tests/conformance/test_v2_resources.py` (9 tests) is part of `make verify`.
Open: writes (Phase 5), OpenAPI document (generate from the resource table + utoipa for hand-written endpoints), `ordering` parameter beyond id.

### 5h. Phase 4 status (slide pipeline, slice 1; 2026-10-27, local environment)

Done: `exact-wsi` with a `Slide` trait; OpenSlide loaded at runtime (`dlopen`, `OPENSLIDE_LIB`; formats without it are disabled, the server still starts) covering SVS/NDPI/MRXS/Ventana/Leica/DICOM/generic pyramidal TIFF; plain JPEG/PNG/TIFF (`image` crate); NIfTI-1/2 (+gz) with RAS reorientation and windowing; DeepZoom generator port (tile 254, overlap 1, **`limit_bounds=False`** as EXACT's openslide-python default); slide cache (20 handles), tile cache (512 MB, weighted). Endpoints (v1 under `/api/v1/images/images/{id}/…`, v2 as `/api/v2/images/{id}/{slide-information,thumbnail,get-patch,download}` and `/{z}/{frame}/tile[_files/…]`): slide_information, thumbnail (on-disk `_thumbnail.png` cache as in Django), get_patch (max 2048, Django error text), DZI, tiles, update_image_cache, image download (MRXS/VSI zipped with their companion directories). `tests/perf/compare_slides.py` compares both servers per image (slide information exact, DZI attributes, full-res tile by mean abs diff ≤ 4.5, low tiles by size, thumbnail).

Result: 15/15 slide_information conformance cases pass (5 are skipped on purpose, see finding 1); compare_slides: PNG/JPEG/TIFF/NIfTI/NDPI/MRXS/generic TIFF/OME-TIFF (2 of 3) match.

Findings:
1. Django serves `slide_information` (and thumbnails) from its cache **before** the team check: a user outside the team gets 200 if anyone asked earlier. Rust always checks (404). Harness skips these (`cache_leak`).
2. In the reference environment (libopenslide 4.0 + openslide-python 1.4.7) Django reads blank regions from lower pyramid levels of some TIFFs; Rust (same libopenslide through the C API) reads them correctly. Therefore low-resolution tiles are compared by size only; tile pixels are checked at full resolution. Several plain TIFF/JPG ids (78, 98, 99, 102) also differ against Django but match a PIL crop of the file: Django output there looks cache-contaminated; Rust is right.
3. The DB `width/height` of some images (e.g. id 41) is stale; slide geometry always comes from the file.

**slideio formats (CZI, VSI, DICOM) done via a helper process** (decided 2026-10-27): `helpers/slideio_helper.py` speaks a line-JSON + raw-RGBA protocol over stdin/stdout; `exact-wsi/src/slideio.rs` runs a pool (2 workers, `SLIDEIO_WORKERS`), restarts a crashed helper and retries once. Config: `SLIDEIO_PYTHON` (interpreter with the `slideio` wheel; wheels exist for macOS/arm64 and Linux/x86_64), `SLIDEIO_HELPER` (script path, default searched next to the binary). Building slideio's C++ from source needs a custom Conan index and OpenCV (hours), so the helper is Python for now; because the protocol is language-neutral it can later be replaced by a C++ helper without touching Rust. compare_slides: all 7 CZI, VSI and 4 DICOM test images match Django. DICOM volumetric (CT/MR) beyond slideio is still open: a native reader (`dicom-rs`) is an option for the volume case.

**Native DICOM and MKT done** (2026-10-27): `exact-wsi/src/dicom.rs` reads uncompressed multi-frame DICOM (8/16 bit, grayscale or RGB, rescale slope/intercept, window from the file or from volume percentiles, frames as time series or z-stack for CT/MR/PT/NM) without Python; compressed transfer syntaxes and whole-slide DICOM fall back to slideio. `exact-wsi/src/mkt.rs` is a port of `cellvizio.py` (type-5 index chunk, int16 frames, circular-mask percentile window, `[height, width]` level dimension quirk kept). Both Cellvizio `.dcm` (4) and `.mkt` (3) test images match Django in compare_slides; unit tests cover a synthetic 16-bit CT volume. Not yet covered by real data: compressed DICOM (JPEG/J2K/RLE) natively, multi-file DICOM series, DICOM with palette or YBR.

**Video (MP4/AVI) done natively with `ffmpeg-next`** (2026-10-27, cargo feature `video`, on by default; `--no-default-features` builds without it): `exact-wsi/src/video.rs` decodes in process through the system libav* libraries (ffmpeg >= 5, dev packages needed at build time: `libavcodec-dev` etc. + libclang; runtime needs the shared libs). The Rust `opencv` crate was rejected: it binds the full C++ OpenCV, which needs a system OpenCV and is much heavier than libav. Seeks land on the preceding keyframe and decode forward; sequential playback reuses the decoder; 32-frame LRU. Frame index from pts uses the stream's nominal rate (`r_frame_rate`) - the average rate drifts and shifted frames by one (found against ffmpeg-extracted frames). MPEG-4 part 2 (mp4) and MJPEG (avi) test files verified: frame content matches ffmpeg exactly at frames 0..158, tiles match Django within JPEG noise. MKT non-square frames: Rust now reports (width, height) correctly; Django swapped them (`KNOWN_DIVERGENT` in compare_slides, id 109).

**OME-TIFF native** (2026-10-27): `exact-wsi/src/tiff.rs` (TIFF/BigTIFF IFD + SubIFD parser; tiled and striped 8-bit pages; raw, LZW, Deflate, JPEG incl. shared JPEGTables; horizontal predictor) and `ome.rs` (OME-XML via quick-xml: series = z planes, label/thumbnail series skipped, SubIFD pyramid levels, integer downsamples as Django, frame descriptors `z=<pos> <unit>`, default frame at z=0). All 5 OME test files work; z-stack frames verified frame-exact against Django (images 57/58/108, tile diff 2-5 from JPEG re-encoding only; the nearest Django frame is always the same frame index). Image 6 (83200x53504, JPEG tiles, 13 planes x 5 levels) is **black in the reference Django** because its environment lacks `imagecodecs`; Rust decodes it and a tile matches an independent PIL decode (mean abs diff 0.13). Production Django presumably has imagecodecs - re-check against the production image before cut-over. Not supported natively (falls back to OpenSlide/plain readers): 16-bit or multi-channel OME planes, planar configuration 2, JPEG2000/PackBits compression, OME images with Z/T/C > 1.

Not done yet (compare_slides returns 400 in Rust): iSyntax, multi-page non-OME TIFF as z-stack frames (`ImageSlide3D`), MPR planes for NIfTI, navigator overlay, upload pipeline, UI tile routes `/images/image/{id}/…`. Decision needed for the helper-process approach (slideio for VSI/CZI/DICOM; ffmpeg or opencv for video; MKT by hand).

### 5i. UI slice 1 and slide-reader findings (2026-10-27, local environment)

**Target UI** (user, 2026-10-27): only the current "Lightroom v2" frontend (user pref `frontend = 3`: `index_v2`, `imageset_v2`, `annotate_v3`); the older templates are not reproduced. Visual language: dark glass, purple accent `#aa0fea`.

**Done** - `frontend/` (React 18 + TypeScript + Vite, TanStack Query, react-router, OpenSeadragon; served by the Rust binary from `frontend/dist` with SPA fallback, `EXACT_STATIC_DIR`; `rust-embed` still to do):
- Login (session + CSRF via `/api/v2/auth/*`), image set index (team sidebar, search, thumbnails), image set page (grid, filter), viewer (OpenSeadragon on the v2 DeepZoom routes, read-only annotation overlay on a Canvas2D layer with viewport culling, annotation type legend with toggles, frame slider, MPR plane switch for volumes).
- `src/viewer-core/` is framework-free (shapes, annotation layer, tile source) with Vitest unit tests; pages only talk to it through a small API.
- New server endpoints for the viewer: `/api/v2/images/{id}/metadata` (size, levels, frames, planes with frame counts and descriptors), viewer tile routes for old-UI paths `/images/image/{id}/{z}/{frame}/tile[_files/...]` and `/api/v2/images/{id}/{z}/{frame}/...` (single-file volumes: `z` = plane 1/2/3 as in Django).
- `frontend/e2e/smoke.mjs` (playwright-core on the system Chrome): login, set list, image grid, viewer on a pyramid TIFF, a NIfTI volume (3 planes + slider), an OME z-stack (frame change), a video (frame change); screenshots with `SHOTS=dir`. `make ui`, `make e2e`.
- Passkey login screen not yet in the UI (API exists).

**Not yet in the UI** (old Lightroom v2 features still to build): annotation tools and editing (needs the Phase 5 write API), image set page actions (move/copy/upload/delete, tags, versions, export, plugin jobs), project/team admin screens, user preferences, registration/invite screens, processing UI, `annotations/count`.

**Findings from the UI work**
1. **libopenslide 4.0 reads generic pyramidal TIFFs nondeterministically** at lower levels (the same region gives different pixels on each read, even from separate handles and the Python bindings). Rust now reads generic TIFF pyramids with its own reader (`generic_tiff.rs`, LZW/Deflate/JPEG, RGBA, resolution tags); parallel vs sequential tile requests give identical bytes. Vendor formats (SVS, NDPI, MRXS, ...) still use libopenslide: **re-check them against the user's SVS and an NDPI** before beta, and pin the libopenslide version in deployment docs.
2. **Thumbnails**: Django cached some thumbnails rendered from those corrupt levels as `*_thumbnail.png` next to the images (e.g. image 20, 19) and serves them forever. The Rust server no longer reads or writes thumbnails in the image folders; it owns `EXACT_CACHE_DIR/thumbnails/<id>-<mtime>-<size>.png` (default `./cache`). A one-off cleanup of the old files in production is optional.
3. OpenSeadragon forces `position: relative` on its element; the container must get its height from normal flow (found by an e2e failure: zero-height viewer).
4. Dev builds: `[profile.dev.package."*"] opt-level = 2` - image decoding in unoptimized builds was too slow to use.
5. **Big-endian TIFF** (`MM\0*` / `MM\0+`, e.g. `test.ome.tiff` from Bio-Formats) was not recognised as TIFF, so it fell through to libopenslide with a single level: every low zoom and every thumbnail decoded the full 17557x8649 image (thumbnail 49 s, viewer never finished). Fixed in `formats::is_tiff_magic`; thumbnail now 22 ms. Django reports a single level for this file too (compare_slides lists id 2 as known divergent).
6. **Broken TIFF pyramids**: images 19, 48 and 95 (and probably more files from the same export script) have pyramid pages 1..n that are mid-grey noise (mean ~121) instead of downscaled copies of page 0; viewers show the grey levels first and thumbnails/overviews come out wrong. `generic_tiff.rs` compares the centre window of each level with level 0 (mean colour, tolerance 20) and drops a level and all smaller ones when they disagree; DeepZoom then derives the zoom levels from the remaining pages. The clean ones (41-56, 70, 92) keep their pyramids. A warning is logged per file. The offending files should be re-exported at some point.
7. **Zoom-level registration (wobble)**: the DeepZoom tile was an integer-cropped region resized (aspect-preserving, like openslide-python) to the tile size; tiles of a level were therefore scaled slightly differently (up to ~0.9 px shift between neighbouring levels when the level height is not a multiple of the downsample, visible as wobbling while levels cross-fade). Tiles are now sampled from a floating-point source rectangle with the true level scale (`level size / slide level size`) via `fast_image_resize` (Lanczos3, fractional crop box) and are always exactly the tile size. `/tmp`-style measurement: shift vs a reference reduction of the PNG was -0.86 px at one level, now <= 0.02 px at every level (images 103 and 119). Django has the same rounding artefact.
   **Same for slideio-read slides (VSI, found on image 31):** slideio's levels are exact 2^k decimation grids (every level is bit-registered with level 0 reduced by exactly 2^k when read at aligned positions) but report `1/scale` = 16.0007 because their stored sizes are rounded down. Two effects: (a) reads at positions that are not multiples of the downsample are displaced by up to ~1 level pixel (measured 0.0 px aligned, 0.8-1.4 px otherwise) - `SlideIo` now reports the exact integer downsample, so every read is aligned, and requests the region with exactly that size; (b) a level covers `level-0 width / downsample` pixels of extent, not its stored width - the generator derives the DeepZoom scale from that (`zw / (w0 / down)`), which removed a systematic 0.2-0.5 px drift between coarse zoom levels. Measured on image 31 (3 regions, 7 level pairs): average level-to-level displacement 0.238 px -> 0.042 px, coarse pairs exactly 0.00. `level_downsamples` of VSI/CZI slides in `slide_information` are now 16.0 instead of 16.0007 (compare_slides tolerance 0.1%).
   **Zeiss CZI (found on image 28) has levels that are not registered with each other even when read natively at aligned positions:** consecutive levels are displaced by 0.2-0.8 px of the coarser level, in a regular alternating pattern, at every position (so it is a property of how the pyramid was produced). `exact-wsi/src/registration.rs` measures this once per slide: up to three textured spots (4x4 cells of the smallest level ranked by contrast), each level against the previous one reduced by the integer ratio (integer-shift SSD search + parabolic refinement, +-3 px), chained to level 0; a level is corrected only when the two closest spots agree within 0.15 px, offsets below 0.04 px are treated as noise. The generator adds the offset when it samples a tile (`DeepZoom::tile`, via `Slide::level_offsets`). Estimated lazily on the first tile request of a slideio slide (1.6-5 s once) and stored in `<cache>/registration/<hash(path,size,mtime)>-v2.json`, so restarts read it (0.2-0.6 s for the DZI incl. opening). Result: average level-to-level displacement over 3-7 level pairs per image, 0.04-0.10 px for images 15, 16, 17, 28, 31 (before: 0.2-0.7 px for the CZIs); VSI files measure zero offsets and are untouched. Unit tests build a pyramid with a known displacement (including a chained one) and check the estimate to within 0.15 px.
   **Registration offsets are stored in the database** (user request, 2026-10-27): table `images_pyramidregistration` (image_id unique, `offsets` jsonb `[[dx,dy],...]`, `algorithm`, `file_size`, `file_mtime`, `updated`), **shared with EXACT/Django** - EXACT's migration `images/0041_pyramidregistration` (PR DeepMicroscopy/Exact#166) and `crates/exact-db/migrations/0005_pyramid_registration.sql` use identical DDL with `CREATE TABLE IF NOT EXISTS`, so either side can create it first. `scripts/check-schema-sync.sh` (`make schema-sync`, also a `make verify` step) builds two databases from the backup (Django first / Rust first), compares the columns and checks Django's migration record and the schema baseline (`baseline/schema-local-20261027.json` regenerated with the table; `schema-check` ignores Rust-owned `exact_rust_*` tables). `get_dz` in `slides.rs` reads the row, uses it only if size, mtime and `registration::ALGORITHM` match, otherwise measures once (per-file lock) and upserts; first open 1.6-5 s, afterwards 0.2-0.6 s even after a restart. **Level 0 is never shifted**: offset 0 is forced in `registration::estimate_level_offsets`, `DeepZoom::build` and `DeepZoom::tile` (unit test: bit-identical level-0 tiles with an absurd level-0 offset; same test in EXACT's PR). Measured on the real Django server with EXACT PR #166: CZI/VSI neighbouring-level displacement 0.26-0.36 px -> 0.04-0.10 px.
8. **verify.sh is sensitive to logins during the run** (`last_login` filter goldens): do not use the verify servers (8001/8002) while it runs. It prints failing test names now.
9. MPR planes: `compare_planes.py` (Django UI routes vs Rust) matches for 12 of 13 NIfTI volumes; image 85 (SwiftWave_vyljummk.nii.gz) still differs a lot and needs investigation.

### 5j. One-time repair of damaged TIFF pyramids (2026-10-27)

Decision (user): offer the repair to the user; **same image** (id, annotations, file name unchanged), the repaired file takes the original's name and the **original is kept as `<stem>.orig.<ext>`**; lower levels use the original page's compression (level 0 chunks are copied as stored, so its pixels are bit-identical). One-time, and it must work for huge files.

Implemented:
- Detection: `Slide::issues()` (`damaged_pyramid` from `generic_tiff.rs`), exposed as `issues` in `/api/v2/images/{id}/metadata`.
- Engine `exact-wsi/src/repair.rs` + `tiff_write.rs` (streaming BigTIFF writer): level 0 raw chunks copied; each tile of a lower level is the 2x2 reduction of four tiles of the level below, read back from the file being written, so memory stays flat for any size; levels until the longer side is <= 512; written to `<file>.repair-tmp`, verified (opens, all levels, no issue), then renamed; failure leaves the original untouched.
- API: `POST /api/v2/images/{id}/repair` (202, background job; needs change permission on images; 409 when nothing to repair or already running), `GET .../repair` (status, progress, backup file name), `POST .../repair/restore` (undo; the repaired file is kept as `<stem>.repaired.<ext>`). State in the additive table `exact_rust_image_repair` (migration 0004); a restart marks interrupted jobs failed.
- UI: viewer banner offers the repair, shows progress (survives leaving the page), reloads when done, shows the backup name with an Undo link.
- CLI: `exact-cli check-images <dir>` (read-only scan; 30 TIFFs in the test folder: 6 damaged: 19, 48, 95 and the small 10.tiff/11.tiff) and `exact-cli repair-image <file>`.
- Tests: unit test (synthetic damaged TIFF: detect, repair, level 0 identical, restore), `scripts/e2e-repair.sh` (browser flow on a scratch copy), checked with PIL, tifffile and libopenslide that they read the repaired file; the 24.6 MB test file repairs in ~1 s and grows 2%.
- Requires write access of the server to the image folders (the Rust server was read-only before; uploads need it anyway).

Open: batch repair from the UI for a whole set, repair of OpenSlide-handled TIFF variants (SVS/NDPI are not touched), 16-bit or planar TIFFs (rejected with a message), JPEG-compressed levels use 4:2:2 subsampling; upload-time check.

### 5k. Moving through frames: z-stacks, volumes, movies (2026-10-27)

Requirement (user): going through z levels should be smooth (blending), closer to a microscope; microscopy z-stacks, radiology volumes and movies are different things with different controls: **microscopy z-stack = vertical slider on the right with smooth blending, start/end shown as real positions; radiology volume = vertical slider on the right, discrete slices, no blending; movie / time series (MP4, AVI, Cellvizio MKT/DICOM) = horizontal slider at the bottom.**

Done:
- `exact_wsi::FrameKind` (`None | ZStack | Volume | TimeSeries`) on the `Slide` trait, with `frame_labels()` and `z_positions()`; OME-TIFF multi-series and slideio CZI/VSI z slices = ZStack (OME: real `PositionZ` + unit; slideio: `z_resolution` based, relative to the first plane), NIfTI and DICOM CT/MR/PT/NM = Volume, video/MKT/other DICOM = TimeSeries. `/api/v2/images/{id}/metadata` returns `frame_kind`, `frame_labels`, `z_range {start,end,positions,unit}`.
- Viewer: `viewer-core/zBlend.ts` (`ZBlender`): every plane is its own OpenSeadragon tiled image with identical geometry; at position `k+f` plane `k` is opaque and plane `k+1` is drawn on top with opacity `f` (linear cross-fade); planes `k-1..k+2` are kept loaded (opacity 0.001 so their tiles keep loading), the rest is dropped; no blending for volumes (only the nearest slice visible, neighbours preloaded). Slider drag is continuous (`step=any`) for z-stacks; Page Up / Page Down step one plane with an eased animation (~160-420 ms); the viewer persists while planes change (no re-open, no flicker). `components/FrameControls.tsx`: `ZSlider` (vertical, right; top = last plane; ends = real positions when known, otherwise labels; current position and `n / N`) and `TimeSlider` (bottom, first/last/current time label).
- e2e: volume (vertical, one slice visible), OME z-stack (real positions at the ends, 5.5 -> opacities 0.5/1, Page Up), movie (bottom slider only).

Open: annotation visibility per plane (annotations are drawn on every plane), wheel/keyboard focus handling inside the viewer (arrow keys still pan), mouse wheel over the slider, playback (play/pause, fps) for movies, a time axis for CZI time series, preload tuning for very large planes.

## 6. Processing / ML-plugin interface

**Kept (public contract for external ML workers):**
- `/api/v1/processing/{plugins,pluginjobs,pluginresults,pluginresultentrys,pluginresultannotations,pluginresultbitmaps}` – full CRUD (`ModelViewSet`), with the existing query filters: jobs (`image_id`, `user_id`, `filter_ids`), plugins (`imageset_from_image_id` → plugins linked via image-set products), results (`image_id`, `job_id`, `plugin_id`), annotations (`image`, `annotation_type`, `pluginresultentry`, `plugin`), bitmaps (`image`).
- Job lifecycle fields workers rely on: `processing_complete`, `eta_time`, `error_message/detail`, `attached_worker`, `updated_time`.
- UI + helper endpoints: job index/detail/stop/restart/cleanup, `submit/<plugin>/<image>`, `submit_imageset`, `api/plugin_job/create/`, `administration/api/plugins/product/{add,delete}`, `images/api/image/plugins/`. Plugin–Product assignment decides which plugins are offered per image set.
- Result bitmaps are consumed by the viewer as overlays (location_rect, scale, alpha, channels, frame) – bitmap file serving must be ported with the image pipeline.

**Permissions caveat:** these viewsets use `DjangoModelPermissions`, i.e. Django's `auth_permission` / group / user-permission tables (`add_/change_/delete_/view_` per model). The Rust authz layer must read those tables (or map them) so existing worker accounts keep working unchanged. Also covers `ImageField` icon upload for `Plugin`.

**Dropped (in-process Python plugins):**
- `plugins/ExactServerPlugin.py`, `pluginFinder.py`, `proc_EIPH.py`, `plugins/templates`.
- The in-process hooks that used them (plugin statistics elements, `ExactServerPlugin` navigator policies).

**Rebuilt (decided):** the viewer's navigator overlay (`navigator_overlay_status`, overlay tiles) is generated from `PluginResultBitmap` records: the server renders overlay tiles from the stored bitmap (`location_rect`, `scale_min/max`, `channels`, `default_alpha/threshold`, `frame`), caches them like normal tiles, and reports `NEEDS_UPDATE`/`UP_TO_DATE`/`ERROR` from the job/result state. In v2 this is a normal resource (`/images/{id}/overlays/{entry}/tiles/…`), not a plugin hook.

**What the real worker does** (`EXACT-QueueRunner`, local at `~/code/EXACT-QueueRunner`, built on `exact-sync`): at startup `list_plugins` and `create_plugin` for each handler's `package`; then loops every 5 s: `list_plugin_jobs(limit=100000000)` (so the server must accept huge `limit`s), filters `processing_complete != 100`, `retrieve_plugin_job`, **claims a job by PATCHing `attached_worker`, sleeps a random <1 s, re-reads, and backs off if another worker won** (optimistic, racy), runs the model (`download_image`, `retrieve_image`, `retrieve_annotationtypes`), reports progress via `partial_update_plugin_job(processing_complete, updated_time)`, and posts `create_plugin_result`, `create_plugin_result_entry`, `create_plugin_result_annotation`; on cleanup it `destroy_plugin_result`s; on failure it clears `attached_worker`.

Consequences:
- The compat layer must reproduce these semantics exactly (field names `job.plugin`, `job.result`, `attached_worker`, `updated_time`, `error_message/detail`; PATCH with partial fields; huge `limit`).
- **v2 adds an atomic claim** (`POST /api/v2/processing/jobs/{id}/claim` using `UPDATE … WHERE attached_worker IS NULL RETURNING`, plus heartbeat/lease expiry for dead workers), removing the race. Old workers keep the old PATCH flow; the server makes that flow safe where it can (e.g. compare-and-set when `attached_worker` is set from NULL).
- Server-side stale-job detection (lease expiry) so crashed workers don't block jobs forever.

**Worker compatibility test (mock, as decided):** a small mock worker in `tests/mock-worker/`, written in Python **using `exact-sync` exactly like QueueRunner does** (no model, no GPU): registers a plugin, polls, claims, reports progress, creates a result with an entry, annotations and a bitmap, handles failure and cleanup, plus a two-worker race test. It runs in CI against Django (record) and Rust. The real QueueRunner is run manually as a smoke test before cutover.

## 6a. Image registration (heavily used – kept)

Phase 0 finding: `ImageRegistration` stores `transformation_matrix` (JSON), `registration_points`, `registration_error`, `runtime`, optional file; `register_images`/`convert_coodinates`/`create_inverse_registration` are used by `exact-sync`. The registration *algorithm* is the external Python library `qt-wsi-registration` (quad-tree registration with OpenCV, scikit-learn, `probreg`, OpenSlide): research code that is not realistic to port first.

Plan:
- **Rust owns** storage, authz (team scoping), coordinate conversion (`convert_coodinates`), `rotation_angle`/inverse-matrix math and `create_inverse_registration`: pure geometry, ported with tests against Django outputs.
- **Computing a registration** becomes a **job** in the Postgres queue handled by a **registration worker** (Python, reusing `qt-wsi-registration` unchanged, same worker pattern as ML workers, run as a helper process/container). `register_images` returns/polls as today for compat; v2 exposes it as an explicit job resource with progress. This keeps the single server binary Python-free, while registration stays fully functional.
- Optional later: native Rust implementation if the Python worker becomes a maintenance burden.
- Test: golden registrations (matrix, error, converted vectors) from Django on a set of image pairs.

## 7. Risks

| # | Risk | Mitigation |
|---|---|---|
| 1 | Format long tail – all formats are in scope (CZI, MKT, iSyntax, OME z-stacks, video, NIfTI) and conflicts with "single binary" | Helper executables for non-linkable libs; per-format golden tests; feature flags |
| 2 | Logic scattered in 2.5k-LOC `images/views.py` and 1.5k-LOC `annotations/views.py` | Inventory per endpoint during Phase 3/5; conformance tests before porting |
| 3 | Django session/password/CSRF compatibility | Dedicated compatibility tests with real Django-produced hashes/cookies |
| 4 | New viewer is the largest single deliverable; scope creep vs. parity | Parity checklist from the existing UI, viewer built first and demoed early; old UI keeps running until parity |
| 5 | Hidden PG features / raw SQL | `grep` for raw SQL/JSON/Array fields in Phase 1 (not yet done) |
| 6 | Django model-permission tables needed by `DjangoModelPermissions` for ML worker accounts | Read `auth_permission`/groups directly; compatibility tests with real worker accounts |
| 7 | Passkey/registration/impersonation compat (credential format, RP ID, activation tokens) | Port with tests using real exported data from a staging DB |
| 8 | `exact-sync` interface drift while v2 is introduced | CI runs `exact-sync` + notebooks against Rust; version negotiation in `exact-sync` |
| 9 | Registration algorithm is Python research code with heavy deps | Keep as worker process; port only geometry; golden tests |
| 10 | Old racy job-claim flow in QueueRunner/`exact-sync` | Server-side compare-and-set + leases; v2 atomic claim; two-worker race test |
| 11 | Bus factor / maintenance of FFI (openslide, slideio) | Pin versions, vendored build in Docker |

## 8. Decisions & open questions

**Decided:** runtime browser speed with clean architecture first (new SPA, `viewer-core` separated from app shell, §4) · all formats in scope · v2 API allowed, `exact-sync` interface compatibility mandatory, other consumers kept compatible where cheap (§2a) · passkeys/registration/impersonation ported · `zarr`/`h5py` dropped · single binary + Postgres · `processing` API kept, in-process Python plugins dropped · navigator overlay rebuilt on `PluginResultBitmap` · mock worker modelled on EXACT-QueueRunner for tests · image registration kept, compute as worker (§6a) · forced re-login at cutover is fine.

**Still open:**
0. **Phase 2 follow-up (§5d):** the production `FIDO_SERVER_ID`/`FIDO_SERVER_NAME` values from the production `settings.py` (without them no enrolled passkey can work), (production is `exact.hs-flensburg.de`, so it is either that or `hs-flensburg.de`; the Safari test host is exact-beta.deepmicroscopy.org, see §5e).
1. Backup logistics (§5a): can you provide the dump plus the file store (or a representative subset) and say how large they are? Is a scrubbed copy needed (patient data, user emails)?
2. Which environment hosts the beta (your workstation, a lab server)? Needs Postgres, enough disk for the file store, and Docker.
3. Production Django/EXACT version of the backup (to match the Django reference).

## 9. Immediate next steps
1. **You:** provide the backup + files + version (§5a, open questions 1–3).
2. **Phase 1 kickoff:** cargo workspace, schema baseline from the **real** dump (not just from the migrations), restore scripts (`scripts/restore-backup.sh`, idempotent, isolated DB), Django reference environment on the dump.
3. **Phase 2 is done (§5d).** Next: **Phase 3** (read-only core API on the same pattern: images, image sets, annotations, types, processing, with the token/viewer scoping), .
4. Grep pass for raw SQL / Postgres-specific fields; data-quality audit report (§5a step 2).
5. Then Phases 2–5 toward the beta exit criteria.

*Caveat: Phase 0 was a structural survey (file sizes, models, routes, settings, dependencies). Per-field model details, serializer shapes and exact permission rules have not been read yet; they are the first task of Phases 2–3.*

### 5l. Phase 5, slice 1: annotation writes (2026-10-27)
Done, verified against real Django by the mutation-parity harness (`scripts/mutation-parity.sh`, `tests/mutations/`): two
copies of the same database, one served by Django (:8001), one by Rust (:8002), identical scripted writes, responses and the
resulting rows of `annotations_annotation` / `annotations_verification` compared.
- Legacy JSON endpoints used by exact-sync and the old UI: `annotations/api/annotation/{create,update,delete,verify,blurred_concealed}/`
  (`compat/writes.rs`, permission model in `compat/perms.rs` = `ImageSet.get_perms`, vector validation in `compat/vector.rs`
  = `AnnotationType.validate_vector` incl. its int-identity quirk for lines).
- REST v1 `/api/v1/annotations/annotations/`: POST (single, with idempotent update by `unique_identifier`; list = bulk), PUT, PATCH,
  DELETE, `multiple_delete`, `count` (`compat/rest_writes.rs`), DRF-shaped validation errors.
- Deliberate differences: the image-set permission (`annotate` / `edit_annotation` / `delete_annotation`) is enforced on REST writes
  (Django only checks the model permission, so any authenticated user with `add_annotation` could write into foreign teams' sets);
  annotations that have versions answer 409 on deletion (Django 500); a missing `unique_identifier` creates the annotation (Django 500);
  bad time strings answer 400 (Django 500); `"true"`/`"false"` strings for Django-BooleanField inputs that Django 500s on are accepted.
- Still open in Phase 5: v2 write endpoints for annotations, image / image set writes, processing writes with atomic claim,
  registration worker, QueueRunner v2, upload pipeline.

### 5m. UI direction (agreed 2026-10-27)
A better UI, not a Lightroom v2 clone; users are mainly pathologists. Requirements: click-to-select annotations, and a selected
annotation is editable in place (move, resize for variable-size types, add area / edit nodes for polygons); the toolbox follows the
context (nothing selected, selection by vector type, drawing); a one-click mode where each debounced click creates an annotation of
the predefined size; all old shortcuts kept; annotation on desktop and tablet (pointer/touch events, large hit targets), viewing also
on phones. Order: collect the old shortcut list and write one-page workflows -> v2 annotation write endpoints -> annotation layer
(selection, handles, undo/redo) -> contextual toolbox -> side panel -> responsive layout.

### 5n. Phase 5.2: v2 annotation writes (2026-10-27)
`/api/v2/annotations` POST (idempotent by `unique_identifier`, global annotation once per image/type, vector validated, verified by
creator), PATCH (partial, conditional via `expected_last_edit_time` -> 409 with the current state, type change only within the same
vector family), DELETE (soft; `?hard=true` removes, 409 when versions exist; undo = `PATCH {"deleted": false}`), POST `{id}/verify`.
Authority is the image-set permission, not Django model permissions; invisible annotations answer 404. Tests:
`tests/conformance/test_v2_annotation_writes.py` (18, part of `make verify`). Next in 5.2: image / image-set writes, processing
claim, upload pipeline; batch endpoint for the new viewer if the one-click mode needs it.

### 5o. Phase 5.2: image upload (2026-10-27)
`POST /images/image/upload/{set}/` (exact-sync, old UI; answers `{"files": [...]}` like Django, error texts included) and
`POST /api/v2/image-sets/{id}/images` (`{"items": [...]}`), multipart, any number of files, streamed to disk (no body limit) while
hashing (SHA-512, as Django). Needs `edit_set` and an unlocked set. ZIPs are unpacked (path traversal safe; `.mrxs`/`.vms`/`.vsi`
rule as in Django, entries checksummed over their first 10000 bytes), documents become auxiliary files, everything else goes through
the slide readers (width/height, mpp, objective power, frames + `images_framedescription` rows with the reader's labels, default
frame in the middle for z-stacks/volumes); unreadable files are removed again. No format conversion on upload (Django converted CZI,
multi-page TIFF, HDF5 to pyramidal TIFF with pyvips; the Rust readers read them natively). Tests: `tests/conformance/test_v2_upload.py`.
Not done yet: HDF5 overlay, iSyntax (dropped), MKT/NIfTI-specific frame directories (not needed), image lock/zip state side effects.
Old-UI shortcut inventory: `docs/old-ui-shortcuts.md` (extracted from the Django JS; lists three existing quirks of the old UI).

UI decision: the old viewer's heatmap is not ported (flawed implementation); Ctrl+Z is undo only.

### 5p. Phase 5.2: image sets and image deletion (2026-10-27)
v2: `POST /api/v2/image-sets` (team member; folder `<SQL_DATABASE>_<team>_<id>`, mode 0777, products optional), `PATCH` (`edit_set`;
name unique per team), `DELETE` (`delete_set`; cascades and removes the folder), `DELETE /api/v2/images/{id}` (`delete_images`, set
unlocked; removes the files unless another image of the set still uses them). exact-sync: `POST /images/api/imageset/create/`
(`team: {"id"}`, `products: [{"id"}]`; answers `serialize_imageset`). `cascade.rs` reproduces Django's `on_delete=CASCADE` from the
catalog's foreign keys with an explicit SET_NULL list (Django's FKs have no ON DELETE clause); the deferred FK constraints are the safety
net (a missing child would fail the commit). Tests: `tests/conformance/test_v2_image_sets.py`.
Still open in 5.2: tags/products of sets, move image, legacy GET image delete, annotation types / products admin endpoints
(`administration/api/...`), media-file upload, processing claim.

### 5q. Phase 5.2: tags, products, annotation types (2026-10-27)
Legacy (exact-sync, old UI): `images/api/imageset/{tag,product}/{add,delete}/` with Django's messages and status codes,
`administration/api/annotation_type/{create,delete}/` (create keeps Django's `sort_order` <- `enable_concealed` quirk; delete: superuser, and
only if unused). `administration/api/products/create/` is not ported: Django has no URL for it (exact-sync's `create_product` already gets
404 there). v2: `POST /api/v2/image-sets/{id}/tags`, `DELETE .../tags/{name}` (unused tags disappear, except `test`),
`PUT|DELETE .../products/{pid}`, `/api/v2/annotation-types` and `/api/v2/products` (POST, PATCH, DELETE; Django model permissions;
types in use cannot be deleted or change their vector type -> 409/400; products can copy the types of another product with `copy_product`).
Tests: `tests/conformance/test_v2_catalog.py`.
Still open in 5.2: move image, legacy GET image delete, annotation media-file upload, REST v1 writes for the other resources, processing
claim, registration worker, QueueRunner v2.

### 5r. Phase 5.2: processing and other plain-table writes, atomic job claim (2026-10-27)
`compat/generic_writes.rs`: one implementation of POST/PUT/PATCH/DELETE for the resources that are plain tables, serving v1 (DRF-shaped
errors, v1 representation) and v2 (`{"detail","errors"}`, snake_case, UTC): Plugin, PluginJob, PluginResult, PluginResultEntry,
PluginResultAnnotation, ImageRegistration, ScreeningMode, SetTag, LogImageAction, Verification. Columns come from the resource `Spec`;
Django's defaults / `auto_now_add` are listed per resource (the tables have no column defaults). Django model permissions per method,
referenced images must be readable by the caller, existing rows must be inside the caller's scope (v2: processing data is scoped to
the teams of the image), deletes cascade like Django (`cascade.rs`, `PluginResult.job` SET_NULL). Not covered: file fields
(`PluginResultBitmap.bitmap`, `Plugin.icon`, `ImageRegistration.file`; need multipart) and M2M fields.
`POST /api/v2/plugin-jobs/claim {"worker", "plugin"?}`: one statement picks the oldest free job (no worker, not finished, no error, in the
caller's teams) and marks it, `FOR UPDATE SKIP LOCKED`; 200 with the job or 204. The test claims 6 jobs from 10 concurrent workers: every
job goes to exactly one worker. Django's workers read the list and then PATCH `attached_worker`, which can hand a job out twice.
Tests: `tests/conformance/test_v2_processing.py`.
Still open in 5.2: move image, annotation media-file upload, bitmap/icon uploads, writes for users/teams/memberships (admin), registration
worker, QueueRunner v2.

### 5s. Phase 5.2: file uploads and media (2026-10-27)
`media.rs`: storage like Django's `FileSystemStorage` under `MEDIA_ROOT` (valid file names, an existing file is never overwritten:
`name_<7 chars>.ext`), body parsing for multipart / urlencoded / JSON (`Payload`), and `/media/` is served (public, like Django's). Body limit
raised to 1 GiB for the API routes. File fields in the generic writer: `PluginResultBitmap.bitmap` (required, `plugins/<plugin>_<id>/<image>/`),
`Plugin.icon`; JSON fields arrive as JSON text in form bodies. Annotation media files: legacy
`annotations/api/annotation/mediafile/upload/{annotation}/{type}/` (a file name the annotation has already is skipped), `POST
/api/v2/annotations/{id}/media-files`, `DELETE /api/v2/annotation-media-files/{id}` (removes the file); needs `edit_annotation`.
Not done: `ImageRegistration.file`, `AnnotationType.image_file`, streaming of very large bodies (bodies are held in memory).
Open in 5.2: move image, admin writes for users/teams/memberships, registration worker, QueueRunner v2.

### 5t. Phase 5.2: move image (2026-10-27)
`POST /api/v2/images/{id}/move {"image_set"}` and legacy `POST /images/api/image/move/{image}/{set}/`, `GET /images/api/image/move-targets/`;
port of `exact/images/move.py` with its checks and messages (same set 400, server generated 400, `delete_images` in the source / `edit_set` in
the target and no locks 403, name clash 409, annotation types used by non-deleted annotations must be offered by the target's products 409,
file name clash in the target 409; sets of other teams 404). Files (original, converted file, thumbnails, frame / MRXS folder) move first, the row
and `zip_state` after; on failure the files go back. Symlinked copies in other sets are re-pointed. Tests: `test_v2_move_image.py`.
Open in 5.2: admin writes for users/teams/memberships, registration worker, QueueRunner v2.

### 5u. Phase 5.2: teams, memberships, user administration (2026-10-28)
v2: `POST /api/v2/teams` (3-30 characters, unique; creator becomes admin), `PATCH` / `DELETE /api/v2/teams/{id}` (team admins; superusers may delete;
deleting releases the sets: public + locked, team cleared), `PUT|DELETE /api/v2/teams/{id}/members/{user}` (admins manage; leaving yourself is
always allowed; any member may promote while the team has no admin; no self-demotion; the last member leaving ends the team like `leave_team`).
Users, rules of `administration/views.py`: `PATCH /api/v2/users/{id}` (staff: names, email, username, `frontend`; site admin: `is_active`, not for site
admins or yourself; superuser: `is_staff`), `DELETE` and `POST .../random-password` (site admin; not yourself; superusers only touch superusers; the
password is returned once and stored with the Django-compatible hasher). User deletion clears every nullable reference (creator, last editor, ...) and
deletes the mandatory ones (tokens, passkeys, memberships, preferences, sessions): `cascade::delete_users`; `cascade.rs` also copes with tables
without an `id` column (sessions) and keeps image sets alive when their team goes (SET_NULL list extended).
The v2 `Team` / `User` representations are Django's serializers (no website / names yet; to be extended when the admin screens need them).
Not ported: password-reset mail (`send-password-reset`), user creation by an admin (users arrive through invitations). Tests: `test_v2_admin.py`.
Open in 5.2: registration worker, QueueRunner v2.

### 5v. Phase 5.2: registration jobs, worker, conversion (2026-10-28)
Rust owns the queue (`exact_rust_registration_job`, migration 0006; results land in the shared `images_imageregistration`), permissions, the job
lifecycle and the geometry; the compute stays in Python (`qt-wsi-registration`, unchanged). v2: `POST /api/v2/images/{id}/register` (202, answers
the job; an open job of the pair is reused), `GET /api/v2/registration-jobs[/{id}]`, worker API `POST .../claim` (SKIP LOCKED, 30 minute lease,
answers the image paths on the server and the parameters), `.../{id}/complete` (matrix, error, runtime, pickled quad tree as multipart file;
creates or updates the registration of the pair, optionally the inverse), `.../{id}/fail`; `GET|POST /api/v2/registrations/{id}/convert`,
`POST .../inverse`. exact-sync v1: `POST images/images/{id}/register_images/` (waits for the worker, `REGISTRATION_WAIT_SECONDS`, default 900:
201 new / 202 recomputed, 202 with the job when the wait ran out), `registration/{id}/convert_coodinates/` (202), `.../create_inverse_registration/`
(201; inverse as `cv2.invertAffineTransform`, singular -> zeros; an existing inverse answers 409 where Django fails with a 500).
Conversion: matrix registrations natively (no perspective division, like Django), registrations with a quad tree pickle through
`helpers/registration_helper.py` (`REGISTRATION_PYTHON`, `REGISTRATION_EXACT_DIR`: the pickle holds EXACT's slide classes). Worker: `helpers/registration_worker.py`
(stdlib only except qt_wsi_reg; `--once`, several workers side by side). Differences: registering an image onto itself is refused (400).
Tests: `test_v2_registration.py`, plus with `REG_E2E=1` (set by `make verify` when qt_wsi_reg imports) the real worker registers images 43 -> 2
through the API and the helper converts a point through the stored pickle (verified: 10 s).
Open in 5.2: QueueRunner v2 (mock worker with exact-sync, two-worker race test; the real QueueRunner as a manual smoke test).

### 5w. Phase 5.2: QueueRunner v2 and the mock worker (2026-10-28)
`tests/mock-worker/mock_worker.py`: a worker that does what EXACT-QueueRunner does with `exact-sync` (register the plugin, list/retrieve jobs, claim,
progress, result + entry + annotations + bitmap upload, destroy an earlier result), with the old racy claim (`legacy`) or the v2 claim.
`tests/conformance/test_mock_worker.py` (7): both flows end to end, a failing handler leaves the error on the job and the job unclaimed, a re-run
replaces the earlier result, three v2 workers process six jobs exactly once (no result twice), two legacy workers lose no job.
The v2 claim now also skips jobs that have a result (QueueRunner's `job.result is None`). `docs/queuerunner-v2.md`: the proposed change for
QueueRunner (not applied, the user's checkout has local changes) and three findings in exact-sync (broken `create_plugin`, `PluginJob.result`
never filled, no multipart for bitmaps). The real QueueRunner as a manual smoke test remains for the cutover checklist (§5a).
Phase 5.2 is complete.

### 5x. UI: annotation tools (2026-10-28)
Built to the requirements of §5m. `viewer-core/`: `geometry.ts` (pure: hit tests, handles, move/resize/vertex editing, vectors, unit conversion of type sizes with the
image resolution; 13 tests), `editor.ts` (`AnnotationEditor`: select tool and draw tool on OpenSeadragon's pointer events, so mouse, pen and touch behave the same),
`annotationLayer.ts` (selection glow + handles, preview while dragging, polygon in progress, ghost of the box a click would place, dashed outline = not verified by
you), `history.ts` (undo/redo, serialised, 4 tests), `shortcuts.ts` (the old key table as a pure matcher, 7 tests), `palette.ts` (types of the image set by digit key,
conversion rules, hints; 4 tests). `hooks/useAnnotationActions.ts`: optimistic create / update / delete / change type / verify against the v2 endpoints, conditional
edits (409 -> "somebody else changed it", reload), history commands. `components/Toolbox.tsx`: contextual (select / draw, type chips with their keys, hints,
one-click toggle, selection tools: type, size, verify, delete, remove vertex; image labels for global types; undo/redo; show/hide).
Behaviour: click selects (smallest annotation first); only a drag that starts on the *selected* annotation or a handle edits (every other drag pans); box handles resize,
fixed-size boxes and points move, polygon / polyline vertices drag, the dot between two vertices adds one, click a vertex + Delete removes it; types with a fixed node count
keep their vertices. Drawing: drag (box, line), click (point, fixed-size box), clicks + Enter / double-click / click on the first point (polygon, polyline), one-click mode (A) places
the type's default size (converted from mm / µm with the resolution) with every click, debounced; the ghost outline shows where. Keys as the old UI: 1-9 type (changes the class
of the selected annotation), Shift+1-9 global labels, C draw/select, Enter/V finish, Esc cancel, Delete/Backspace/X delete, Y show/hide, Ctrl+Z / Ctrl+Shift+Z, E/Q image,
Shift+E/Q frame; new: A one-click. OpenSeadragon's own keys are switched off (no more R/F collisions); arrows, Shift+arrows, +/-, 0 are provided by the shortcut table.
Layout: tablet (touch targets >= 44 px, tool bar wraps), phone (type list and tools open on demand, no horizontal scroll). Server: global annotations (vector null) are
switched on again instead of duplicated; annotation type names are unique per product (400 instead of 500).
Tests: `frontend/e2e/annotate.mjs` (system Chrome, own image in a new image set: drag-draw, select, resize, move, pan-vs-edit, verify, delete, undo/redo, one-click, polygon incl.
midpoint insert and vertex delete, hide, tablet touch taps, phone layout), `make e2e`.
Not yet: brush union / scissors / glue / knife of polygons (old S, G, D keys), segmentation tool, "add area" to a polygon, drawing with a stylus pressure, multi-select, copy/paste.

### 5y. UI: polygon operations (2026-10-28)
Polygon reshaping, with `polygon-clipping` (`viewer-core/polyops.ts`, pure, 10 tests): **brush** (Shift+drag adds area, Alt+drag erases; on touch screens the toolbox
buttons "Add area" / "Erase" switch the brush on; the wheel or the slider sizes it; a ring follows the pointer, the result shows live), **scissors** (S: click the corners of an
area to cut away), **glue** (G: area to add), **knife** (D: a line that splits the polygon). Enter / double-click applies, Esc cancels. Results are simplified to about one screen pixel,
kept inside the image, rounded to integers; the largest piece keeps the annotation, further pieces become annotations of the same type (`useAnnotationActions.replace`: one undo
step takes it all back). Holes are dropped (annotations have none; the outline is kept and the user is told). Types with a fixed node count cannot be reshaped. Test: `annotate.mjs`
(brush add, band erase that splits off a piece, scissors notch, knife split, undo of each).
Not yet: the segmentation tool, multi-select, copy/paste of annotations.

### 5z. UI: compact tools, type drop-down, measurements (2026-10-28)
Feedback after the first trial: the tool bar took too much room, image sets have many annotation types, and the selection should show its area. Now: one row (`Dropdown.tsx`:
types, the selected annotation's type, reshape tools and image labels are drop-downs that open upwards, close on Escape / outside click, and get a filter field above 7 entries);
the draw-type list hides while something is selected (digit keys still change its class); the left type list folds (remembered). A selected box or polygon shows its **area** (µm² / mm²
with the image resolution, px² without; the pixel numbers in the tooltip), a line its length, live while it is dragged (`viewer-core/measure.ts`, tested). Test: `annotate.mjs`.

### 5aa. UI: right-click menu of annotations; crop to new image (2026-10-28)
Right click (long press on touch screens) on an annotation selects it and opens its menu: **Info** (type and shape, area / length, position, created by and when, last edited by and when,
who verified, description, id), **Change class** (only types of a compatible shape: same vector type, or box <-> fixed-size box; filter above 7), **Crop to new image** (boxes and polygons; a polygon
crops its bounding box) and **Delete annotation** (confirmation; undo brings it back). Crop asks for the target image set (the writable ones, grouped by team) or a new one (name, team; it gets the products of the source set), then
the server crops: `POST /api/v2/images/{id}/crop {x, y, w, h, frame, image_set}` and the legacy `GET /images/api/image/crop/{id}/{x}/{y}/{z}/{w}/{h}/{set}/` (exact-sync).
The crop is a pyramidal JPEG BigTIFF written in bands (`exact-wsi/src/crop.rs`, flat memory; resolution tags from the image's mpp), named like Django's (`<stem>x<x>_y<y>_z<z>_w<w>_h<h>.tiff`),
the new image remembers its origin (`crop_source`, `crop_x`, `crop_y`, `crop_frame`); `edit_set` in both sets, target not locked, region inside the image, at most `CROP_MAX_PIXELS` (400 MP);
the same crop into the same set again answers 409 with the existing image. `GET /api/v2/image-sets/writable` lists the targets. Tests: `crop.rs` (unit), `test_v2_crop.py`, `annotate.mjs`
(menu, info, class change + undo, disabled class change for a lone polygon type, crop into a new set, repeated crop, delete with confirmation, long press). `scripts/run-e2e.sh` restores the scratch DB,
starts the server and runs the browser tests (and leaves the server up).

### 5ab. UI round 4 and the "wobble" of image 2 (2026-10-28)
- **Verification is gone from the UI** (no button, no dashed outlines, no "verified by" in the info); writing an annotation through `/api/v2` no longer verifies it (the verify endpoint stays for later).
- **Area label while editing**: resizing, moving, brush strokes and drawing show the area (or the length) in a pill in the middle of what is visible of the shape.
- **Class change to a fixed-size type** asks whether to resize the annotation to the type's size around its centre (or keep the class); applies to the context menu, the toolbar and the digit keys; undo restores class and size.
- **Crops know their origin**: the top bar says "Crop of <original> at (x, y)" with "Show in original" (opens the original zoomed to the cropped region, outlined, same frame); the pointer position is shown in the image's and, for crops, in the original's coordinates.
- **Movies**: play / pause (Space) left of the frame slider, right click chooses the speed (the movie's own `frame_rate` from the file, presets, any number); frames are preloaded further ahead while playing.
- **Image 2 wobbled, and it was a pyramid offset - and two bugs of ours.** (1) Its OME-TIFF levels are made by sub-sampling (`exact-cli level-offsets` shows 0.38 / 0.47 / 0.48 px against level 0); OME and generic TIFFs were not corrected, now they are (`needs_registration`). (2) The offset estimator under-estimated fractional shifts (parabola on the SSD grid: 0.27 instead of 0.38): it now refines with a gradient-based (Lucas-Kanade) step after both images were blurred (`registration.rs`, ALGORITHM 3; EXACT's Python port of the estimator still has ALGORITHM 2 and the same bias: it needs the same change, rows of different algorithm numbers are re-measured by each side). (3) DeepZoom sampling used `level size / image size`, but OpenSeadragon places level `e` as exactly 2^e level-0 pixels per pixel, so levels (sizes are rounded up) drifted against each other by up to a pixel towards the far edge, and edge tiles were stretched when clipped at the slide boundary; now exact powers of two, edge tiles padded with the background (`generator.rs`, test with a dot in the far corner). Measured with `tests/perf/level_shift.py` (phase correlation between neighbouring viewer levels): image 2 from 2.15 px to 0.18 px.
