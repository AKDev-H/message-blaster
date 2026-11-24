export const authMigration = `
    CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        google_subject TEXT UNIQUE,
        role TEXT NOT NULL CHECK (role IN ('admin', 'operator')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
    ) STRICT;

    CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY NOT NULL,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX sessions_by_user ON sessions(user_id);
    CREATE INDEX sessions_by_expiry ON sessions(expires_at);

    CREATE TABLE oauth_flows (
        token_hash TEXT PRIMARY KEY NOT NULL,
        state_hash TEXT NOT NULL,
        nonce TEXT NOT NULL,
        verifier TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX oauth_flows_by_expiry ON oauth_flows(expires_at);

    CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        occurred_at INTEGER NOT NULL,
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        source TEXT NOT NULL CHECK (source IN ('web', 'cli', 'worker')),
        action TEXT NOT NULL,
        target TEXT,
        outcome TEXT NOT NULL CHECK (outcome IN ('success', 'denied', 'failed', 'accepted')),
        request_id TEXT
    ) STRICT;
    CREATE INDEX audit_events_by_time ON audit_events(occurred_at);
`;
