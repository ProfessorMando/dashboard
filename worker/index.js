const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const AV_BASE = 'https://www.alphavantage.co/query';

const TTL = {
  '/quote': 30,
  '/stock/profile2': 21600,
  '/stock/metric': 3600,
  '/company-news': 900,
};

function getTTL(endpoint) {
  for (const key of Object.keys(TTL)) {
    if (endpoint.startsWith(key)) return TTL[key];
  }
  return 60;
}

// =============================================
// Rate Limiter — assigns unique time slots atomically
// =============================================
class RateLimiter {
  constructor(maxPerSec) {
    this.delay = 1000 / maxPerSec;
    this.nextTime = 0;
  }

  async acquire() {
    this.nextTime = Math.max(Date.now(), this.nextTime);
    const myTime = this.nextTime;
    this.nextTime = myTime + this.delay;
    const wait = myTime - Date.now();
    if (wait > 0) {
      await new Promise(function (r) { setTimeout(r, wait); });
    }
  }
}

const finnhubLimiter = new RateLimiter(0.5);
const avLimiter = new RateLimiter(0.5);

async function fetchWithRateLimit(url, limiter) {
  await limiter.acquire();
  return fetch(url);
}

// =============================================
// Finnhub proxy
// =============================================
async function handleFinnhub(endpoint, searchParams, env, ctx) {
  const params = new URLSearchParams(searchParams);
  params.set('token', env.FINNHUB_API_KEY);
  const url = FINNHUB_BASE + endpoint + '?' + params.toString();

  const cacheKey = new Request(url);
  const cache = caches.default;

  var response = await cache.match(cacheKey);
  var cacheHit = true;

  if (!response) {
    cacheHit = false;
    response = await fetchWithRateLimit(url, finnhubLimiter);

    const ttl = getTTL(endpoint);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'public, max-age=' + ttl);

    const cached = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });

    ctx.waitUntil(cache.put(cacheKey, cached));
  }

  const outHeaders = new Headers(response.headers);
  outHeaders.set('Access-Control-Allow-Origin', '*');
  outHeaders.set('X-Cache', cacheHit ? 'HIT' : 'MISS');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders,
  });
}

// =============================================
// Alpha Vantage — candle/historical data
// =============================================
function parseAVDate(dateStr) {
  const parts = dateStr.split('-');
  return Date.UTC(+parts[0], +parts[1] - 1, +parts[2]) / 1000;
}

function floorDay(ts) {
  return ts - (ts % 86400);
}

function transformAVData(raw, from, to) {
  const fromDay = floorDay(from);
  const toDay = floorDay(to);

  var seriesKey = null;
  Object.keys(raw).forEach(function (k) {
    if (k.startsWith('Time Series')) seriesKey = k;
  });
  if (!seriesKey) return null;

  const series = raw[seriesKey];
  const entries = [];

  Object.keys(series).forEach(function (dateStr) {
    const ts = parseAVDate(dateStr);
    if (ts >= fromDay && ts <= toDay) {
      entries.push({
        t: ts,
        c: parseFloat(series[dateStr]['4. close']),
      });
    }
  });

  entries.sort(function (a, b) { return a.t - b.t; });

  var cArr = [];
  var tArr = [];
  for (var i = 0; i < entries.length; i++) {
    cArr.push(entries[i].c);
    tArr.push(entries[i].t);
  }

  return { s: 'ok', c: cArr, t: tArr };
}

async function handleCandle(symbol, from, to, env, ctx) {
  if (!env.ALPHA_VANTAGE_API_KEY) {
    return new Response(JSON.stringify({ s: 'no_data' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const cacheKey = new Request('https://av-cache.internal/' + symbol);
  const cache = caches.default;

  var fullData = null;
  var cached = await cache.match(cacheKey);

  if (cached) {
    try { fullData = await cached.json(); } catch (e) { /* stale, refetch */ }
  }

  if (!fullData) {
    const params = new URLSearchParams();
    params.set('function', 'TIME_SERIES_DAILY');
    params.set('symbol', symbol);
    params.set('outputsize', 'compact');
    params.set('apikey', env.ALPHA_VANTAGE_API_KEY);
    const avUrl = AV_BASE + '?' + params.toString();

    const response = await fetchWithRateLimit(avUrl, avLimiter);
    const raw = await response.json();

    if (raw['Error Message'] || raw['Note']) {
      return new Response(JSON.stringify({ s: 'no_data' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    const body = JSON.stringify(raw);
    const cachedRes = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=86400',
      },
    });

    ctx.waitUntil(cache.put(cacheKey, cachedRes));
    fullData = raw;
  }

  const result = transformAVData(fullData, from, to);

  return new Response(JSON.stringify(result || { s: 'no_data' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// =============================================
// Route dispatch
// =============================================
async function handleAPI(request, env, ctx) {
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

  if (request.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 });
  }

  const endpoint = url.pathname.replace(/^\/api/, '');

  if (endpoint === '/health') {
    return new Response(JSON.stringify({
      finnhubConfigured: Boolean(env.FINNHUB_API_KEY),
      alphaVantageConfigured: Boolean(env.ALPHA_VANTAGE_API_KEY),
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  if (endpoint === '/stock/candle') {
    const from = parseInt(url.searchParams.get('from'), 10);
    const to = parseInt(url.searchParams.get('to'), 10);

    if (isNaN(from) || isNaN(to)) {
      return new Response(JSON.stringify({ s: 'no_data' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    return handleCandle(url.searchParams.get('symbol'), from, to, env, ctx);
  }

  if (!env.FINNHUB_API_KEY) {
    return new Response('Server misconfigured: missing FINNHUB_API_KEY secret', { status: 500 });
  }

  return handleFinnhub(endpoint, url.search, env, ctx);
}

// =============================================
// Main entry point
// =============================================
function jsonError(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status: status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleAPI(request, env, ctx);
      } catch (e) {
        return jsonError(502, 'Upstream request failed');
      }
    }

    return env.ASSETS.fetch(request);
  },
};
