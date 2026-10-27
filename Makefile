# Dev workflow for the Phase 1 test environment (local scratch DB `exact_rust_test`, never the live `exact`).
PY := reference/.venv/bin/python

.PHONY: mutation-parity enroll-passkey migrate restore seed django rust test conformance sync-tests record-goldens sweep
restore:         ## recreate exact_rust_test from the newest dump, seed test users, create Rust tables
	scripts/restore-backup.sh && reference/seed-users.sh && $(MAKE) migrate
migrate:         ## additive Rust tables in the scratch DB only
	SQL_DATABASE=exact_rust_test cargo run -q -p exact-cli -- migrate --confirm-db exact_rust_test
django:          ## reference Django on :8001 (foreground)
	reference/run-django.sh
rust:            ## Rust server on :8002 against exact_rust_test (foreground)
	SQL_DATABASE=exact_rust_test EXACT_LISTEN=127.0.0.1:8002 cargo run -p exact-server
verify:         ## everything: unit tests, restore, both servers, all suites (see scripts/verify.sh)
	scripts/verify.sh
test:            ## Rust unit tests + lint
	cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
record-goldens:  ## record goldens from the reference Django (:8001)
	cd tests/conformance && ../../$(PY) record_goldens.py
conformance:     ## compare server at EXACT_URL (default :8001) with the goldens
	cd tests/conformance && ../../$(PY) -m pytest -q test_conformance.py
sync-tests:      ## exact-sync interface acceptance at EXACT_URL
	cd tests/conformance && ../../$(PY) -m pytest -q test_exact_sync.py
enroll-passkey: ## (re)create the software passkey fixture through the real django-passkeys endpoints (Django on :8001, then `make restore`)
	reference/.venv/bin/python reference/enroll_passkey.py
sweep:           ## format sweep + tile latency, label via LABEL=
	cd tests/perf && ../../$(PY) format_sweep.py $(LABEL)

ui:             ## build the frontend (served by the server from frontend/dist)
	cd frontend && pnpm install && pnpm build
e2e:            ## browser smoke test against a running server (system Chrome), screenshots in /tmp/shots
	cd frontend && SHOTS=/tmp/shots node e2e/smoke.mjs
e2e-repair:     ## browser test of the one-time image repair on a scratch copy (needs make ui)
	scripts/e2e-repair.sh
schema-sync:    ## shared tables must have the same structure whichever side (EXACT/Django or this port) creates them
	scripts/check-schema-sync.sh

mutation-parity: ## same scripted writes against Django and Rust on two DB copies, compare (scripts/mutation-parity.sh)
	scripts/mutation-parity.sh
