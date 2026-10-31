-- Automatic segmentation: segmenters announced by workers and the jobs that ask them for a mask. Rust-only tables; no foreign
-- keys into EXACT's tables (a deleted image leaves its jobs behind, the lists join the image and so do not show them).
CREATE TABLE IF NOT EXISTS exact_rust_segmenter (
    id bigserial PRIMARY KEY,
    name text NOT NULL UNIQUE,
    author text NOT NULL DEFAULT '',
    description text NOT NULL DEFAULT '',
    parameters_schema jsonb NOT NULL DEFAULT '[]',
    last_seen timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exact_rust_segmentation_job (
    id bigserial PRIMARY KEY,
    image_id bigint NOT NULL,
    segmenter text NOT NULL,
    annotation_type_id bigint NOT NULL,
    annotation_id bigint,
    mode text NOT NULL DEFAULT 'replace' CHECK (mode IN ('replace', 'add')),
    parameters jsonb NOT NULL DEFAULT '{}',
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    progress real NOT NULL DEFAULT 0,
    message text,
    worker text,
    created_by bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS exact_rust_segmentation_job_image ON exact_rust_segmentation_job (image_id);
CREATE INDEX IF NOT EXISTS exact_rust_segmentation_job_queue ON exact_rust_segmentation_job (status, created_at);
