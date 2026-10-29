---
title: Architecture
nav_order: 6
---

# Architecture

* **One binary** (Axum, sqlx) serves the API, the slides and the built front end; **PostgreSQL** holds everything. The database
  is EXACT's own: the Rust server adds tables and columns idempotently (`exact-cli migrate`) and Django adds the same ones with
  the same DDL, so both can create them in either order.
* **Crates:** `exact-core` (configuration with EXACT's environment variable names), `exact-db`, `exact-auth` (all Django password
  hash formats, tokens, sessions, WebAuthn passkeys), `exact-wsi` (slide readers, DeepZoom tiles, TIFF reader/writer, pyramid
  repair, registration of pyramid levels), `exact-api` (`compat/` = v1 and legacy, `v2/`), `exact-server`, `exact-cli`.
* **Front end:** React, TypeScript, Vite and OpenSeadragon. The annotation logic (`viewer-core/`) is pure functions with unit
  tests; the viewer draws on OpenSeadragon's pointer events, so mouse, pen and touch behave alike.
* **Helpers** are separate processes: `slideio_helper.py` (CZI, VSI, DICOM), and the queue worker for analysis and registration.
* **Threads:** tokio's multi-threaded runtime (one worker thread per core), blocking slide decoding on tokio's blocking pool, and
  2–4 OpenSlide handles per open slide (a handle is never shared between threads). No other thread pools.

## Compatibility is tested
`tests/conformance` replays recorded responses of the reference EXACT against this server (about 1700 checks), runs the
exact-sync acceptance tests and the mutating v2 suites, and compares the shared table structure with what Django creates.
`make verify` runs all of it; `make e2e` drives the browser.

## Known limits
No window/level in the three-plane view, DICOM volumes have no planes, global annotations have no frame, no login rate limiting
(restrict access in a beta), no e-mail (invitations are links; password reset by mail is not ported).

The full plan and the log of decisions is [PLAN.md](https://github.com/DeepMicroscopy/Exact-Rust/blob/main/PLAN.md).
