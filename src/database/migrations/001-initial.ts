export const initialMigration = `
  CREATE TABLE campaigns (
    id TEXT PRIMARY KEY NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('Draft','Ready','Running','Paused','Completed','Failed','Cancelled')),
    account_id TEXT,
    is_test INTEGER NOT NULL CHECK (is_test IN (0, 1)),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    row_number INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    message TEXT NOT NULL,
    pdf_filename TEXT NOT NULL,
    consent_status TEXT NOT NULL,
    attachment_hash TEXT,
    import_error TEXT,
    eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN (
      'PENDING','VALIDATING','QUEUED','SENDING','SENT','DELIVERED','READ','FAILED','SKIPPED','UNKNOWN'
    )),
    whatsapp_message_id TEXT UNIQUE,
    sent_at TEXT,
    acknowledged_at TEXT,
    delivered_at TEXT,
    read_at TEXT,
    error_message TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    retry_at INTEGER NOT NULL DEFAULT 0 CHECK (retry_at >= 0),
    reviewed_at TEXT,
    review_note TEXT,
    UNIQUE (campaign_id, row_number)
  ) STRICT;

  CREATE UNIQUE INDEX eligible_campaign_phone ON messages(campaign_id, phone) WHERE eligible = 1;
  CREATE UNIQUE INDEX eligible_campaign_client ON messages(campaign_id, client_id COLLATE NOCASE) WHERE eligible = 1;
  CREATE INDEX campaign_queue ON messages(campaign_id, status, retry_at, id);
  CREATE INDEX withdrawal_lookup ON messages(phone, status);

  CREATE TABLE message_attempts (
    message_id INTEGER NOT NULL REFERENCES messages(id),
    attempt_number INTEGER NOT NULL,
    whatsapp_message_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('SENDING','SENT','FAILED','UNKNOWN','RETRY','SKIPPED')),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    error_message TEXT,
    PRIMARY KEY (message_id, attempt_number)
  ) STRICT;

  CREATE TABLE consent_withdrawals (
    phone TEXT PRIMARY KEY NOT NULL,
    withdrawn_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE confirmed_test (
    account_id TEXT PRIMARY KEY NOT NULL,
    campaign_id TEXT NOT NULL REFERENCES campaigns(id),
    confirmed_at TEXT NOT NULL
  ) STRICT;
`;
