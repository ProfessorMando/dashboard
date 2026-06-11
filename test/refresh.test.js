import assert from 'node:assert/strict';
import test from 'node:test';

import { createProviderRequester, mapWithConcurrency } from '../worker/refresh.js';
import worker from '../worker/index.js';
import { fetchFinnhub, ProviderRateLimitError } from '../worker/providers.js';

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
