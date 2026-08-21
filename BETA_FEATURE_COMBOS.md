# Beta Feature: Combos

## Overview

Combo routing is opt-in. The Combos tab is always visible, and the switch in
its header decides whether saved combos take part in routing. Keeping the
interface permanent means an operator who turns routing off can always return
to the same control to turn it back on.

## Usage

### From the dashboard

Combos tab → the switch in the header card. Off by default; turning it off
leaves your combos saved but inert, and every request goes back to normal pool
routing.

### From the API

```bash
curl http://localhost:8080/api/config/combos-enabled
# { "enabled": false, "source": "default" }

curl -X POST http://localhost:8080/api/config/combos-enabled \
  -H 'content-type: application/json' -d '{"enabled":true}'
# { "success": true, "enabled": true, "source": "file", "effective": true }
```

`source` reports whether the value comes from the config `file` or the built-in
`default`. `effective` is the value confirmed by the server after the write.

## Upgrading

An install that already has combos configured adopts enabled on first boot,
with a line in the startup log. It also adopts the historically permissive
fallthrough into the normal account pool unless the config field or the legacy
disable-fallback variable already records a choice. New installs keep both the
opt-in routing default and the safer blocked-fallback default.

## Implementation Details

- **Config**: `combos_enabled` in the config file, read from the file only
  (`Config#getCombosEnabled`)
- **Routing**: read by the account selector — this is what makes the switch
  real rather than cosmetic
- **Backend**: `GET`/`POST /api/config/combos-enabled` controls routing only
- **Dashboard**: the Combos route and navigation item are permanent
- **Adoption**: `Config#adoptLegacyRoutingSettings` at server start; writes the
  field once, so a later deliberate off is never undone
- The combos API endpoints (`/api/combos`, `/api/families`, …) remain reachable
  regardless of the switch, for programmatic access
