-- Additive: remembers the real user while an admin impersonates another user.
ALTER TABLE exact_rust_session ADD COLUMN IF NOT EXISTS impersonator_id bigint REFERENCES users_user(id) ON DELETE CASCADE;
