import assert from 'node:assert/strict';
import test from 'node:test';

import { refreshHistorical } from '../worker/refresh.js';
import {
  fetchAlphaVantageDaily,
  ProviderRateLimitError,
  ProviderResponseError,
} from '../worker/providers.js';

function jsonResponse(body, init) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init && init.headers) },
  });
}

async function withProviderResponse(context, response, operation) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });
  globalThis.fetch = async function () { return response; };
  return operation();
}

test('Alpha Vantage accepts a recognized series with valid dates and numeric closes', async function (context) {
  const series = await withProviderResponse(context, jsonResponse({
    'Meta Data': { '2. Symbol': 'AAPL' },
    'Time Series (Daily)': {
      '2026-06-10': { '4. close': '201.25' },
      'not-a-date': { '4. close': '202.00' },
      '2026-06-09': { '4. close': 'not-a-number' },
    },
  }), function () {
    return fetchAlphaVantageDaily('AAPL', 'secret', false);
  });

  assert.deepEqual(series, {
    '2026-06-10': { '4. close': '201.25' },
  });
});

test('Alpha Vantage invalid-key payloads are provider errors', async function (context) {
  await assert.rejects(
    withProviderResponse(context, jsonResponse({
      'Error Message': 'Invalid API call. Please retry or visit the documentation.',
    }), function () {
      return fetchAlphaVantageDaily('AAPL', 'invalid', false);
    }),
    function (error) {
      assert.ok(error instanceof ProviderResponseError);
      assert.equal(error.code, 'request_rejected');
      return true;
    }
  );
});

test('Alpha Vantage throttling payloads are rate-limit errors', async function (context) {
  await assert.rejects(
    withProviderResponse(context, jsonResponse({
      Information: 'Thank you for using Alpha Vantage. Our standard API rate limit applies.',
    }), function () {
      return fetchAlphaVantageDaily('AAPL', 'secret', false);
    }),
    function (error) {
      assert.ok(error instanceof ProviderRateLimitError);
      assert.equal(error.code, 'rate_limited');
      return true;
    }
  );
});

test('Alpha Vantage malformed JSON is rejected', async function (context) {
  await assert.rejects(
    withProviderResponse(context, new Response('{"Time Series (Daily)":', {
      headers: { 'Content-Type': 'application/json' },
    }), function () {
      return fetchAlphaVantageDaily('AAPL', 'secret', false);
    }),
    function (error) {
      assert.ok(error instanceof ProviderResponseError);
      assert.equal(error.code, 'malformed_json');
      return true;
    }
  );
});

test('Alpha Vantage HTTP failures are rejected before payload parsing', async function (context) {
  await assert.rejects(
    withProviderResponse(context, new Response('{"Time Series (Daily)": {}}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    }), function () {
      return fetchAlphaVantageDaily('AAPL', 'secret', false);
    }),
    function (error) {
      assert.ok(error instanceof ProviderResponseError);
      assert.equal(error.code, 'upstream_unavailable');
      assert.equal(error.upstreamStatus, 503);
      return true;
    }
  );
});

test('Alpha Vantage payloads without a valid recognized time series are provider errors', async function (context) {
  const payloads = [
    { unexpected: 'provider message under an unknown property' },
    { 'Intraday Prices': { '2026-06-10': { '4. close': '201.25' } } },
    { 'Time Series (Daily)': { '2026-02-30': { '4. close': '201.25' } } },
    { 'Time Series (Daily)': { '2026-06-10': { '4. close': '' } } },
  ];

  for (const payload of payloads) {
    await assert.rejects(
      withProviderResponse(context, jsonResponse(payload), function () {
        return fetchAlphaVantageDaily('AAPL', 'secret', false);
      }),
      function (error) {
        assert.ok(error instanceof ProviderResponseError);
        assert.equal(error.code, 'invalid_payload');
        return true;
      }
    );
  }
});

test('failed historical refreshes retain the last valid status record and do not write prices', async function (context) {
  const originalFetch = globalThis.fetch;
  context.after(function () { globalThis.fetch = originalFetch; });
  globalThis.fetch = async function () {
    return jsonResponse({ error_detail: 'provider rejected this request' });
  };

  const marketWrites = [];
  let historicalPriceWrites = 0;
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
                    data: JSON.stringify({ rowCount: 100 }),
                    updated_at: '2026-06-10T00:00:00.000Z',
                    checked_at: '2026-06-10T00:00:00.000Z',
                    provider_status: JSON.stringify({ provider: 'alphaVantage', ok: true }),
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
      if (statements.some(function (statement) {
        return /historical_prices/.test(statement.sql || '');
      })) {
        historicalPriceWrites += statements.length;
      } else {
        marketWrites.push(...statements);
      }
    },
  };

  const result = await refreshHistorical({ DB: db, ALPHA_VANTAGE_API_KEY: 'secret' });
  const aaplWrite = marketWrites.find(function (statement) {
    return statement.values[1] === 'AAPL';
  });

  assert.equal(result.successful, 0);
  assert.equal(historicalPriceWrites, 0);
  assert.ok(aaplWrite);
  assert.deepEqual(JSON.parse(aaplWrite.values[2]), { rowCount: 100 });
  assert.equal(aaplWrite.values[3], '2026-06-10T00:00:00.000Z');
  assert.equal(JSON.parse(aaplWrite.values[5]).code, 'invalid_payload');
});
