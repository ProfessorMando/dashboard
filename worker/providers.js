const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query';

function delay(milliseconds) {
  return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

let finnhubNextRequest = 0;
let alphaVantageNextRequest = 0;

async function rateLimitedFetch(url, provider) {
  const minimumDelay = provider === 'finnhub' ? 1100 : 12000;
  const nextRequest = provider === 'finnhub' ? finnhubNextRequest : alphaVantageNextRequest;
  const scheduledAt = Math.max(Date.now(), nextRequest);

  if (provider === 'finnhub') finnhubNextRequest = scheduledAt + minimumDelay;
  else alphaVantageNextRequest = scheduledAt + minimumDelay;

  if (scheduledAt > Date.now()) await delay(scheduledAt - Date.now());

  const response = await fetch(url);
  if (!response.ok) throw new Error(provider + ' returned HTTP ' + response.status);
  return response;
}

function providerError(raw) {
  return raw.error || raw['Error Message'] || raw.Note || raw.Information;
}

export async function fetchFinnhub(endpoint, params, apiKey) {
  if (!apiKey) throw new Error('FINNHUB_API_KEY is not configured');
  const search = new URLSearchParams(params);
  search.set('token', apiKey);
  const response = await rateLimitedFetch(FINNHUB_BASE + endpoint + '?' + search.toString(), 'finnhub');
  const data = await response.json();
  if (providerError(data)) throw new Error('Finnhub rejected the request');
  return data;
}

export async function fetchAlphaVantageDaily(symbol, apiKey, fullHistory) {
  if (!apiKey) throw new Error('ALPHA_VANTAGE_API_KEY is not configured');
  const search = new URLSearchParams({
    function: 'TIME_SERIES_DAILY',
    symbol: symbol,
    outputsize: fullHistory ? 'full' : 'compact',
    apikey: apiKey,
  });
  const response = await rateLimitedFetch(ALPHA_VANTAGE_BASE + '?' + search.toString(), 'alphaVantage');
  const data = await response.json();
  if (providerError(data)) throw new Error('Alpha Vantage rejected the request');

  const seriesKey = Object.keys(data).find(function (key) { return key.startsWith('Time Series'); });
  if (!seriesKey) throw new Error('Alpha Vantage returned no daily series');
  return data[seriesKey];
}
