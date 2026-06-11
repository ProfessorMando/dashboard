import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  createProviderRequester,
  findUninitializedRefreshJobs,
  mapWithConcurrency,
  refreshQuotes,
} from '../worker/refresh.js';
import worker from '../worker/index.js';
import { fetchFinnhub, ProviderRateLimitError } from '../worker/providers.js';


test('scheduled bootstrap identifies only datasets with no stored records', async function () {
  const storedTypes = new Set(['quotes', 'metrics']);
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM market_records/);
      return {
        bind(dataType) {
          return {
            async all() {
              return {
                results: storedTypes.has(dataType)
                  ? [{
                      symbol: 'AAPL',
                      data: JSON.stringify({ value: true }),
                      updated_at: '2026-06-11T21:15:00.000Z',
                      checked_at: '2026-06-11T21:15:00.000Z',
                      provider_status: JSON.stringify({ ok: true }),
                    }]
                  : [],
              };
            },
          };
        },
      };
    },
  };

  const jobs = await findUninitializedRefreshJobs({ DB: db }, ['quotes']);

  assert.deepEqual(jobs, ['profiles', 'news', 'historical']);
});

test('scheduled bootstrap does not repeat initialized datasets even when records contain failures', async function () {
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM market_records/);
      return {
        bind(dataType) {
          return {
            async all() {
              return {
                results: [{
                  symbol: dataType === 'historical' ? 'historical|symbol=AAPL' : 'AAPL',
                  data: null,
                  updated_at: null,
                  checked_at: '2026-06-11T21:15:00.000Z',
                  provider_status: JSON.stringify({ ok: false, code: 'rate_limited' }),
                }],
              };
            },
          };
        },
      };
    },
  };

  assert.deepEqual(await findUninitializedRefreshJobs({ DB: db }, []), []);
});

test('mapWithConcurrency preserves order and enforces the configured limit', async function () {
  let active = 0;
  let maximumActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async function (value) {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(function (resolve) { setTimeout(resolve, 5); });
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maximumActive, 2);
});

test('Finnhub HTTP 429 responses expose Retry-After as provider rate-limit state', async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });
  globalThis.fetch = async function () {
    return new Response('{}', { status: 429, headers: { 'Retry-After': '7' } });
  };

  await assert.rejects(
    fetchFinnhub('/quote', { symbol: 'AAPL' }, 'secret'),
    function (error) {
      assert.ok(error instanceof ProviderRateLimitError);
      assert.equal(error.provider, 'finnhub');
      assert.equal(error.retryAfterMs, 7000);
      return true;
    }
  );
});

test('interactive worker entry point has no provider fetch dependency', async function () {
  const source = await import('node:fs/promises').then(function (fs) {
    return fs.readFile(new URL('../worker/index.js', import.meta.url), 'utf8');
  });

  assert.doesNotMatch(source, /RateLimiter|fetchWithRateLimit|fetchFinnhub|fetchAlphaVantage/);
  assert.match(source, /getMarketRecords/);
  assert.match(source, /async scheduled/);
});

test('interactive dashboard requests return stored snapshots without provider fetches', async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });
  globalThis.fetch = async function () { throw new Error('provider fetch must not run'); };
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM market_records/);
      return {
        bind() {
          return { async all() { return { results: [] }; } };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/dashboard'),
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.stale, true);
  assert.deepEqual(body.stocks.quotes, {});
});

test('provider retry state persists a long Retry-After without waiting through it', async function () {
  const writes = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              assert.match(sql, /FROM provider_backoff/);
              return null;
            },
            async run() {
              writes.push(values);
            },
          };
        },
      };
    },
  };
  const request = createProviderRequester({ DB: db }, 'finnhub');
  let calls = 0;
  const before = Date.now();

  await assert.rejects(request(async function () {
    calls += 1;
    throw new ProviderRateLimitError('finnhub', 120000, 'quota exceeded');
  }), ProviderRateLimitError);

  assert.equal(calls, 1);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'finnhub');
  assert.ok(writes[0][1] >= before + 120000);
});

