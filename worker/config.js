const PUBLIC_EQUITY_SUPPORT = Object.freeze({
  quote: true,
  profile: true,
  metrics: true,
  news: true,
  historical: true,
});

const MARKET_INDICATOR_SUPPORT = Object.freeze({
  quote: true,
  profile: false,
  metrics: false,
  news: false,
  historical: true,
});

function publicEquity(symbol, name) {
  return Object.freeze({
    symbol: symbol,
    name: name,
    type: 'equity',
    providerSymbols: Object.freeze({ finnhub: symbol, alphaVantage: symbol }),
    support: PUBLIC_EQUITY_SUPPORT,
  });
}

function marketIndicator(symbol, name) {
  return Object.freeze({
    symbol: symbol,
    name: name,
    type: 'etf',
    providerSymbols: Object.freeze({ finnhub: symbol, alphaVantage: symbol }),
    support: MARKET_INDICATOR_SUPPORT,
  });
}

export const STOCKS = Object.freeze([
  publicEquity('AAPL', 'Apple'),
  publicEquity('NVDA', 'NVIDIA'),
  publicEquity('MSFT', 'Microsoft'),
  publicEquity('JPM', 'JPMorgan Chase'),
  publicEquity('AMZN', 'Amazon'),
  publicEquity('WMT', 'Walmart'),
  publicEquity('XOM', 'ExxonMobil'),
  publicEquity('CAT', 'Caterpillar'),
  publicEquity('FDX', 'FedEx'),
  publicEquity('JNJ', 'Johnson & Johnson'),
  publicEquity('GOOGL', 'Alphabet'),
  publicEquity('META', 'Meta'),
  publicEquity('TSLA', 'Tesla'),
  publicEquity('HD', 'Home Depot'),
  publicEquity('PG', 'Procter & Gamble'),
  publicEquity('V', 'Visa'),
  publicEquity('UNH', 'UnitedHealth'),
  publicEquity('NEE', 'NextEra Energy'),
  Object.freeze({
    symbol: 'SPCX',
    name: 'SpaceX',
    type: 'private_company',
    providerSymbols: Object.freeze({ finnhub: null, alphaVantage: null }),
    support: Object.freeze({
      quote: false,
      profile: false,
      metrics: false,
      news: false,
      historical: false,
    }),
    unavailableReason: 'No supported public-market symbol is available for this private company.',
  }),
]);

export const INDICATORS = Object.freeze([
  marketIndicator('SPY', 'S&P 500'),
  marketIndicator('DIA', 'Dow Jones Industrial Average'),
  marketIndicator('QQQ', 'Nasdaq-100'),
  marketIndicator('IWM', 'Russell 2000'),
  marketIndicator('VIXY', 'CBOE Volatility Index'),
]);

export const INSTRUMENTS = Object.freeze([...STOCKS, ...INDICATORS]);
export const STOCK_SYMBOLS = Object.freeze(STOCKS.map(function (instrument) { return instrument.symbol; }));
export const INDICATOR_SYMBOLS = Object.freeze(INDICATORS.map(function (instrument) { return instrument.symbol; }));
export const ALL_SYMBOLS = Object.freeze(INSTRUMENTS.map(function (instrument) { return instrument.symbol; }));

export function instrumentsSupporting(capability) {
  return INSTRUMENTS.filter(function (instrument) { return instrument.support[capability] === true; });
}

export function stocksSupporting(capability) {
  return STOCKS.filter(function (instrument) { return instrument.support[capability] === true; });
}

export function instrumentBySymbol(symbol) {
  return INSTRUMENTS.find(function (instrument) { return instrument.symbol === symbol; }) || null;
}

export function instrumentSupportSnapshot() {
  return Object.fromEntries(INSTRUMENTS.map(function (instrument) {
    return [instrument.symbol, {
      symbol: instrument.symbol,
      name: instrument.name,
      type: instrument.type,
      available: Object.values(instrument.support).some(Boolean),
      providerSymbols: instrument.providerSymbols,
      support: instrument.support,
      ...(instrument.unavailableReason ? { unavailableReason: instrument.unavailableReason } : {}),
    }];
  }));
}

export const SNAPSHOT_KEYS = {
  quotes: 'quotes',
  profiles: 'profiles',
  metrics: 'metrics',
  news: 'news',
};

export const MAX_AGE_SECONDS = {
  quotes: 10 * 60,
  profiles: 7 * 24 * 60 * 60,
  metrics: 6 * 60 * 60,
  news: 60 * 60,
  historical: 36 * 60 * 60,
};

export const CRON_JOBS = {
  '*/5 * * * *': ['quotes'],
  '7,37 * * * *': ['news'],
  '12 * * * *': ['metrics'],
  '22 3 * * *': ['profiles'],
  '42 3 * * *': ['historical'],
};

export const HISTORICAL_SERIES = {
  provider: 'alphaVantage',
  providerFunction: 'TIME_SERIES_DAILY',
  outputSize: 'full',
  normalizationVersion: 'v1',
};
