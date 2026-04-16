# Beta Feature: Combos UI Toggle

## Overview

The combos feature can now be conditionally shown in the web UI using an environment variable. This allows beta testing of the combos functionality without exposing it to all users.

## Usage

### Enable Combos UI

Set the environment variable:

```bash
export BETTER_CCFLARE_SHOW_COMBOS=true
```

Or add it to your `.env` file:

```env
BETTER_CCFLARE_SHOW_COMBOS=true
```

### Disable Combos UI (Default)

By default, combos are hidden. To explicitly disable:

```bash
export BETTER_CCFLARE_SHOW_COMBOS=false
```

Or omit the variable entirely.

## What Happens

When `BETTER_CCFLARE_SHOW_COMBOS=true`:

- The "Combos" navigation item appears in the sidebar between "Accounts" and "Agents"
- The `/combos` route becomes accessible
- All combos management features are available in the UI

When `BETTER_CCFLARE_SHOW_COMBOS=false` or unset:

- The "Combos" navigation item is hidden
- The `/combos` route is not accessible
- The combos backend API endpoints remain functional (for programmatic access)

## Implementation Details

- **Backend**: `/api/features` endpoint returns `{ showCombos: boolean }`
- **Frontend**: Fetches features on app load after authentication
- **Dynamic routing**: The combos route is conditionally added based on the flag
- **Navigation**: The combos nav item is conditionally rendered based on the flag

## Notes

- This feature flag only affects UI visibility, not backend functionality
- The combos API endpoints (`/api/combos`, `/api/families`, etc.) remain active regardless of this flag
- Changes to this env var require restarting the server to take effect