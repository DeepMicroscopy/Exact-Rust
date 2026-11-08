-- When a worker last asked for the jobs of a plugin (or announced it): plugins whose worker has not been seen for a week are not offered.
-- Rust-only table; its key points at EXACT's plugin table and goes with it.
CREATE TABLE IF NOT EXISTS exact_rust_plugin_seen (
    plugin_id integer PRIMARY KEY REFERENCES processing_plugin (id) ON DELETE CASCADE,
    seen_at timestamptz NOT NULL DEFAULT now()
);
