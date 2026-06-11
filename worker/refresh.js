import { HISTORICAL_SERIES, SNAPSHOT_KEYS, instrumentsSupporting, stocksSupporting } from './config.js';
import {
  fetchAlphaVantageDaily,
  fetchFinnhub,
  ProviderRateLimitError,
  ProviderResponseError,
} from './providers.js';
import {
  acquireRefreshLock,
  getMarketRecords,
  historicalStorageKey,
  getProviderBackoff,
  putMarketRecords,
  recordProviderBackoff,
  releaseRefreshLock,
  upsertHistoricalRows,
} from './storage.js';

const localFlights = new Map();
export const REFRESH_JOB_ORDER = Object.freeze(['quotes', 'profiles', 'metrics', 'news', 'historical']);

const JOB_SETTINGS = {
  quotes: { provider: 'finnhub', concurrency: 4 },
  profiles: { provider: 'finnhub', concurrency: 3 },
  metrics: { provider: 'finnhub', concurrency: 3 },
  news: { provider: 'finnhub', concurrency: 3 },
  historical: { provider: 'alphaVantage', concurrency: 1 },
};
const RETRY_SETTINGS = {
  finnhub: { attempts: 3, baseDelayMs: 1000, maximumDelayMs: 15000 },
  alphaVantage: { attempts: 2, baseDelayMs: 15000, maximumDelayMs: 60000 },
};

function isoNow() {
  return new Date().toISOString();
}

