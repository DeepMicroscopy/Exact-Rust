-- When a user was shown the "what's new" greeting (NULL = never): it is shown once, at the first login on this server.
ALTER TABLE exact_rust_user_flags ADD COLUMN IF NOT EXISTS welcomed_at timestamptz;
