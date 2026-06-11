import {
  ALL_SYMBOLS,
  CRON_JOBS,
  HISTORICAL_SERIES,
  INDICATOR_SYMBOLS,
  MAX_AGE_SECONDS,
  SNAPSHOT_KEYS,
  instrumentBySymbol,
  instrumentSupportSnapshot,
  instrumentsSupporting,
  stocksSupporting,
} from './config.js';
import { runScheduledRefreshCycle } from './refresh.js';
import { getHistoricalSeries, getMarketRecords, historicalStorageKey } from './storage.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function jsonResponse(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: JSON_HEADERS });
}

function isStale(updatedAt, maxAgeSeconds) {
  if (!updatedAt) return true;
  const timestamp = Date.parse(updatedAt);
  return !Number.isFinite(timestamp) || Date.now() - timestamp > maxAgeSeconds * 1000;
}

function summarizeRecords(records, symbols, maxAgeSeconds) {
  const data = {};
  const providerStatus = {};
  const updatedTimes = [];
  let stale = false;

  for (const symbol of symbols) {
    const record = records[symbol];
    if (record) providerStatus[symbol] = record.providerStatus;
    if (record && record.data !== null) data[symbol] = record.data;
    if (record && record.updatedAt) updatedTimes.push(record.updatedAt);
    if (!record || record.data === null || isStale(record.updatedAt, maxAgeSeconds)) stale = true;
  }

  return {
    data: data,
    updatedAt: updatedTimes.length ? updatedTimes.sort()[0] : null,
    stale: stale,
    providerStatus: providerStatus,
  };
}

function storedProviderFailure(recordGroups, requireMissingData) {
  const failures = recordGroups.flatMap(function (group) {
    return group.symbols.map(function (symbol) { return group.records[symbol]; }).filter(function (record) {
      return record && (!requireMissingData || record.data === null) && record.providerStatus
        && record.providerStatus.ok === false;
    }).map(function (record) { return record.providerStatus; });
  });
  if (!failures.length) return null;

  return failures.sort(function (left, right) {
    return (right.downstreamStatus || 502) - (left.downstreamStatus || 502);
  })[0];
}

function providerErrorResponse(failure) {
  const reason = failure.code || 'provider_unavailable';
  return jsonResponse({
    s: 'no_data',
    reason: reason,
    error: {
      code: reason,
      message: 'No stored market data is available',
      provider: failure.provider || 'unknown',
    },
    stale: false,
  }, failure.downstreamStatus || 502);
}

async function handleDashboard(env) {
  const entries = await Promise.all([
    getMarketRecords(env.DB, SNAPSHOT_KEYS.quotes),
    getMarketRecords(env.DB, SNAPSHOT_KEYS.profiles),
    getMarketRecords(env.DB, SNAPSHOT_KEYS.metrics),
    getMarketRecords(env.DB, SNAPSHOT_KEYS.news),
  ]);
  const quoteSymbols = instrumentsSupporting('quote').map(function (instrument) { return instrument.symbol; });
  const profileSymbols = stocksSupporting('profile').map(function (instrument) { return instrument.symbol; });
  const metricSymbols = stocksSupporting('metrics').map(function (instrument) { return instrument.symbol; });
  const newsSymbols = stocksSupporting('news').map(function (instrument) { return instrument.symbol; });
  const quotes = summarizeRecords(entries[0], quoteSymbols, MAX_AGE_SECONDS.quotes);
  const profiles = summarizeRecords(entries[1], profileSymbols, MAX_AGE_SECONDS.profiles);
  const metrics = summarizeRecords(entries[2], metricSymbols, MAX_AGE_SECONDS.metrics);
  const news = summarizeRecords(entries[3], newsSymbols, MAX_AGE_SECONDS.news);
  const categories = { quotes: quotes, profiles: profiles, metrics: metrics, news: news };
  const hasStoredData = Object.values(categories).some(function (entry) {
    return Object.keys(entry.data).length > 0;
  });
  if (!hasStoredData) {
    const failure = storedProviderFailure([
      { records: entries[0], symbols: quoteSymbols },
      { records: entries[1], symbols: profileSymbols },
      { records: entries[2], symbols: metricSymbols },
      { records: entries[3], symbols: newsSymbols },
    ], true);
    if (failure) return providerErrorResponse(failure);
  }

  const updatedTimes = Object.values(categories).map(function (entry) {
    return entry.updatedAt;
  }).filter(Boolean);
  const indicatorQuotes = {};

  for (const symbol of INDICATOR_SYMBOLS) {
    if (quotes.data[symbol]) indicatorQuotes[symbol] = quotes.data[symbol];
  }

  return jsonResponse({
    updatedAt: updatedTimes.length ? updatedTimes.sort()[0] : null,
    stale: Object.values(categories).some(function (entry) { return entry.stale; }),
    providerStatus: Object.fromEntries(Object.entries(categories).map(function (entry) {
      return [entry[0], {
        updatedAt: entry[1].updatedAt,
        stale: entry[1].stale,
        records: entry[1].providerStatus,
      }];
    })),
    instruments: instrumentSupportSnapshot(),
    indicators: indicatorQuotes,
    stocks: {
      quotes: quotes.data,
      profiles: profiles.data,
      metrics: metrics.data,
      news: news.data,
    },
  });
}

