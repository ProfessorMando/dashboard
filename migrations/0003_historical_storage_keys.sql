CREATE TABLE IF NOT EXISTS historical_series_prices (
  storage_key TEXT NOT NULL,
  symbol TEXT NOT NULL,
  provider_function TEXT NOT NULL,
  output_size TEXT NOT NULL,
  normalization_version TEXT NOT NULL,
  trading_date TEXT NOT NULL,
  close REAL NOT NULL,
  updated_at TEXT NOT NULL,
  provider_status TEXT NOT NULL,
  PRIMARY KEY (storage_key, trading_date)
);

CREATE INDEX IF NOT EXISTS historical_series_prices_symbol_date_idx
  ON historical_series_prices (symbol, trading_date);

INSERT OR IGNORE INTO historical_series_prices (
  storage_key,
  symbol,
  provider_function,
  output_size,
  normalization_version,
  trading_date,
  close,
  updated_at,
  provider_status
)
SELECT
  'historical|symbol=' || symbol || '|function=TIME_SERIES_DAILY|outputsize=full|normalization=v1',
  symbol,
  'TIME_SERIES_DAILY',
  'full',
  'v1',
  trading_date,
  close,
  updated_at,
  provider_status
FROM historical_prices;

INSERT OR IGNORE INTO market_records (
  data_type,
  symbol,
  data,
  updated_at,
  checked_at,
  provider_status
)
SELECT
  data_type,
  'historical|symbol=' || symbol || '|function=TIME_SERIES_DAILY|outputsize=full|normalization=v1',
  data,
  updated_at,
  checked_at,
  provider_status
FROM market_records
WHERE data_type = 'historical'
  AND symbol NOT LIKE 'historical|%';
