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
