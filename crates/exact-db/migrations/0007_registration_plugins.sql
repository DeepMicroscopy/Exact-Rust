-- Processing plugins can be registration algorithms, and a job can carry a second image and parameters.
-- SHARED with EXACT (Django): the same columns are added by the migration `processing/0015_registration_plugins`, with the
-- same DDL. Whichever side runs first adds them; the other is a no-op. Keep both in sync (scripts/check-schema-sync.sh).
ALTER TABLE processing_plugin ADD COLUMN IF NOT EXISTS plugin_type smallint NOT NULL DEFAULT 1;  -- 1 image analysis, 2 registration
ALTER TABLE processing_plugin ADD COLUMN IF NOT EXISTS parameters_schema jsonb;                  -- the parameters a job accepts: [{name, label, type, default, ...}]
ALTER TABLE processing_pluginjob ADD COLUMN IF NOT EXISTS target_image_id bigint
    REFERENCES images_image(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;                  -- registration: the image `image` is registered onto
ALTER TABLE processing_pluginjob ADD COLUMN IF NOT EXISTS parameters jsonb;                       -- the values of the plugin's parameters for this job
ALTER TABLE processing_pluginjob ADD COLUMN IF NOT EXISTS registration_id bigint
    REFERENCES images_imageregistration(id) ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;     -- registration: the result
CREATE INDEX IF NOT EXISTS processing_pluginjob_target_image_id ON processing_pluginjob (target_image_id);
CREATE INDEX IF NOT EXISTS processing_pluginjob_registration_id ON processing_pluginjob (registration_id);

-- Rust-owned queue of registration computations: which plugin computes the job (null: the default registration plugin).
ALTER TABLE exact_rust_registration_job ADD COLUMN IF NOT EXISTS plugin_id integer
    REFERENCES processing_plugin(id) ON DELETE SET NULL;
