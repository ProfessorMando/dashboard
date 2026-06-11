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
// Rate Limiter — token bucket, 1 req/sec, burst 5
// =============================================
class RateLimiter {
  constructor(burst, refillPerSec) {
    this.burst = burst;
    this.refillPerSec = refillPerSec;
    this.tokens = burst;
    this.lastRefill = Date.now();
    this.queue = [];
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }

  drain() {
    while (this.queue.length > 0 && this.tokens >= 1) {
      this.tokens -= 1;
      this.queue.shift()();
    }
  }

  acquire() {
    this.refill();
    this.drain();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return Promise.resolve();
    }
    return new Promise(function (resolve) {
      this.queue.push(resolve);
    }.bind(this));
  }
}

const limiter = new RateLimiter(5, 1);

async function fetchWithRateLimit(url) {
  await limiter.acquire();
  return fetch(url);
}

// =============================================
// Finnhub proxy (existing, now with rate limiter)
// =============================================
async function handleFinnhub(endpoint, searchParams, env, ctx) {
  const params = new URLSearchParams(searchParams);
  params.set('token', env.FINNHUB_API_KEY);
  const url = `${FINNHUB_BASE}${endpoint}?${params.toString()}`;

  const cacheKey = new Request(url);
  const cache = caches.default;

  let response = await cache.match(cacheKey);
  let cacheHit = true;

  if (!response) {
    cacheHit = false;
    response = await fetchWithRateLimit(url);

    const ttl = getTTL(endpoint);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `public, max-age=${ttl}`);

    const cached = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers,
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

  const seriesKey = Object.keys(raw).find(function (k) { return k.startsWith('Time Series'); });
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

  return {
    s: 'ok',
    c: entries.map(function (e) { return e.c; }),
    t: entries.map(function (e) { return e.t; }),
  };
}

async function handleCandle(symbol, from, to, env, ctx) {
  if (!env.ALPHA_VANTAGE_API_KEY) {
    return new Response(JSON.stringify({ s: 'no_data' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  const cacheKey = new Request(`https://av-cache.internal/${symbol}`);
  const cache = caches.default;

  let cached = await cache.match(cacheKey);
  let fullData = null;

  if (cached) {
    const text = await cached.text();
    try { fullData = JSON.parse(text); } catch (e) { /* fall through */ }
  }

  if (!fullData) {
    const params = new URLSearchParams();
    params.set('function', 'TIME_SERIES_DAILY');
    params.set('symbol', symbol);
    params.set('outputsize', 'compact');
    params.set('apikey', env.ALPHA_VANTAGE_API_KEY);
    const avUrl = `${AV_BASE}?${params.toString()}`;

    const response = await fetchWithRateLimit(avUrl);
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
// Main request handler
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

  // Route /stock/candle to Alpha Vantage
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

  // Everything else → Finnhub
  if (!env.FINNHUB_API_KEY) {
    return new Response('Server misconfigured: missing FINNHUB_API_KEY secret', { status: 500 });
  }

  return handleFinnhub(endpoint, url.search, env, ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      return handleAPI(request, env, ctx);
    }

    return env.ASSETS.fetch(request);
  },
};
