const FINNHUB_BASE = 'https://finnhub.io/api/v1';
const ALPHA_VANTAGE_BASE = 'https://www.alphavantage.co/query';
const ALPHA_VANTAGE_TIME_SERIES_KEYS = new Set([
  'Time Series (Daily)',
  'Weekly Time Series',
  'Monthly Time Series',
]);

function retryAfterMilliseconds(response, now) {
  const value = response.headers.get('Retry-After');
  if (!value) return null;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export class ProviderResponseError extends Error {
  constructor(provider, code, downstreamStatus, message, upstreamStatus) {
    super(message);
    this.name = 'ProviderResponseError';
    this.provider = provider;
    this.code = code;
    this.downstreamStatus = downstreamStatus;
    this.upstreamStatus = upstreamStatus || null;
  }
}

export class ProviderRateLimitError extends ProviderResponseError {
  constructor(provider, retryAfterMs, message) {
    super(provider, 'rate_limited', 503, message || provider + ' rate limit reached', 429);
    this.name = 'ProviderRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

function providerError(raw) {
  return raw && typeof raw === 'object'
    ? raw.error || raw['Error Message'] || raw.Note || raw.Information
    : null;
}

function isJsonContentType(response) {
  const contentType = response.headers.get('Content-Type') || '';
  return /^(application\/json|[^;]+\+json)(?:\s*;|$)/i.test(contentType.trim());
}

function responseError(provider, response) {
  if (response.status === 401 || response.status === 403) {
    return new ProviderResponseError(
      provider,
      'authentication_failed',
      502,
      provider + ' authentication failed',
      response.status
    );
  }
  if (response.status >= 500) {
    return new ProviderResponseError(
      provider,
      'upstream_unavailable',
      503,
      provider + ' is temporarily unavailable',
      response.status
    );
  }
  return new ProviderResponseError(
    provider,
    'upstream_http_error',
    502,
    provider + ' returned HTTP ' + response.status,
    response.status
  );
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
  if (!response.ok) throw responseError(provider, response);
  if (!isJsonContentType(response)) {
    throw new ProviderResponseError(
      provider,
      'invalid_content_type',
      502,
      provider + ' returned a non-JSON response',
      response.status
    );
  }

  let data;
  try {
    data = JSON.parse(await response.text());
  } catch (error) {
    throw new ProviderResponseError(
      provider,
      'malformed_json',
      502,
      provider + ' returned malformed JSON',
      response.status
    );
  }

  const message = providerError(data);
  if (message) {
    if (provider === 'alphaVantage' && (data.Note || data.Information)) {
      throw new ProviderRateLimitError(provider, null, 'Alpha Vantage rate limit reached');
    }
    throw new ProviderResponseError(
      provider,
      'request_rejected',
      502,
      provider + ' rejected the request',
      response.status
    );
  }
  return data;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return value !== '' && value !== null && Number.isFinite(Number(value));
}

function isTradingDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function validAlphaVantageSeries(data) {
  if (!isObject(data)) return null;

  for (const key of ALPHA_VANTAGE_TIME_SERIES_KEYS) {
    const series = data[key];
    if (!isObject(series)) continue;

    const validEntries = Object.entries(series).filter(function (entry) {
      return isTradingDate(entry[0])
        && isObject(entry[1])
        && isFiniteNumber(entry[1]['4. close']);
    });
    if (validEntries.length) return Object.fromEntries(validEntries);
  }
  return null;
}

const FINNHUB_PAYLOAD_VALIDATORS = {
  '/quote': function (data) {
    return isObject(data) && isFiniteNumber(data.c) && isFiniteNumber(data.t);
  },
  '/stock/profile2': function (data) {
    return isObject(data) && typeof data.ticker === 'string' && data.ticker.length > 0;
  },
  '/stock/metric': function (data) {
    return isObject(data) && isObject(data.metric) && Object.keys(data.metric).length > 0;
  },
  '/company-news': function (data) {
    return Array.isArray(data) && data.every(function (item) {
      return isObject(item)
        && Number.isFinite(Number(item.datetime))
        && typeof item.headline === 'string';
    });
  },
};

function isCredentialParameter(name) {
  return /(token|key|secret|password|passphrase|authorization|credential|signature)/i.test(name);
}

function validateFinnhubPayload(endpoint, data) {
  const validator = FINNHUB_PAYLOAD_VALIDATORS[endpoint];
  if (!validator || !validator(data)) {
    throw new ProviderResponseError(
      'finnhub',
      'invalid_payload',
      502,
      'finnhub returned an invalid payload for ' + endpoint,
      200
    );
  }
}

export async function fetchFinnhub(endpoint, params, apiKey) {
  if (!apiKey) {
    throw new ProviderResponseError(
      'finnhub',
      'not_configured',
      500,
      'FINNHUB_API_KEY is not configured'
    );
  }

  const search = new URLSearchParams();
  Object.entries(params).sort(function (left, right) {
    return left[0].localeCompare(right[0]) || String(left[1]).localeCompare(String(right[1]));
  }).forEach(function (entry) {
    if (!isCredentialParameter(entry[0])) {
      search.append(entry[0], entry[1]);
    }
  });
  search.set('token', apiKey);

  const data = await fetchJson(FINNHUB_BASE + endpoint + '?' + search.toString(), 'finnhub');
  validateFinnhubPayload(endpoint, data);
  return data;
}

export async function fetchAlphaVantageDaily(symbol, apiKey, fullHistory) {
  if (!apiKey) {
    throw new ProviderResponseError(
      'alphaVantage',
      'not_configured',
      500,
      'ALPHA_VANTAGE_API_KEY is not configured'
    );
  }
  const search = new URLSearchParams({
    function: 'TIME_SERIES_DAILY',
    symbol: symbol,
    outputsize: fullHistory ? 'full' : 'compact',
    apikey: apiKey,
  });
  const data = await fetchJson(ALPHA_VANTAGE_BASE + '?' + search.toString(), 'alphaVantage');

  const series = validAlphaVantageSeries(data);
  if (!series) {
    throw new ProviderResponseError(
      'alphaVantage',
      'invalid_payload',
      502,
      'Alpha Vantage returned no valid time series',
      200
    );
  }
  return series;
}