function dateDaysAgo(days) {
  return new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
}

function historicalRequestError(message) {
  return { error: 'Invalid historical request', message: message };
}

function normalizeHistoricalRequest(rawRequest) {
  const requestedSymbols = Array.isArray(rawRequest.symbols)
    ? rawRequest.symbols
    : String(rawRequest.symbols || '').split(',');
  const symbols = Array.from(new Set(requestedSymbols.map(function (symbol) {
    return String(symbol).trim().toUpperCase();
  }).filter(Boolean)));
  const requestedDays = Number.parseInt(rawRequest.days || '3650', 10);
  const resolution = String(rawRequest.resolution || 'D').toUpperCase();

  if (!symbols.length) throw new Error('At least one symbol is required');
  const unsupported = symbols.filter(function (symbol) { return !ALL_SYMBOLS.includes(symbol); });
  if (unsupported.length) throw new Error('Unsupported symbols: ' + unsupported.join(', '));
  if (!Number.isFinite(requestedDays) || requestedDays < 1 || requestedDays > 3650) {
    throw new Error('days must be an integer from 1 through 3650');
  }
  if (resolution !== 'D' && resolution !== 'W') {
    throw new Error('resolution must be D or W');
  }

  return { symbols: symbols, days: requestedDays, resolution: resolution };
}

function parseHistoricalRequests(url) {
  const aggregate = url.searchParams.get('requests');
  if (aggregate) {
    let parsed;
    try {
      parsed = JSON.parse(aggregate);
    } catch (error) {
      throw new Error('requests must be valid JSON');
    }
    if (!Array.isArray(parsed) || !parsed.length) {
      throw new Error('requests must be a non-empty array');
    }
    const requests = parsed.map(normalizeHistoricalRequest);
    const seen = new Set();
    for (const request of requests) {
      for (const symbol of request.symbols) {
        if (seen.has(symbol)) throw new Error('Each symbol may appear in only one requested range');
        seen.add(symbol);
      }
    }
    return requests;
  }

  return [normalizeHistoricalRequest({
    symbols: url.searchParams.get('symbols') || ALL_SYMBOLS.join(','),
    days: url.searchParams.get('days') || '3650',
    resolution: url.searchParams.get('resolution') || 'D',
  })];
}

function weekStart(tradingDate) {
  const date = new Date(tradingDate + 'T00:00:00Z');
  const day = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1));
  return date.toISOString().slice(0, 10);
}

function normalizeHistoricalPoints(points, resolution) {
  let normalized = points;
  if (resolution === 'W') {
    const weeks = new Map();
    for (const point of points) weeks.set(weekStart(point.tradingDate), point);
    normalized = Array.from(weeks.values());
  }

  return {
    c: normalized.map(function (point) { return Number(point.close); }),
    t: normalized.map(function (point) {
      return Math.floor(Date.parse(point.tradingDate + 'T00:00:00Z') / 1000);
    }),
  };
}

function unsupportedHistoricalError(instrument) {
  return {
    code: 'unsupported_instrument',
    message: 'Data unavailable',
    detail: instrument.unavailableReason || 'Historical data is not supported for this instrument.',
    provider: null,
    intentional: true,
  };
}

function historicalSymbolError(record) {
  const status = record && record.providerStatus;
  if (status && status.ok === false) {
    return {
      code: status.code || 'provider_unavailable',
      message: status.error || 'Historical data is unavailable for this symbol',
      provider: status.provider || HISTORICAL_SERIES.provider,
    };
  }
  return {
    code: record ? 'empty_range' : 'not_stored',
    message: record
      ? 'No stored historical data is available in the requested range'
      : 'No stored historical data is available for this symbol',
    provider: HISTORICAL_SERIES.provider,
  };
}

