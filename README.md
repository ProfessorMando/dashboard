# Dashboard

A static market dashboard served by a Cloudflare Worker. Scheduled Worker jobs collect Finnhub and Alpha Vantage data into D1; browser requests read aggregate snapshots from D1 and never call either provider synchronously.

## Required production bindings

The Worker requires:

- `DB` — a D1 database containing current snapshots, refresh locks, provider backoff state, provider status, and normalized historical closing prices.
- `FINNHUB_API_KEY` — an encrypted secret used by scheduled quote, profile, metric, and news refreshes.
- `ALPHA_VANTAGE_API_KEY` — an encrypted secret used by the scheduled historical-price refresh.

The checked-in `wrangler.toml` uses Wrangler automatic provisioning for the `DB` binding so Cloudflare Builds can perform the first deployment without an account-specific database UUID in the repository. After that first deployment, find the provisioned D1 database name in the Worker bindings, apply the migrations to it, set the secrets, and deploy again:

```sh
npx wrangler deploy
npx wrangler d1 migrations apply <provisioned-database-name> --remote
npx wrangler secret put FINNHUB_API_KEY
npx wrangler secret put ALPHA_VANTAGE_API_KEY
npx wrangler deploy
```

To bind an existing D1 database instead, replace the automatic binding in `wrangler.toml` with the `database_name` and `database_id` reported by `npx wrangler d1 list`. Never commit a placeholder database ID: Wrangler validates the field as a real D1 UUID during deployment.

For local development, apply the migration without `--remote`:

```sh
npx wrangler d1 migrations apply DB --local
npx wrangler dev --test-scheduled
```

On every scheduled invocation, the Worker also initializes any dataset that has no D1 records yet. This makes a newly provisioned database populate promptly; once records exist, the normal cadences below apply and the bootstrap pass does not repeat that dataset.

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

Aggregate responses include `updatedAt`, `stale`, `providerStatus`, and an `instruments` registry. Each instrument entry records its provider-specific symbols and support flags for quotes, profiles, metrics, news, and historical data. Scheduled jobs skip unsupported capabilities, and historical reads return an intentional `unsupported_instrument` error without querying stored price rows. Historical records use a canonical key containing the symbol, provider function, provider output size, and normalization version, so distinct historical representations cannot collide. The API reads storage only; stale reads do not trigger provider requests.
