const FINNHUB_BASE = 'https://finnhub.io/api/v1';

const TTL = {
  '/quote': 30,
  '/stock/candle': 300,
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

export async function onRequest(context) {
  const { request, env } = context;
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

  if (!env.FINNHUB_API_KEY) {
    return new Response('Server misconfigured: missing FINNHUB_API_KEY secret', { status: 500 });
  }

  const endpoint = url.pathname.replace(/^\/api/, '');
  const params = new URLSearchParams(url.search);
  params.set('token', env.FINNHUB_API_KEY);
  const finnhubUrl = `${FINNHUB_BASE}${endpoint}?${params.toString()}`;

  const cacheKey = new Request(finnhubUrl);
  const cache = caches.default;

  let response = await cache.match(cacheKey);
  let cacheHit = true;

  if (!response) {
    cacheHit = false;
    response = await fetch(finnhubUrl);

    const ttl = getTTL(endpoint);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', `public, max-age=${ttl}`);

    const cached = new Response(response.clone().body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });

    context.waitUntil(cache.put(cacheKey, cached));
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
