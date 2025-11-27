# Anthropic API Changelog

This document tracks changes to the Anthropic API responses that affect better-ccflare.

## Usage API Endpoint

**Endpoint**: `GET https://api.anthropic.com/api/oauth/usage`

**Headers Required**:
```bash
Authorization: Bearer {access_token}
anthropic-beta: oauth-2025-04-20
Accept: application/json
```

### Version History

#### 2025-11-25 (Current)

**Last Verified**: 2025-11-25

**Response Structure**:
```json
{
  "five_hour": {
    "utilization": 19.0,
    "resets_at": "2025-11-25T22:00:00.288792+00:00"
  },
  "seven_day": {
    "utilization": 7.0,
    "resets_at": "2025-12-01T21:00:00.288804+00:00"
  },
  "seven_day_oauth_apps": {
    "utilization": 0.0,
    "resets_at": null
  },
  "seven_day_opus": null,
  "seven_day_sonnet": null,
  "iguana_necktie": null,
  "extra_usage": {
    "is_enabled": false,
    "monthly_limit": null,
    "used_credits": null,
    "utilization": null
  }
}
```

**Changes from Previous Version**:
- ✨ **NEW**: `seven_day_sonnet` field - Tracks Sonnet-specific weekly usage limits
- ✨ **NEW**: `iguana_necktie` field - Purpose unknown, possibly internal Anthropic field
- ✨ **NEW**: `extra_usage` object - Tracks additional/purchased usage credits
  - `is_enabled`: Whether extra usage credits are enabled for this account
  - `monthly_limit`: Monthly credit limit (if applicable)
  - `used_credits`: Credits used in current period
  - `utilization`: Percentage of extra credits used (0-100)

**Notes**:
- All fields can be `null` when not applicable to the account tier
- `utilization` values are percentages from 0-100
- `resets_at` timestamps are in ISO 8601 format with timezone
- Fields may be absent, `null`, or contain data depending on account configuration

#### Pre-2025-11 (Legacy)

**Response Structure**:
```json
{
  "five_hour": {
    "utilization": 0.0,
    "resets_at": "2025-11-25T20:00:00.000000+00:00"
  },
  "seven_day": {
    "utilization": 0.0,
    "resets_at": "2025-12-01T19:00:00.000000+00:00"
  },
  "seven_day_oauth_apps": {
    "utilization": 0.0,
    "resets_at": null
  },
  "seven_day_opus": {
    "utilization": 0.0,
    "resets_at": "2025-12-01T19:00:00.000000+00:00"
  }
}
```

**Fields**:
- `five_hour`: 5-hour rolling window usage limit
- `seven_day`: 7-day rolling window usage limit
- `seven_day_oauth_apps`: OAuth app-specific 7-day limit
- `seven_day_opus`: Opus model-specific 7-day limit

---

## Implementation Notes

### How better-ccflare Handles API Changes

The usage fetcher in `packages/providers/src/usage-fetcher.ts` is designed to be resilient to API changes:

1. **Dynamic Field Iteration**: Instead of hardcoding field names, we iterate through all properties to find `UsageWindow` objects
2. **Optional Fields**: All fields except `five_hour` and `seven_day` are optional in the TypeScript interface
3. **Index Signature**: The interface includes `[key: string]` to allow unknown fields
4. **Null-Safe**: All code checks for `null` and `undefined` before accessing nested properties

### Testing API Changes

To test the current API response:

```bash
# Get an access token from the database
sqlite3 ~/.config/better-ccflare/better-ccflare.db "SELECT access_token FROM accounts WHERE name = 'claude' LIMIT 1;"

# Test the API endpoint
curl -v -X GET "https://api.anthropic.com/api/oauth/usage" \
  -H "Authorization: Bearer {token}" \
  -H "anthropic-beta: oauth-2025-04-20" \
  -H "Accept: application/json"
```

### When to Update This Document

Update this changelog when:
1. New fields appear in the API response
2. Existing fields are removed or deprecated
3. Field types or validation rules change
4. API headers or authentication methods change
5. Rate limit behavior changes

---

## Related Files

- `packages/providers/src/usage-fetcher.ts` - Main usage fetching and parsing logic
- `packages/dashboard-web/src/components/accounts/RateLimitProgress.tsx` - Dashboard UI for displaying usage data
- `packages/types/src/account.ts` - TypeScript type definitions

---

## References

- [Anthropic API Documentation](https://docs.anthropic.com/)
- [OAuth 2.0 Specification](https://oauth.net/2/)
