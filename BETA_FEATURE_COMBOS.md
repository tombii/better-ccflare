# Beta Feature: Combos

## Overview

Combos are opt-in. The switch lives in the dashboard, on the Combos tab, and it
decides two things at once: whether the tab is shown, and whether combos take
part in routing.

That pairing is the point. The switch used to be `BETTER_CCFLARE_SHOW_COMBOS`
and it only hid the tab — the proxy went on routing through whatever combos the
database held. A combo could therefore steer every request for a model family
while being invisible and uneditable in the UI.

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

`source` reports where the value in force comes from — `env`, `file` or
`default`. `effective` is the value after the write, which differs from the
requested one exactly when an environment variable overrides it.

### From the environment

`BETTER_CCFLARE_SHOW_COMBOS` is legacy. It is read once, at boot, when the
config field is absent — so an install that was using it keeps behaving the
same — and is never consulted again.

It does not override the switch, deliberately. A control the environment can
veto has to be drawn disabled with an explanation, or it accepts a click and
silently does nothing; the switch owns the setting instead.

## Upgrading

An install that already has combos configured adopts enabled on first boot,
with a line in the startup log — as does one that had `BETTER_CCFLARE_SHOW_COMBOS`
set. Upgrading therefore keeps serving exactly the routing it was serving
before; the opt-in default only applies to installs with neither.

## Implementation Details

- **Config**: `combos_enabled` in the config file, read from the file only
  (`Config#getCombosEnabled`)
- **Routing**: read by the account selector — this is what makes the switch
  real rather than cosmetic
- **Backend**: `GET`/`POST /api/config/combos-enabled`; `/api/features` reports
  `showCombos` from the same setting, so the tab and routing can no longer
  disagree
- **Adoption**: `Config#adoptLegacyRoutingSettings` at server start; writes the
  field once, so a later deliberate off is never undone
- The combos API endpoints (`/api/combos`, `/api/families`, …) remain reachable
  regardless of the switch, for programmatic access
