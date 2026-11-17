-- What a personal access token may do besides looking (scopes: jobs, annotate, images). Rust-only table; a token without a row is not
-- limited (every token EXACT made, and those made without scopes), and the row goes with the token.
CREATE TABLE IF NOT EXISTS exact_rust_token_scope (
    token_id bigint PRIMARY KEY REFERENCES users_personalaccesstoken (id) ON DELETE CASCADE,
    scopes text[] NOT NULL
);
