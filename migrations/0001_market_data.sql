CREATE TABLE IF NOT EXISTS market_records (
  data_type TEXT NOT NULL,
  symbol TEXT NOT NULL,
  data TEXT,
  updated_at TEXT,
  checked_at TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  PRIMARY KEY (data_type, symbol)
);

CREATE TABLE IF NOT EXISTS historical_prices (
  symbol TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  close REAL NOT NULL,
  updated_at TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  PRIMARY KEY (symbol, trading_date)
);

CREATE INDEX IF NOT EXISTS historical_prices_date_idx
  ON historical_prices (trading_date);

CREATE TABLE IF NOT EXISTS refresh_locks (
  lock_name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
