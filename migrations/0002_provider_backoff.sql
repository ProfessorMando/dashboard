CREATE TABLE IF NOT EXISTS provider_backoff (
  provider TEXT PRIMARY KEY,
  next_allowed_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  last_error TEXT
);
