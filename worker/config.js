export const STOCKS = [
  'AAPL', 'NVDA', 'MSFT', 'JPM', 'AMZN', 'WMT', 'XOM', 'CAT', 'FDX', 'JNJ',
  'GOOGL', 'META', 'TSLA', 'HD', 'PG', 'V', 'UNH', 'NEE', 'SPCX',
];

export const INDICATORS = ['SPY', 'DIA', 'QQQ', 'IWM', 'VIXY'];
export const ALL_SYMBOLS = [...STOCKS, ...INDICATORS];

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
