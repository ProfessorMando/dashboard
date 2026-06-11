import { ALL_SYMBOLS, CRON_JOBS, INDICATORS, MAX_AGE_SECONDS, SNAPSHOT_KEYS, STOCKS } from './config.js';
import { runRefreshJob } from './refresh.js';
import { getHistoricalSeries, getMarketRecords } from './storage.js';

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
  const failures = recordGroups.flatMap(function (records) {
    return Object.values(records).filter(function (record) {
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
  const quotes = summarizeRecords(entries[0], ALL_SYMBOLS, MAX_AGE_SECONDS.quotes);
  const profiles = summarizeRecords(entries[1], STOCKS, MAX_AGE_SECONDS.profiles);
  const metrics = summarizeRecords(entries[2], STOCKS, MAX_AGE_SECONDS.metrics);
  const news = summarizeRecords(entries[3], STOCKS, MAX_AGE_SECONDS.news);
  const categories = { quotes: quotes, profiles: profiles, metrics: metrics, news: news };
  const hasStoredData = Object.values(categories).some(function (entry) {
    return Object.keys(entry.data).length > 0;
  });
  if (!hasStoredData) {
    const failure = storedProviderFailure(entries, true);
    if (failure) return providerErrorResponse(failure);
  }

  const updatedTimes = Object.values(categories).map(function (entry) {
    return entry.updatedAt;
  }).filter(Boolean);
  const indicatorQuotes = {};

  for (const symbol of INDICATORS) {
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

async function handleHistorical(url, env) {
  const requestedDays = Number.parseInt(url.searchParams.get('days') || '3650', 10);
  const days = Number.isFinite(requestedDays) ? Math.min(Math.max(requestedDays, 1), 3650) : 3650;
  const records = await getMarketRecords(env.DB, 'historical');
  const metadata = summarizeRecords(records, ALL_SYMBOLS, MAX_AGE_SECONDS.historical);
  const series = await getHistoricalSeries(env.DB, dateDaysAgo(days));
  const failure = storedProviderFailure([records], false);
  if (!Object.keys(series).length) {
    if (failure) return providerErrorResponse(failure);
    return jsonResponse({
      s: 'no_data',
      reason: 'empty_range',
      updatedAt: metadata.updatedAt,
      stale: metadata.stale,
      providerStatus: metadata.providerStatus,
      series: {},
    });
  }

  return jsonResponse({
    s: metadata.stale ? 'stale' : 'ok',
    ...(metadata.stale ? { reason: failure ? failure.code || 'provider_unavailable' : 'expired' } : {}),
    updatedAt: metadata.updatedAt,
    stale: metadata.stale,
    providerStatus: metadata.providerStatus,
    series: series,
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
    for (const job of jobs) {
      ctx.waitUntil(runRefreshJob(env, job).catch(function (error) {
        console.error('Scheduled refresh failed', job, error);
      }));
    }
  },
};
