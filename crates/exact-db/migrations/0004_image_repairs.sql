-- Additive: one-time repairs of damaged image files (rebuilt pyramids). The original file is kept as a backup.
CREATE TABLE IF NOT EXISTS exact_rust_image_repair (
    id          bigserial PRIMARY KEY,
    image_id    bigint NOT NULL REFERENCES images_image(id) ON DELETE CASCADE,
    status      text NOT NULL CHECK (status IN ('running', 'done', 'failed', 'restored')),
    progress    real NOT NULL DEFAULT 0,
    message     text NOT NULL DEFAULT '',
    backup_file text NOT NULL DEFAULT '',
    levels      integer,
    started_by  bigint REFERENCES users_user(id) ON DELETE SET NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS exact_rust_image_repair_one_running ON exact_rust_image_repair (image_id) WHERE status = 'running';
