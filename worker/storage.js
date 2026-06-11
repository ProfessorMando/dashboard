function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

export async function getMarketRecords(db, dataType) {
  const result = await db.prepare(`
    SELECT symbol, data, updated_at, checked_at, provider_status
    FROM market_records
    WHERE data_type = ?
  `).bind(dataType).all();
  const records = {};

  for (const row of result.results || []) {
    records[row.symbol] = {
      data: parseJson(row.data, null),
      updatedAt: row.updated_at,
      checkedAt: row.checked_at,
      providerStatus: parseJson(row.provider_status, {}),
    };
  }
  return records;
}

export async function putMarketRecords(db, dataType, records) {
  const statements = records.map(function (record) {
    return db.prepare(`
      INSERT INTO market_records
        (data_type, symbol, data, updated_at, checked_at, provider_status)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(data_type, symbol) DO UPDATE SET
        data = excluded.data,
        updated_at = excluded.updated_at,
        checked_at = excluded.checked_at,
        provider_status = excluded.provider_status
    `).bind(
      dataType,
      record.symbol,
      record.data === null ? null : JSON.stringify(record.data),
      record.updatedAt,
      record.checkedAt,
      JSON.stringify(record.providerStatus)
    );
  });

  if (statements.length) await db.batch(statements);
}

export async function acquireRefreshLock(db, name, owner, now, expiresAt) {
  await db.prepare(`
    INSERT INTO refresh_locks (lock_name, owner, expires_at)
    VALUES (?, ?, ?)
    ON CONFLICT(lock_name) DO UPDATE SET
      owner = excluded.owner,
      expires_at = excluded.expires_at
    WHERE refresh_locks.expires_at <= ?
  `).bind(name, owner, expiresAt, now).run();

  const row = await db.prepare(
    'SELECT owner FROM refresh_locks WHERE lock_name = ?'
  ).bind(name).first();
  return Boolean(row && row.owner === owner);
}

export async function releaseRefreshLock(db, name, owner) {
  await db.prepare(
    'DELETE FROM refresh_locks WHERE lock_name = ? AND owner = ?'
  ).bind(name, owner).run();
}

export function historicalStorageKey(symbol, providerFunction, outputSize, normalizationVersion) {
  return [
    'historical',
    'symbol=' + encodeURIComponent(symbol),
    'function=' + encodeURIComponent(providerFunction),
    'outputsize=' + encodeURIComponent(outputSize),
    'normalization=' + encodeURIComponent(normalizationVersion),
  ].join('|');
}

export async function upsertHistoricalRows(db, rows) {
  const batchSize = 75;
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const statements = rows.slice(offset, offset + batchSize).map(function (row) {
      return db.prepare(`
        INSERT INTO historical_series_prices
          (storage_key, symbol, provider_function, output_size, normalization_version,
           trading_date, close, updated_at, provider_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(storage_key, trading_date) DO UPDATE SET
          close = excluded.close,
          updated_at = excluded.updated_at,
          provider_status = excluded.provider_status
      `).bind(
        row.storageKey,
        row.symbol,
        row.providerFunction,
        row.outputSize,
        row.normalizationVersion,
        row.tradingDate,
        row.close,
        row.updatedAt,
        row.providerStatus
      );
    });
    await db.batch(statements);
  }
}

export async function getHistoricalSeries(db, requests) {
  if (!requests.length) return {};

  const clauses = requests.map(function () { return '(storage_key = ? AND trading_date >= ?)'; });
  const bindings = requests.flatMap(function (request) {
    return [request.storageKey, request.fromDate];
  });
  const result = await db.prepare(`
    SELECT storage_key, symbol, trading_date, close
    FROM historical_series_prices
    WHERE ${clauses.join(' OR ')}
    ORDER BY storage_key, trading_date
  `).bind(...bindings).all();
  const series = {};

  for (const row of result.results || []) {
    if (!series[row.symbol]) series[row.symbol] = [];
    series[row.symbol].push({
      close: row.close,
      tradingDate: row.trading_date,
    });
  }
  return series;
}

export async function getProviderBackoff(db, provider) {
  const row = await db.prepare(`
    SELECT next_allowed_at, updated_at, last_error
    FROM provider_backoff
    WHERE provider = ?
  `).bind(provider).first();

  return row ? {
    nextAllowedAt: Number(row.next_allowed_at) || 0,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  } : { nextAllowedAt: 0, updatedAt: null, lastError: null };
}

export async function recordProviderBackoff(db, provider, nextAllowedAt, updatedAt, error) {
  await db.prepare(`
    INSERT INTO provider_backoff (provider, next_allowed_at, updated_at, last_error)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(provider) DO UPDATE SET
      next_allowed_at = MAX(provider_backoff.next_allowed_at, excluded.next_allowed_at),
      updated_at = excluded.updated_at,
      last_error = excluded.last_error
  `).bind(provider, nextAllowedAt, updatedAt, error).run();
}
