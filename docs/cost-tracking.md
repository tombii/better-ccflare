# Cost tracking

Cost tracking is enabled by default. The dashboard Settings page persists the
`cost_tracking_enabled` switch in the same config file as the other settings.
Admins can read `GET /api/config/cost-tracking` and write
`POST` or `PUT /api/config/cost-tracking` with `{"enabled": false}` or
`{"enabled": true}`. API-only keys may read this one status flag for their usage
page; they cannot update it or read other configuration.

The CLI flag `--cost-tracking on|off` persists the same setting and asks local
servers on the configured port, 8080 and 8081 to reload it using the existing
local-control authentication mechanism. If no server responds, it reports that
the saved value takes effect at the next start. Neither surface requires a restart
when it reaches the running server.

When disabled, new request rows keep token counts and outcomes but record
`cost_usd = NULL`. Cost estimates and budget reservations are skipped, and spend
limits do not block or warn on stale historical totals. Dashboard cost figures
are hidden and limit controls explain that enforcement is suspended. Existing
request costs and configured budgets remain stored.

Enabling tracking resumes for new requests from that point. The gap is never
backfilled. Requests that span an off/on gap also retain NULL cost, including
pricing that was already in flight when tracking was disabled. Spend limits
resume against the tracked costs still inside their configured windows.

## Model prices

The price catalogue better-ccflare prices requests with is readable at
`GET /api/model-prices` (admin only, like `/api/models`):

```json
{
  "currency": "USD",
  "unit": "per_million_tokens",
  "models": [
    {
      "id": "claude-sonnet-4-5",
      "name": "Claude Sonnet 4.5",
      "provider": "anthropic",
      "family": "sonnet",
      "rates": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
    }
  ]
}
```

`rates` is `null` for a model whose price is not known. The dashboard's Model
Prices tab renders the same data. Prices refresh on the
`CF_PRICING_REFRESH_HOURS` schedule (see [configuration.md](configuration.md#additional-environment-variables)).

## Plan value and per-key apportionment

Each request is priced at public pay-per-token rates and then split by the
account's `billing_type`. For plan accounts that figure is a counterfactual —
what the traffic would have cost at API rates — and is labelled **Plan Value**
in the dashboard, not an invoice.

Recording an account's real subscription price
(`POST /api/accounts/:id/plan-price`, see [api-http.md](api-http.md#post-apiaccountsaccountidplan-price))
lets the per-API-key usage page apportion that price across keys. The key's
share of an account's plan value is the ratio of the key's plan value on that
account to the account's total, and its contribution is that share times the
monthly price prorated over the selected window. Accounts with no recorded
price are listed as unpriced rather than counted at zero.