test('Finnhub requests sort public parameters and discard caller-supplied credentials', async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });
  let requestedUrl;
  globalThis.fetch = async function (url) {
    requestedUrl = String(url);
    return new Response(JSON.stringify({ c: 100, t: 1700000000 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  await fetchFinnhub('/quote', {
    symbol: 'AAPL',
    z: 'last',
    password: 'discard-me',
    apiKey: 'discard-me-too',
    a: 'first',
  }, 'server-secret');

  const url = new URL(requestedUrl);
  assert.equal(url.search, '?a=first&symbol=AAPL&z=last&token=server-secret');
  assert.equal(url.searchParams.has('password'), false);
  assert.equal(url.searchParams.has('apiKey'), false);
});

test('Finnhub rejects successful HTML responses', async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });
  globalThis.fetch = async function () {
    return new Response('<html>upstream error</html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  };

  await assert.rejects(
    fetchFinnhub('/quote', { symbol: 'AAPL' }, 'secret'),
    function (error) {
      assert.equal(error.provider, 'finnhub');
      assert.equal(error.code, 'invalid_content_type');
      assert.equal(error.downstreamStatus, 502);
      return true;
    }
  );
});

test('Finnhub rejects malformed JSON and endpoint-incompatible JSON', async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });

  globalThis.fetch = async function () {
    return new Response('{"c":', { headers: { 'Content-Type': 'application/json' } });
  };
  await assert.rejects(
    fetchFinnhub('/quote', { symbol: 'AAPL' }, 'secret'),
    function (error) { return error.code === 'malformed_json'; }
  );

  globalThis.fetch = async function () {
    return new Response(JSON.stringify({ ticker: 'AAPL' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };
  await assert.rejects(
    fetchFinnhub('/quote', { symbol: 'AAPL' }, 'secret'),
    function (error) { return error.code === 'invalid_payload'; }
  );
});

test('dashboard returns a normalized provider error when no fallback exists', async function () {
  const failedStatus = JSON.stringify({
    provider: 'finnhub',
    ok: false,
    code: 'rate_limited',
    downstreamStatus: 503,
  });
  const db = {
    prepare() {
      return {
        bind(dataType) {
          return {
            async all() {
              return dataType === 'quotes' ? {
                results: [{
                  symbol: 'AAPL',
                  data: null,
                  updated_at: null,
                  checked_at: '2026-06-11T00:00:00.000Z',
                  provider_status: failedStatus,
                }],
              } : { results: [] };
            },
          };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/dashboard'),
    { DB: db }
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    s: 'no_data',
    reason: 'rate_limited',
    error: {
      code: 'rate_limited',
      message: 'No stored market data is available',
      provider: 'finnhub',
    },
    stale: false,
  });
});

test('dashboard serves an older valid fallback as stale after provider failure', async function () {
  const failedStatus = JSON.stringify({
    provider: 'finnhub',
    ok: false,
    code: 'upstream_unavailable',
    downstreamStatus: 503,
  });
  const db = {
    prepare() {
      return {
        bind(dataType) {
          return {
            async all() {
              return dataType === 'quotes' ? {
                results: [{
                  symbol: 'AAPL',
                  data: JSON.stringify({ c: 190, t: 1700000000 }),
                  updated_at: '2020-01-01T00:00:00.000Z',
                  checked_at: '2026-06-11T00:00:00.000Z',
                  provider_status: failedStatus,
                }],
              } : { results: [] };
            },
          };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/dashboard'),
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.stale, true);
  assert.deepEqual(body.stocks.quotes.AAPL, { c: 190, t: 1700000000 });
  assert.equal(body.providerStatus.quotes.records.AAPL.ok, false);
});


test('invalid Finnhub refreshes retain stored valid records', async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });
  globalThis.fetch = async function () {
    return new Response('<html>temporary failure</html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  };

  const writes = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          if (/FROM market_records/.test(sql)) {
            return {
              async all() {
                return {
                  results: [{
                    symbol: 'AAPL',
                    data: JSON.stringify({ c: 190, t: 1700000000 }),
                    updated_at: '2026-06-10T00:00:00.000Z',
                    checked_at: '2026-06-10T00:00:00.000Z',
                    provider_status: JSON.stringify({ provider: 'finnhub', ok: true }),
                  }],
                };
              },
            };
          }
          if (/FROM provider_backoff/.test(sql)) {
            return { async first() { return null; } };
          }
          return { sql: sql, values: values };
        },
      };
    },
    async batch(statements) {
      writes.push(...statements);
    },
  };

  const result = await refreshQuotes({ DB: db, FINNHUB_API_KEY: 'secret' });
  const aaplWrite = writes.find(function (statement) {
    return statement.values[1] === 'AAPL';
  });

  assert.equal(result.successful, 0);
  assert.ok(aaplWrite);
  assert.deepEqual(JSON.parse(aaplWrite.values[2]), { c: 190, t: 1700000000 });
  assert.equal(aaplWrite.values[3], '2026-06-10T00:00:00.000Z');
  assert.equal(JSON.parse(aaplWrite.values[5]).code, 'invalid_content_type');
});

test('historical API reports provider unavailability as structured no-data status', async function () {
  const failedStatus = JSON.stringify({
    provider: 'alphaVantage',
    ok: false,
    code: 'rate_limited',
    downstreamStatus: 503,
  });
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (/FROM market_records/.test(sql)) {
                return { results: [{
                  symbol: 'historical|symbol=AAPL|function=TIME_SERIES_DAILY|outputsize=full|normalization=v1',
                  data: null,
                  updated_at: null,
                  checked_at: '2026-06-11T00:00:00.000Z',
                  provider_status: failedStatus,
                }] };
              }
              return { results: [] };
            },
          };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/historical?symbols=AAPL&days=30&resolution=D'),
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.s, 'no_data');
  assert.equal(body.reason, 'empty_range');
  assert.equal(body.errors.AAPL.code, 'rate_limited');
});

