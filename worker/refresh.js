import { ALL_SYMBOLS, SNAPSHOT_KEYS, STOCKS } from './config.js';
import { fetchAlphaVantageDaily, fetchFinnhub } from './providers.js';
import {
  acquireRefreshLock,
  getMarketRecords,
  putMarketRecords,
  releaseRefreshLock,
  upsertHistoricalRows,
} from './storage.js';

const localFlights = new Map();

function isoNow() {
  return new Date().toISOString();
}

function successfulStatus(provider, checkedAt) {
  return { provider: provider, ok: true, checkedAt: checkedAt };
}

function failedStatus(provider, checkedAt, error) {
  return {
    provider: provider,
    ok: false,
    checkedAt: checkedAt,
    error: error instanceof Error ? error.message : 'Provider refresh failed',
  };
}

function hasQuote(data) {
  return data && Number.isFinite(Number(data.c));
}

function hasObjectData(data) {
  return data && typeof data === 'object' && Object.keys(data).length > 0;
}

async function refreshRecords(env, options) {
  const previous = await getMarketRecords(env.DB, options.key);
  const checkedAt = isoNow();
  const records = [];
  let successful = 0;

  for (const symbol of options.symbols) {
    const oldRecord = previous[symbol];
    try {
      const value = await options.fetchSymbol(symbol);
      if (!options.isValid(value)) throw new Error(options.provider + ' returned no usable data');
      records.push({
        symbol: symbol,
        data: value,
        updatedAt: checkedAt,
        checkedAt: checkedAt,
        providerStatus: successfulStatus(options.provider, checkedAt),
      });
      successful += 1;
    } catch (error) {
      records.push({
        symbol: symbol,
        data: oldRecord ? oldRecord.data : null,
        updatedAt: oldRecord ? oldRecord.updatedAt : null,
        checkedAt: checkedAt,
        providerStatus: failedStatus(options.provider, checkedAt, error),
      });
    }
  }

  await putMarketRecords(env.DB, options.key, records);
  return { successful: successful, total: options.symbols.length, checkedAt: checkedAt };
}

export function refreshQuotes(env) {
  return refreshRecords(env, {
    key: SNAPSHOT_KEYS.quotes,
    symbols: ALL_SYMBOLS,
    provider: 'finnhub',
    fetchSymbol: function (symbol) {
      return fetchFinnhub('/quote', { symbol: symbol }, env.FINNHUB_API_KEY);
    },
    isValid: hasQuote,
  });
}

export function refreshProfiles(env) {
  return refreshRecords(env, {
    key: SNAPSHOT_KEYS.profiles,
    symbols: STOCKS,
    provider: 'finnhub',
    fetchSymbol: function (symbol) {
      return fetchFinnhub('/stock/profile2', { symbol: symbol }, env.FINNHUB_API_KEY);
    },
    isValid: hasObjectData,
  });
}

export function refreshMetrics(env) {
  return refreshRecords(env, {
    key: SNAPSHOT_KEYS.metrics,
    symbols: STOCKS,
    provider: 'finnhub',
    fetchSymbol: function (symbol) {
      return fetchFinnhub('/stock/metric', { symbol: symbol, metric: 'all' }, env.FINNHUB_API_KEY);
    },
    isValid: hasObjectData,
  });
}

export function refreshNews(env) {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
  const dateOnly = function (date) { return date.toISOString().slice(0, 10); };

  return refreshRecords(env, {
    key: SNAPSHOT_KEYS.news,
    symbols: STOCKS,
    provider: 'finnhub',
    fetchSymbol: function (symbol) {
      return fetchFinnhub('/company-news', {
        symbol: symbol,
        from: dateOnly(from),
        to: dateOnly(to),
      }, env.FINNHUB_API_KEY);
    },
    isValid: Array.isArray,
  });
}

export async function refreshHistorical(env) {
  const previous = await getMarketRecords(env.DB, 'historical');
  const checkedAt = isoNow();
  const earliestDate = new Date(Date.now() - 3650 * 86400 * 1000).toISOString().slice(0, 10);
  const statusRecords = [];
  let successful = 0;

  for (const symbol of ALL_SYMBOLS) {
    const oldRecord = previous[symbol];
    try {
      const series = await fetchAlphaVantageDaily(
        symbol,
        env.ALPHA_VANTAGE_API_KEY,
        !oldRecord || !oldRecord.updatedAt
      );
      const providerStatus = successfulStatus('alphaVantage', checkedAt);
      const rows = Object.entries(series).map(function (entry) {
        return {
          symbol: symbol,
          tradingDate: entry[0],
          close: Number(entry[1]['4. close']),
          updatedAt: checkedAt,
          providerStatus: JSON.stringify(providerStatus),
        };
      }).filter(function (row) {
        return row.tradingDate >= earliestDate && Number.isFinite(row.close);
      });

      if (rows.length === 0) throw new Error('Alpha Vantage returned no usable prices');
      await upsertHistoricalRows(env.DB, rows);
      statusRecords.push({
        symbol: symbol,
        data: { rowCount: rows.length },
        updatedAt: checkedAt,
        checkedAt: checkedAt,
        providerStatus: providerStatus,
      });
      successful += 1;
    } catch (error) {
      statusRecords.push({
        symbol: symbol,
        data: oldRecord ? oldRecord.data : null,
        updatedAt: oldRecord ? oldRecord.updatedAt : null,
        checkedAt: checkedAt,
        providerStatus: failedStatus('alphaVantage', checkedAt, error),
      });
    }
  }

  await putMarketRecords(env.DB, 'historical', statusRecords);
  return { successful: successful, total: ALL_SYMBOLS.length, checkedAt: checkedAt };
}

const REFRESHERS = {
  quotes: refreshQuotes,
  profiles: refreshProfiles,
  metrics: refreshMetrics,
  news: refreshNews,
  historical: refreshHistorical,
};

export function runRefreshJob(env, job) {
  if (localFlights.has(job)) return localFlights.get(job);

  const flight = (async function () {
    const owner = crypto.randomUUID();
    const now = Date.now();
    const acquired = await acquireRefreshLock(env.DB, job, owner, now, now + 14 * 60 * 1000);
    if (!acquired) return { skipped: true, reason: 'refresh-already-running' };

    try {
      return await REFRESHERS[job](env);
    } finally {
      await releaseRefreshLock(env.DB, job, owner);
    }
  })().finally(function () {
    localFlights.delete(job);
  });

  localFlights.set(job, flight);
  return flight;
}
