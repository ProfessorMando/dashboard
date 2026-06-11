const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query';

function retryAfterMilliseconds(response, now) {
  const value = response.headers.get('Retry-After');
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export class ProviderRateLimitError extends Error {
  constructor(provider, retryAfterMs, message) {
    super(message || provider + ' rate limit reached');
    this.name = 'ProviderRateLimitError';
    this.provider = provider;
    this.retryAfterMs = retryAfterMs;
  }
}

function providerError(raw) {
  return raw.error || raw['Error Message'] || raw.Note || raw.Information;
}

async function fetchJson(url, provider) {
  const response = await fetch(url);
  const now = Date.now();

  if (response.status === 429) {
    throw new ProviderRateLimitError(
      provider,
      retryAfterMilliseconds(response, now),
      provider + ' returned HTTP 429'
    );
  }
  if (!response.ok) throw new Error(provider + ' returned HTTP ' + response.status);

  const data = await response.json();
  const message = providerError(data);
  if (message) {
    if (provider === 'alphaVantage' && (data.Note || data.Information)) {
      throw new ProviderRateLimitError(provider, null, 'Alpha Vantage rate limit reached');
    }
    throw new Error(provider + ' rejected the request');
  }
  return data;
}

export async function fetchFinnhub(endpoint, params, apiKey) {
  if (!apiKey) throw new Error('FINNHUB_API_KEY is not configured');
  const search = new URLSearchParams(params);
  search.set('token', apiKey);
  return fetchJson(FINNHUB_BASE + endpoint + '?' + search.toString(), 'finnhub');
}

export async function fetchAlphaVantageDaily(symbol, apiKey, fullHistory) {
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not configured');
  const search = new URLSearchParams({
    function: 'TIME_SERIES_DAILY',
    symbol: symbol,
    outputsize: fullHistory ? 'full' : 'compact',
    apikey: apiKey,
  });
  const data = await fetchJson(ALPHA_VANTAGE_BASE + '?' + search.toString(), 'alphaVantage');

  const seriesKey = Object.keys(data).find(function (key) { return key.startsWith('Time Series'); });
  if (!seriesKey) throw new Error('Alpha Vantage returned no daily series');
  return data[seriesKey];
}