test('historical API marks preserved series stale when its latest refresh failed', async function () {
  const failedStatus = JSON.stringify({
    provider: 'alphaVantage',
    ok: false,
    code: 'upstream_unavailable',
    downstreamStatus: 503,
  });
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (/FROM market_records/.test(sql)) {
                return { results: [{
                  symbol: 'historical|symbol=AAPL|function=TIME_SERIES_DAILY|outputsize=full|normalization=v1',
                  data: JSON.stringify({ rowCount: 100 }),
                  updated_at: '2026-06-10T00:00:00.000Z',
                  checked_at: '2026-06-11T00:00:00.000Z',
                  provider_status: failedStatus,
                }] };
              }
              return { results: [{ symbol: 'AAPL', trading_date: '2026-06-10', close: 201.25 }] };
            },
          };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/historical?symbols=AAPL&days=30&resolution=D'),
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.s, 'stale');
  assert.equal(body.reason, 'partial_or_expired');
  assert.equal(body.providerStatus.AAPL.code, 'upstream_unavailable');
  assert.deepEqual(body.series.AAPL.c, [201.25]);
});

test('historical API distinguishes an empty requested range from provider failure', async function () {
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (/FROM market_records/.test(sql)) return { results: [] };
              return { results: [] };
            },
          };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/historical?days=1'),
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.s, 'no_data');
  assert.equal(body.reason, 'empty_range');
  assert.deepEqual(body.series, {});
});

test('historical API aggregates requested ranges, resamples weekly data, and isolates symbol errors', async function () {
  const aaplKey = 'historical|symbol=AAPL|function=TIME_SERIES_DAILY|outputsize=full|normalization=v1';
  const spyKey = 'historical|symbol=SPY|function=TIME_SERIES_DAILY|outputsize=full|normalization=v1';
  const db = {
    prepare(sql) {
      return {
        bind() {
          return {
            async all() {
              if (/FROM market_records/.test(sql)) {
                return { results: [
                  {
                    symbol: aaplKey,
                    data: JSON.stringify({ symbol: 'AAPL', rowCount: 3 }),
                    updated_at: new Date().toISOString(),
                    checked_at: new Date().toISOString(),
                    provider_status: JSON.stringify({ provider: 'alphaVantage', ok: true }),
                  },
                  {
                    symbol: spyKey,
                    data: JSON.stringify({ symbol: 'SPY', rowCount: 0 }),
                    updated_at: null,
                    checked_at: new Date().toISOString(),
                    provider_status: JSON.stringify({
                      provider: 'alphaVantage',
                      ok: false,
                      code: 'rate_limited',
                    }),
                  },
                ] };
              }
              return { results: [
                { storage_key: aaplKey, symbol: 'AAPL', trading_date: '2026-06-01', close: 100 },
                { storage_key: aaplKey, symbol: 'AAPL', trading_date: '2026-06-05', close: 105 },
                { storage_key: aaplKey, symbol: 'AAPL', trading_date: '2026-06-08', close: 110 },
              ] };
            },
          };
        },
      };
    },
  };
  const requests = JSON.stringify([
    { symbols: ['AAPL'], days: 30, resolution: 'W' },
    { symbols: ['SPY'], days: 7, resolution: 'D' },
  ]);

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/historical?requests=' + encodeURIComponent(requests)),
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.s, 'stale');
  assert.deepEqual(body.series.AAPL.c, [105, 110]);
  assert.equal(body.series.SPY, undefined);
  assert.equal(body.errors.SPY.code, 'rate_limited');
  assert.equal(body.requests[0].resolution, 'W');
});

