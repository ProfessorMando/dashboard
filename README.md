# Dashboard

A static market dashboard served by a Cloudflare Worker. The Worker also proxies the market-data APIs so credentials remain in Cloudflare bindings rather than browser code.

## Required production bindings

The production Worker that serves the dashboard domain must have both of these encrypted secrets:

- `FINNHUB_API_KEY` — required for Finnhub quote, profile, metric, and news requests.
- `ALPHA_VANTAGE_API_KEY` — required for Alpha Vantage historical candle data.

Set the secrets against the exact Worker and environment used by the production dashboard, then deploy that same environment. For the Worker named in `wrangler.toml`, with no named Wrangler environment, use:

```sh
npx wrangler secret put FINNHUB_API_KEY
npx wrangler secret put ALPHA_VANTAGE_API_KEY
npx wrangler secret list
npx wrangler deploy
```

If production uses a named environment, add the same `--env <environment>` option to every command above. Before deployment, confirm in Cloudflare that the dashboard domain's Worker route or custom domain targets that exact Worker/environment; secrets attached only to a preview deployment or another Worker are not available to production traffic.

After deployment, request `https://<dashboard-domain>/api/health`. A correctly configured production response is:

```json
{
  "finnhubConfigured": true,
  "alphaVantageConfigured": true
}
```

The health endpoint reports only whether each binding is available. It never returns either credential.
