-- Additive: one-time WebAuthn challenges and invite/reset links (no e-mail is involved; admins hand out links).
CREATE TABLE IF NOT EXISTS exact_rust_challenge (
    state      text PRIMARY KEY,
    challenge  text NOT NULL,
    purpose    text NOT NULL,
    user_id    bigint REFERENCES users_user(id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS exact_rust_invitation (
    id         bigserial PRIMARY KEY,
    token_hash text NOT NULL UNIQUE,
    purpose    text NOT NULL CHECK (purpose IN ('invite', 'reset')),
    email      text NOT NULL DEFAULT '',
    user_id    bigint REFERENCES users_user(id) ON DELETE CASCADE,       -- reset: whose password
    team_ids   bigint[] NOT NULL DEFAULT '{}',                           -- invite: teams to join
    note       text NOT NULL DEFAULT '',
    created_by bigint REFERENCES users_user(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    used_by    bigint REFERENCES users_user(id) ON DELETE SET NULL,
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS exact_rust_invitation_created_by_idx ON exact_rust_invitation (created_by);
