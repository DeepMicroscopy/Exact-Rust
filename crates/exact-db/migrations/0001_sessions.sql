-- Additive: new table only; no Django table is touched.
CREATE TABLE IF NOT EXISTS exact_rust_session (
    key        text PRIMARY KEY,
    csrf       text NOT NULL,
    user_id    bigint NOT NULL REFERENCES users_user(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS exact_rust_session_expires_idx ON exact_rust_session (expires_at);
