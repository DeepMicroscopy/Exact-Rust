-- Personal settings of an account (small, free of schema: {"legacy_navigation": true}); no key = the default of the program.
ALTER TABLE exact_rust_user_flags ADD COLUMN IF NOT EXISTS prefs jsonb NOT NULL DEFAULT '{}';
