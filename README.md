# Dashboard

A static market dashboard served by a Cloudflare Worker. Scheduled Worker jobs collect Finnhub and Alpha Vantage data into D1; browser requests read aggregate snapshots from D1 and never call either provider synchronously.

## Required production bindings

The Worker requires:

- `DB` — a D1 database containing current snapshots, refresh locks, provider backoff state, provider status, and normalized historical closing prices.
- `FINNHUB_API_KEY` — an encrypted secret used by scheduled quote, profile, metric, and news refreshes.
- `ALPHA_VANTAGE_API_KEY` — an encrypted secret used by the scheduled historical-price refresh.

Create the D1 database, copy its ID into `wrangler.toml`, apply the migrations, set the secrets, and deploy:

```sh
npx wrangler d1 create dashboard-market-data
# Replace REPLACE_WITH_D1_DATABASE_ID in wrangler.toml with the returned database ID.
npx wrangler d1 migrations apply dashboard-market-data --remote
npx wrangler secret put FINNHUB_API_KEY
npx wrangler secret put ALPHA_VANTAGE_API_KEY
npx wrangler deploy
```

For local development, apply the migration without `--remote`:

```sh
npx wrangler d1 migrations apply dashboard-market-data --local
npx wrangler dev --test-scheduled
```

The configured Cron Triggers refresh data at different cadences:

- Quotes: every 5 minutes.
- Company news: twice an hour.
- Company metrics: hourly.
- Company profiles: daily.
- Historical daily closes: daily.

Refresh jobs use explicit per-job concurrency limits, in-isolate single-flight coalescing, and D1 leases for both the job and provider account. Provider rate-limit responses use bounded, provider-specific exponential retries, with the next allowed request time persisted in D1 so later scheduled executions honor the same backoff. Failed refreshes retain the last valid values while recording the failed provider check separately.

## Read endpoints

- `GET /api/dashboard` returns all indicator quotes and stock-card quote, profile, metric, and news data.
- `GET /api/historical?symbols=AAPL,SPY&days=365&resolution=D` returns the requested stored graph series for a lookback of up to 10 years. `resolution` is `D` for stored daily closes or `W` for server-resampled weekly closes. The endpoint also accepts a JSON-encoded `requests` array so disjoint symbol sets can request different ranges and resolutions in one aggregate read. Its `s` field is `ok`, `stale`, or `no_data`, while `errors` reports failures independently for each requested symbol.
- `GET /api/health` reports whether the D1 and provider bindings are configured without exposing credentials.

Aggregate responses include `updatedAt`, `stale`, and `providerStatus`. Historical records use a canonical key containing the symbol, provider function, provider output size, and normalization version, so distinct historical representations cannot collide. The API reads storage only; stale reads do not trigger provider requests.