test('graph refresh uses one aggregate historical request and expires failed cache entries', async function () {
  const source = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(source, /var data = await fetchAllGraphData\(requests, forceRefresh\)/);
  assert.match(source, /requests: JSON\.stringify\(requests\)/);
  assert.match(source, /expiresAt: Date\.now\(\) \+ GRAPH_FAILURE_CACHE_MS/);
});

test('configured instruments expose provider symbols for every supported capability', async function () {
  const { INSTRUMENTS, instrumentBySymbol } = await import('../worker/config.js');
  const providerForCapability = {
    quote: 'finnhub',
    profile: 'finnhub',
    metrics: 'finnhub',
    news: 'finnhub',
    historical: 'alphaVantage',
  };

  for (const instrument of INSTRUMENTS) {
    for (const entry of Object.entries(providerForCapability)) {
      const capability = entry[0];
      const provider = entry[1];
      if (instrument.support[capability]) {
        assert.equal(typeof instrument.providerSymbols[provider], 'string');
        assert.ok(instrument.providerSymbols[provider].length > 0);
      }
    }
  }

  const privateCompany = instrumentBySymbol('SPCX');
  assert.equal(privateCompany.type, 'private_company');
  assert.deepEqual(Object.values(privateCompany.support), [false, false, false, false, false]);
  assert.equal(privateCompany.providerSymbols.finnhub, null);
  assert.equal(privateCompany.providerSymbols.alphaVantage, null);
});

test('dashboard snapshot includes intentional per-instrument support status', async function () {
  const db = {
    prepare(sql) {
      assert.match(sql, /FROM market_records/);
      return {
        bind() {
          return {
            async all() {
              return {
                results: [{
                  symbol: 'SPCX',
                  data: null,
                  updated_at: null,
                  checked_at: '2026-06-11T00:00:00.000Z',
                  provider_status: JSON.stringify({
                    provider: 'finnhub',
                    ok: false,
                    code: 'upstream_unavailable',
                    downstreamStatus: 503,
                  }),
                }],
              };
            },
          };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/dashboard'),
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.instruments.AAPL.support.quote, true);
  assert.equal(body.instruments.AAPL.providerSymbols.finnhub, 'AAPL');
  assert.equal(body.instruments.SPCX.support.quote, false);
  assert.equal(body.instruments.SPCX.support.historical, false);
  assert.match(body.instruments.SPCX.unavailableReason, /private company/);
});

test('historical API returns intentional unavailability without reading price rows', async function () {
  const statements = [];
  const db = {
    prepare(sql) {
      statements.push(sql);
      return {
        bind() {
          return { async all() { return { results: [] }; } };
        },
      };
    },
  };

  const response = await worker.fetch(
    new Request('https://dashboard.example/api/historical?symbols=SPCX&days=365&resolution=D'),
    { DB: db }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.s, 'no_data');
  assert.equal(body.reason, 'unsupported_instruments');
  assert.equal(body.stale, false);
  assert.equal(body.errors.SPCX.code, 'unsupported_instrument');
  assert.equal(body.errors.SPCX.message, 'Data unavailable');
  assert.equal(body.errors.SPCX.intentional, true);
  assert.equal(statements.some(function (sql) { return /historical_series_prices/.test(sql); }), false);
});

test('quote refresh suppresses provider requests for intentionally unsupported instruments', async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });
  const requestedSymbols = [];
  globalThis.fetch = async function (url) {
    requestedSymbols.push(new URL(url).searchParams.get('symbol'));
    return new Response(JSON.stringify({ c: 100, d: 1, dp: 1, t: 1700000000 }), {
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const writes = [];
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          if (/FROM market_records/.test(sql)) {
            return { async all() { return { results: [] }; } };
          }
          if (/FROM provider_backoff/.test(sql)) {
            return { async first() { return null; } };
          }
          return { sql: sql, values: values };
        },
      };
    },
    async batch(statements) {
      writes.push(...statements);
    },
  };

  const result = await refreshQuotes({ DB: db, FINNHUB_API_KEY: 'secret' });

  assert.equal(requestedSymbols.includes('SPCX'), false);
  assert.equal(writes.some(function (statement) { return statement.values[1] === 'SPCX'; }), false);
  assert.equal(result.total, requestedSymbols.length);
  assert.equal(result.successful, result.total);
});