function delay(milliseconds) {
  return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

function successfulStatus(provider, checkedAt) {
  return { provider: provider, ok: true, checkedAt: checkedAt };
}

function failedStatus(provider, checkedAt, error) {
  const status = {
    provider: provider,
    ok: false,
    checkedAt: checkedAt,
    error: error instanceof Error ? error.message : 'Provider refresh failed',
  };
  if (error instanceof ProviderResponseError) {
    status.code = error.code;
    status.downstreamStatus = error.downstreamStatus;
    if (error.upstreamStatus) status.upstreamStatus = error.upstreamStatus;
  }
  if (error instanceof ProviderRateLimitError && error.nextAllowedAt) {
    status.nextAllowedRefreshAt = new Date(error.nextAllowedAt).toISOString();
  }
  return status;
}

function hasQuote(data) {
  return data && Number.isFinite(Number(data.c));
}

function hasObjectData(data) {
  return data && typeof data === 'object' && Object.keys(data).length > 0;
}

export async function mapWithConcurrency(values, concurrency, mapper) {
  const results = new Array(values.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }

  const workers = [];
  const count = Math.min(Math.max(1, concurrency), values.length);
  for (let index = 0; index < count; index += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

export function createProviderRequester(env, provider) {
  const settings = RETRY_SETTINGS[provider];
  let nextAllowedAtPromise = getProviderBackoff(env.DB, provider).then(function (state) {
    return state.nextAllowedAt;
  });

  return async function request(operation) {
    for (let attempt = 0; attempt < settings.attempts; attempt += 1) {
      const nextAllowedAt = await nextAllowedAtPromise;
      const waitMs = nextAllowedAt - Date.now();
      if (waitMs > settings.maximumDelayMs) {
        const error = new ProviderRateLimitError(provider, waitMs, provider + ' refresh is in backoff');
        error.nextAllowedAt = nextAllowedAt;
        throw error;
      }
      if (waitMs > 0) await delay(waitMs);

      try {
        return await operation();
      } catch (error) {
        if (!(error instanceof ProviderRateLimitError)) throw error;

        const exponentialDelay = Math.min(
          settings.maximumDelayMs,
          settings.baseDelayMs * (2 ** attempt)
        );
        const retryDelay = Math.max(exponentialDelay, error.retryAfterMs || 0);
        const nextAllowedAt = Date.now() + retryDelay;
        error.nextAllowedAt = nextAllowedAt;
        nextAllowedAtPromise = nextAllowedAtPromise.then(function (current) {
          return Math.max(current, nextAllowedAt);
        });
        await recordProviderBackoff(
          env.DB,
          provider,
          nextAllowedAt,
          isoNow(),
          error.message
        );

        if (retryDelay > settings.maximumDelayMs || attempt + 1 >= settings.attempts) throw error;
      }
    }
    throw new Error(provider + ' retry policy exhausted');
  };
}

async function refreshRecords(env, options) {
  const previous = await getMarketRecords(env.DB, options.key);
  const checkedAt = isoNow();
  const request = createProviderRequester(env, options.provider);

  const records = await mapWithConcurrency(options.instruments, options.concurrency, async function (instrument) {
    const symbol = instrument.symbol;
    const providerSymbol = instrument.providerSymbols[options.provider];
    const oldRecord = previous[symbol];
    try {
      const value = await request(function () { return options.fetchSymbol(providerSymbol); });
      if (!options.isValid(value)) throw new Error(options.provider + ' returned no usable data');
      return {
        symbol: symbol,
        data: value,
        updatedAt: checkedAt,
        checkedAt: checkedAt,
        providerStatus: successfulStatus(options.provider, checkedAt),
      };
    } catch (error) {
      return {
        symbol: symbol,
        data: oldRecord ? oldRecord.data : null,
        updatedAt: oldRecord ? oldRecord.updatedAt : null,
        checkedAt: checkedAt,
        providerStatus: failedStatus(options.provider, checkedAt, error),
      };
    }
  });

  await putMarketRecords(env.DB, options.key, records);
  return {
    successful: records.filter(function (record) { return record.providerStatus.ok; }).length,
    total: options.instruments.length,
    checkedAt: checkedAt,
  };
}

export function refreshQuotes(env) {
  return refreshRecords(env, {
    key: SNAPSHOT_KEYS.quotes,
    instruments: instrumentsSupporting('quote'),
    provider: 'finnhub',
    concurrency: JOB_SETTINGS.quotes.concurrency,
    fetchSymbol: function (symbol) {
      return fetchFinnhub('/quote', { symbol: symbol }, env.FINNHUB_API_KEY);
    },
    isValid: hasQuote,
  });
}

export function refreshProfiles(env) {
  return refreshRecords(env, {
    key: SNAPSHOT_KEYS.profiles,
    instruments: stocksSupporting('profile'),
    provider: 'finnhub',
    concurrency: JOB_SETTINGS.profiles.concurrency,
    fetchSymbol: function (symbol) {
      return fetchFinnhub('/stock/profile2', { symbol: symbol }, env.FINNHUB_API_KEY);
    },
    isValid: hasObjectData,
  });
}

export function refreshMetrics(env) {
  return refreshRecords(env, {
    key: SNAPSHOT_KEYS.metrics,
    instruments: stocksSupporting('metrics'),
    provider: 'finnhub',
    concurrency: JOB_SETTINGS.metrics.concurrency,
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
    instruments: stocksSupporting('news'),
    provider: 'finnhub',
    concurrency: JOB_SETTINGS.news.concurrency,
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
  const request = createProviderRequester(env, 'alphaVantage');

  const statusRecords = await mapWithConcurrency(
    instrumentsSupporting('historical'),
    JOB_SETTINGS.historical.concurrency,
    async function (instrument) {
      const symbol = instrument.symbol;
      const providerSymbol = instrument.providerSymbols.alphaVantage;
      const storageKey = historicalStorageKey(
        symbol,
        HISTORICAL_SERIES.providerFunction,
        HISTORICAL_SERIES.outputSize,
        HISTORICAL_SERIES.normalizationVersion
      );
      const oldRecord = previous[storageKey];
      try {
        const series = await request(function () {
          return fetchAlphaVantageDaily(
            providerSymbol,
            env.ALPHA_VANTAGE_API_KEY,
            !oldRecord || !oldRecord.updatedAt
          );
        });
        const providerStatus = successfulStatus('alphaVantage', checkedAt);
        const rows = Object.entries(series).map(function (entry) {
          return {
            storageKey: storageKey,
            symbol: symbol,
            providerFunction: HISTORICAL_SERIES.providerFunction,
            outputSize: HISTORICAL_SERIES.outputSize,
            normalizationVersion: HISTORICAL_SERIES.normalizationVersion,
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
        return {
          symbol: storageKey,
          data: { symbol: symbol, rowCount: rows.length },
          updatedAt: checkedAt,
          checkedAt: checkedAt,
          providerStatus: providerStatus,
        };
      } catch (error) {
        return {
          symbol: storageKey,
          data: oldRecord ? oldRecord.data : { symbol: symbol, rowCount: 0 },
          updatedAt: oldRecord ? oldRecord.updatedAt : null,
          checkedAt: checkedAt,
          providerStatus: failedStatus('alphaVantage', checkedAt, error),
        };
      }
    }
  );

  await putMarketRecords(env.DB, 'historical', statusRecords);
  return {
    successful: statusRecords.filter(function (record) { return record.providerStatus.ok; }).length,
    total: instrumentsSupporting('historical').length,
    checkedAt: checkedAt,
  };
}

const REFRESHERS = {
  quotes: refreshQuotes,
  profiles: refreshProfiles,
  metrics: refreshMetrics,
  news: refreshNews,
  historical: refreshHistorical,
};

const JOB_RECORD_TYPES = Object.freeze({
  quotes: SNAPSHOT_KEYS.quotes,
  profiles: SNAPSHOT_KEYS.profiles,
  metrics: SNAPSHOT_KEYS.metrics,
  news: SNAPSHOT_KEYS.news,
  historical: 'historical',
});

export async function findUninitializedRefreshJobs(env, excludedJobs) {
  const excluded = new Set(excludedJobs || []);
  const candidates = REFRESH_JOB_ORDER.filter(function (job) { return !excluded.has(job); });
  const records = await Promise.all(candidates.map(function (job) {
    return getMarketRecords(env.DB, JOB_RECORD_TYPES[job]);
  }));

  return candidates.filter(function (job, index) {
    return Object.keys(records[index]).length === 0;
  });
}

export async function runScheduledRefreshCycle(env, scheduledJobs) {
  const planned = Array.from(new Set(scheduledJobs || []));
  const results = [];

  for (const job of planned) {
    results.push({ job: job, result: await runRefreshJob(env, job) });
  }

  const bootstrapJobs = await findUninitializedRefreshJobs(env, planned);
  for (const job of bootstrapJobs) {
    results.push({ job: job, bootstrap: true, result: await runRefreshJob(env, job) });
  }

  return results;
}

export function runRefreshJob(env, job) {
  if (localFlights.has(job)) return localFlights.get(job);

  const flight = (async function () {
    const settings = JOB_SETTINGS[job];
    if (!settings || !REFRESHERS[job]) throw new Error('Unknown refresh job: ' + job);

    const owner = crypto.randomUUID();
    const now = Date.now();
    const expiresAt = now + 14 * 60 * 1000;
    const jobLock = await acquireRefreshLock(env.DB, 'job:' + job, owner, now, expiresAt);
    if (!jobLock) return { skipped: true, reason: 'refresh-already-running' };

    let providerLock = false;
    try {
      providerLock = await acquireRefreshLock(
        env.DB,
        'provider:' + settings.provider,
        owner,
        now,
        expiresAt
      );
      if (!providerLock) return { skipped: true, reason: 'provider-refresh-already-running' };
      return await REFRESHERS[job](env);
    } finally {
      if (providerLock) await releaseRefreshLock(env.DB, 'provider:' + settings.provider, owner);
      await releaseRefreshLock(env.DB, 'job:' + job, owner);
    }
  })().finally(function () {
    localFlights.delete(job);
  });

  localFlights.set(job, flight);
  return flight;
}
