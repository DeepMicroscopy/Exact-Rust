-- Accounts that may look but not change (reviewers, guests): a flag per user, in a table of this server's own so that Django's
-- `users_user` stays as it is (EXACT itself ignores the flag). No row = not read only.
CREATE TABLE IF NOT EXISTS exact_rust_user_flags (
    user_id   bigint PRIMARY KEY REFERENCES users_user (id) ON DELETE CASCADE,
    read_only boolean NOT NULL DEFAULT false
);
