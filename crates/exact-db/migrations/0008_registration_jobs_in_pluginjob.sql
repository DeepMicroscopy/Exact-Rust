-- Registration jobs are jobs of registration plugins in `processing_pluginjob`: `image` is the image that is registered,
-- `processing_pluginjobimage` lists it (position 0) and the image it is registered onto (position 1), `parameters` holds the
-- parameters, the outcome is the ImageRegistration of the pair. A job that waits has no `attached_worker`, a running one has
-- (and is claimed again when it was not touched for 30 minutes), a finished one has `processing_complete` = 100, a failed
-- one an `error_message`.
-- The jobs of the former Rust-owned table `exact_rust_registration_job` are moved over (once; the table is dropped).
DO $$
BEGIN
    IF to_regclass('exact_rust_registration_job') IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM exact_rust_registration_job)
           AND NOT EXISTS (SELECT 1 FROM processing_plugin WHERE plugin_type = 2) THEN
            INSERT INTO processing_plugin (name, author, contact, package, abouturl, icon, plugin_type, parameters_schema)
            VALUES ('Registration', '', '', 'qt_wsi_registration', '', 'plugins/default_plugin.png', 2, '[]'::jsonb);
        END IF;
        IF EXISTS (SELECT 1 FROM exact_rust_registration_job) THEN
            CREATE TEMPORARY TABLE moved_registration_job ON COMMIT DROP AS
                SELECT j.*, nextval(pg_get_serial_sequence('processing_pluginjob', 'id')) AS new_id,
                       COALESCE(j.plugin_id, (SELECT min(id) FROM processing_plugin WHERE plugin_type = 2)) AS plugin
                FROM exact_rust_registration_job j;
            INSERT INTO processing_pluginjob (id, processing_complete, plugin_id, creator_id, created_time, updated_time, eta_time,
                                              error_message, attached_worker, image_id, parameters)
                SELECT new_id, CASE WHEN status = 'done' THEN 100 ELSE 0 END, plugin, created_by, created_at,
                       COALESCE(finished_at, started_at, created_at), created_at,
                       CASE WHEN status = 'failed' THEN COALESCE(error, 'failed') END,
                       CASE WHEN status IN ('running', 'done', 'failed') THEN COALESCE(worker, 'unknown') END,
                       source_image_id, params
                FROM moved_registration_job;
            INSERT INTO processing_pluginjobimage (job_id, image_id, position)
                SELECT new_id, source_image_id, 0 FROM moved_registration_job
                UNION ALL SELECT new_id, target_image_id, 1 FROM moved_registration_job;
        END IF;
        DROP TABLE exact_rust_registration_job;
    END IF;
END $$;