async function handleHistorical(url, env) {
  let rangeRequests;
  try {
    rangeRequests = parseHistoricalRequests(url);
  } catch (error) {
    return jsonResponse(historicalRequestError(error.message), 400);
  }

  const records = await getMarketRecords(env.DB, 'historical');
  const storageRequests = [];
  const symbolRequests = {};

  for (const rangeRequest of rangeRequests) {
    for (const symbol of rangeRequest.symbols) {
      const instrument = instrumentBySymbol(symbol);
      if (!instrument.support.historical) {
        symbolRequests[symbol] = {
          days: rangeRequest.days,
          resolution: rangeRequest.resolution,
          instrument: instrument,
          supported: false,
        };
        continue;
      }
      const storageKey = historicalStorageKey(
        symbol,
        HISTORICAL_SERIES.providerFunction,
        HISTORICAL_SERIES.outputSize,
        HISTORICAL_SERIES.normalizationVersion
      );
      symbolRequests[symbol] = {
        days: rangeRequest.days,
        resolution: rangeRequest.resolution,
        storageKey: storageKey,
        supported: true,
      };
      storageRequests.push({
        symbol: symbol,
        storageKey: storageKey,
        fromDate: dateDaysAgo(rangeRequest.days),
      });
    }
  }

  const storedSeries = await getHistoricalSeries(env.DB, storageRequests);
  const series = {};
  const errors = {};
  const providerStatus = {};
  const updatedTimes = [];
  let stale = false;

  for (const entry of Object.entries(symbolRequests)) {
    const symbol = entry[0];
    const request = entry[1];
    if (!request.supported) {
      errors[symbol] = unsupportedHistoricalError(request.instrument);
      providerStatus[symbol] = {
        supported: false,
        intentional: true,
        code: 'unsupported_instrument',
      };
      continue;
    }
    const record = records[request.storageKey];
    const points = storedSeries[symbol] || [];
    if (record && record.providerStatus) providerStatus[symbol] = record.providerStatus;
    if (record && record.updatedAt) updatedTimes.push(record.updatedAt);
    if (!record || record.providerStatus.ok === false
      || isStale(record.updatedAt, MAX_AGE_SECONDS.historical)) stale = true;

    if (!points.length) {
      errors[symbol] = historicalSymbolError(record);
      stale = true;
      continue;
    }
    series[symbol] = normalizeHistoricalPoints(points, request.resolution);
  }

  const hasSeries = Object.keys(series).length > 0;
  const hasSupportedRequest = Object.values(symbolRequests).some(function (request) {
    return request.supported;
  });
  return jsonResponse({
    s: hasSeries ? (stale ? 'stale' : 'ok') : 'no_data',
    ...(hasSeries && stale ? { reason: 'partial_or_expired' } : {}),
    ...(!hasSeries ? { reason: hasSupportedRequest ? 'empty_range' : 'unsupported_instruments' } : {}),
    updatedAt: updatedTimes.length ? updatedTimes.sort()[0] : null,
    stale: stale,
    providerStatus: providerStatus,
    instruments: instrumentSupportSnapshot(),
    requests: rangeRequests,
    series: series,
    errors: errors,
  });
}

async function handleAPI(request, env) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  if (request.method !== 'GET') return jsonResponse({ error: 'Method not allowed' }, 405);

  if (url.pathname === '/api/health') {
    return jsonResponse({
      d1Configured: Boolean(env.DB),
      finnhubConfigured: Boolean(env.FINNHUB_API_KEY),
      alphaVantageConfigured: Boolean(env.ALPHA_VANTAGE_API_KEY),
    });
  }
  if (url.pathname === '/api/dashboard') return handleDashboard(env);
  if (url.pathname === '/api/historical') return handleHistorical(url, env);
  return jsonResponse({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleAPI(request, env);
      } catch (error) {
        console.error('API read failed', error);
        return jsonResponse({ error: 'Stored market data could not be read' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    const jobs = CRON_JOBS[controller.cron] || [];
    ctx.waitUntil(runScheduledRefreshCycle(env, jobs).catch(function (error) {
      console.error('Scheduled refresh cycle failed', controller.cron, error);
    }));
  },
};
