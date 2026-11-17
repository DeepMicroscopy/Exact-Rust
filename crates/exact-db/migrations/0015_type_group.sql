-- Groups of segmentation types: the masks of types that share a group name (within one product) exclude each other, no voxel of a
-- volume is in two of them. Rust-only table; its key points at EXACT's annotation type and goes with it.
CREATE TABLE IF NOT EXISTS exact_rust_type_group (
    annotation_type_id bigint PRIMARY KEY REFERENCES annotations_annotationtype (id) ON DELETE CASCADE,
    group_name varchar(50) NOT NULL
);
