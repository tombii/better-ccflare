# Combos — Cross-Provider Fallback Chains

## Table of Contents

1. [Overview](#overview)
2. [Core Concepts](#core-concepts)
3. [How Routing Works](#how-routing-works)
4. [Managing Combos](#managing-combos)
5. [Family Activation](#family-activation)
6. [Slot Builder](#slot-builder)
7. [REST API](#rest-api)
8. [Examples](#examples)

## Overview

Combos let you define named, ordered fallback chains of (account, model) pairs. When a combo is active for a model family, incoming requests for that family automatically waterfall through the combo's slots — skipping unavailable accounts and trying the next slot if one fails. This enables cross-provider, cross-model failover without manual intervention.

### When to Use Combos

- **Multi-provider failover**: Try Opus on an Anthropic OAuth account first, then fall back to Opus on an OpenAI-compatible provider
- **Model downgrade chains**: Try Opus first, fall back to Sonnet if unavailable, then Haiku
- **Account redundancy**: Distribute across multiple accounts for the same model to increase availability
- **Mixed provider strategies**: Mix pay-as-you-go API key accounts with OAuth accounts in a single chain

### When Combos Are NOT Active

When no combo is assigned to a model family (or the family toggle is disabled), normal session-based routing applies unchanged. Combos are completely optional — they don't affect default load balancing behavior.

## Core Concepts

### Combo

A named, ordered list of slots. Each combo has a name, optional description, and an enabled/disabled toggle.

### Slot

A single entry in a combo, containing:
- **Account**: Which account to use (selected from your configured accounts)
- **Model**: Which model to send to that account (can differ from the originally requested model)
- **Priority**: Order position in the waterfall (slot 0 = try first)

### Family

Model families group Claude models: **Opus**, **Sonnet**, and **Haiku**. Each family can have at most one active combo assigned to it. Family detection uses the existing model name matching logic (e.g., `claude-opus-4-*` → Opus family).

## How Routing Works

```
Incoming request (model: claude-sonnet-4-20250514)
        │
        ▼
┌──────────────────────┐
│ Is Sonnet combo      │
│ active?              │
└──────┬───────────────┘
       │ Yes
       ▼
┌──────────────────────┐
│ Slot 0: Account A    │── unavailable? ──► Slot 1: Account B
│ Model: sonnet        │                      Model: sonnet
└──────────────────────┘                           │
                                              unavailable?
                                                    │
                                                    ▼
                                              Slot 2: Account C
                                              Model: haiku
                                                    │
                                              (or all failed →
                                               SessionStrategy
                                               fallback)
```

### Routing Rules

1. **Family detection**: The request's `model` field is matched to a family (Opus/Sonnet/Haiku)
2. **Combo lookup**: If an active combo exists for that family, combo routing begins
3. **Slot waterfall**: Requests start at slot 0 and proceed through each slot in order
4. **Availability check**: Unavailable accounts (rate-limited, paused) are skipped
5. **Model override**: Each slot's configured model overrides the original requested model
6. **No session stickiness**: Combo routing always starts at slot 0 — no session affinity
7. **Fallback**: If all combo slots fail, normal SessionStrategy routing takes over

### What Counts as Unavailable

An account is skipped during combo routing if:
- It is paused (manually or automatically)
- It is currently rate-limited
- The account no longer exists in the database

## Managing Combos

Combos are managed from the **Combos** page in the web dashboard (sidebar navigation).

### Creating a Combo

1. Navigate to **Combos** in the sidebar
2. Click **Create Combo**
3. Enter a name (required) and optional description
4. Toggle enabled if you want it active immediately
5. Click **Create**

### Editing a Combo

1. Click the **edit** button on a combo card
2. The edit dialog shows the **Slot Builder** where you can:
   - Add slots (select account + enter model name)
   - Drag slots to reorder
   - Remove slots
3. Changes are saved immediately

### Deleting a Combo

1. Click the **delete** button on a combo card
2. All slots in the combo are automatically deleted (cascade)

### Enabling/Disabling

Use the toggle switch on a combo card to enable or disable it. A disabled combo won't be used for routing even if assigned to a family.

## Family Activation

At the top of the Combos page, three rows let you activate combos per model family:

| Family  | What it does                                         |
| ------- | ---------------------------------------------------- |
| **Opus**   | Routes all Opus-family requests through the assigned combo  |
| **Sonnet** | Routes all Sonnet-family requests through the assigned combo |
| **Haiku**  | Routes all Haiku-family requests through the assigned combo  |

### Steps to Activate

1. **Toggle** the family switch to enabled
2. **Select** a combo from the dropdown (shows all created combos)
3. The combo is now active — requests for that family will use the combo

Each family is independent — activating Opus doesn't affect Sonnet or Haiku.

## Slot Builder

The slot builder appears when editing a combo. It provides:

- **Numbered slots**: Each slot shows its position (1, 2, 3...) indicating waterfall order
- **Account dropdown**: Select from configured accounts, showing provider badges
- **Model input**: Text field for the model name to send to that account
- **Drag-and-drop reorder**: Use the grip handle to reorder slots
- **Remove button**: Remove individual slots
- **Add slot**: Inline form at the bottom to add new slots

### Slot Model Override

Each slot's model field overrides the original requested model. This means you can:
- Send `claude-opus-4-20250514` to one provider and `opus-4` to another
- Mix models in a chain (Opus → Sonnet → Haiku)
- Use provider-specific model names (e.g., OpenRouter model IDs)

## REST API

All combo and family management endpoints are available via the REST API.

### Combos

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `GET` | `/api/combos` | List all combos with slot counts |
| `POST` | `/api/combos` | Create a new combo |
| `GET` | `/api/combos/:id` | Get combo detail with all slots |
| `PUT` | `/api/combos/:id` | Update combo (name, description, enabled) |
| `DELETE` | `/api/combos/:id` | Delete combo (cascades slots) |

### Slots

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `POST` | `/api/combos/:id/slots` | Add a slot to a combo |
| `PUT` | `/api/combos/:id/slots/:slotId` | Update a slot (model, enabled) |
| `DELETE` | `/api/combos/:id/slots/:slotId` | Remove a slot |
| `PUT` | `/api/combos/:id/slots/reorder` | Reorder slots (body: `{ slotIds: [...] }`) |

### Families

| Method | Endpoint | Description |
| ------ | -------- | ----------- |
| `GET` | `/api/families` | Get all family → combo assignments |
| `PUT` | `/api/families/:family` | Assign or unassign a combo to a family |

### Example: Create and Activate a Combo

```bash
# Create a combo
curl -X POST http://localhost:8080/api/combos \
  -H "Content-Type: application/json" \
  -d '{"name": "My Fallback Chain", "description": "Opus with Sonnet fallback"}'

# Add slots (replace COMBO_ID with the returned ID)
curl -X POST http://localhost:8080/api/combos/COMBO_ID/slots \
  -H "Content-Type: application/json" \
  -d '{"account_id": "ACCOUNT_1_ID", "model": "claude-opus-4-20250514"}'

curl -X POST http://localhost:8080/api/combos/COMBO_ID/slots \
  -H "Content-Type: application/json" \
  -d '{"account_id": "ACCOUNT_2_ID", "model": "claude-sonnet-4-20250514"}'

# Activate for Opus family
curl -X PUT http://localhost:8080/api/families/opus \
  -H "Content-Type: application/json" \
  -d '{"combo_id": "COMBO_ID", "enabled": true}'

# Verify
curl http://localhost:8080/api/families
```

## Examples

### Example 1: Cross-Provider Opus Failover

Try Opus on your Anthropic OAuth account first, fall back to OpenRouter:

| Slot | Account | Model | Provider |
| ---- | ------- | ----- | -------- |
| 1 | my-oauth-account | claude-opus-4-20250514 | Anthropic OAuth |
| 2 | openrouter-key | anthropic/claude-opus-4-20250514 | OpenRouter |

Assign to the **Opus** family and activate.

### Example 2: Model Downgrade Chain

Try Opus, then Sonnet, then Haiku on the same account:

| Slot | Account | Model |
| ---- | ------- | ----- |
| 1 | my-account | claude-opus-4-20250514 |
| 2 | my-account | claude-sonnet-4-20250514 |
| 3 | my-account | claude-haiku-4-20250514 |

Assign to the **Opus** family — if Opus hits rate limits, Sonnet is tried, then Haiku.

### Example 3: High-Availability Sonnet

Spread across three providers for maximum uptime:

| Slot | Account | Model |
| ---- | ------- | ----- |
| 1 | oauth-primary | claude-sonnet-4-20250514 |
| 2 | api-key-backup | claude-sonnet-4-20250514 |
| 3 | bedrock-account | us.anthropic.claude-sonnet-4-20250514-v1:0 |

Assign to the **Sonnet** family — if the primary OAuth account is rate-limited, the API key account takes over, then Bedrock.

## Limitations

- **Waterfall only**: Combos always try slot 0 first. There's no round-robin, weighted, or random distribution.
- **One combo per family**: Each family can have at most one active combo.
- **No per-combo timeout**: Existing proxy timeouts apply to each slot individually.
- **No combo analytics**: Request tracking uses existing analytics — there's no combo-specific breakdown.
- **Model text input**: Slot model names are entered as text — there's no provider model dropdown.
