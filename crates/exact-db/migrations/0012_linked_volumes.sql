-- Segmentation files (3D Slicer `.seg.nrrd`, label maps) that belong to a volume without being annotations: stored in the image set
-- folder, read-only, drawn over the volume. Rust-only; deleting the set or the image removes the row (the file is removed by the
-- server when it deletes through the API).
CREATE TABLE IF NOT EXISTS exact_rust_linked_volume (
    id bigserial PRIMARY KEY,
    image_set_id bigint NOT NULL REFERENCES images_imageset (id) ON DELETE CASCADE,
    -- the volume the labels are drawn over; null while the file waits for a volume
    image_id bigint REFERENCES images_image (id) ON DELETE SET NULL,
    name text NOT NULL,
    filename text NOT NULL,
    size bigint NOT NULL DEFAULT 0,
    -- [{index, name, color, label, voxels}] in the order of the file
    segments jsonb NOT NULL DEFAULT '[]',
    -- how the labels sit on the volume: {overlap, offset_mm, ...}, set when linked
    geometry jsonb,
    creator_id bigint,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (image_set_id, filename)
);
CREATE INDEX IF NOT EXISTS exact_rust_linked_volume_image ON exact_rust_linked_volume (image_id);
