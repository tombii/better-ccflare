# Model Mappings in better-ccflare

## Overview

better-ccflare includes centralized model definitions and mappings for Claude AI models. These mappings are defined in `packages/core/src/models.ts` and are used throughout the system for consistent model identification and display.

## Model Constants

### CLAUDE_MODEL_IDS

Full model IDs as used by the Anthropic API:

```typescript
export const CLAUDE_MODEL_IDS = {
    // Claude 3.5 models
    HAIKU_3_5: "claude-3-5-haiku-20241022",
    SONNET_3_5: "claude-3-5-sonnet-20241022",

    // Claude 4 models
    SONNET_4: "claude-sonnet-4-20250514",
    OPUS_4: "claude-opus-4-20250514",
    OPUS_4_1: "claude-opus-4-1-20250805",

    // Legacy Claude 3 models (for documentation/API examples)
    OPUS_3: "claude-3-opus-20240229",
    SONNET_3: "claude-3-sonnet-20240229",
} as const;
```

### MODEL_DISPLAY_NAMES

Human-readable display names for models:

```typescript
export const MODEL_DISPLAY_NAMES: Record<string, string> = {
    [CLAUDE_MODEL_IDS.HAIKU_3_5]: "Claude Haiku 3.5",
    [CLAUDE_MODEL_IDS.SONNET_3_5]: "Claude Sonnet 3.5 v2",
    [CLAUDE_MODEL_IDS.SONNET_4]: "Claude Sonnet 4",
    [CLAUDE_MODEL_IDS.OPUS_4]: "Claude Opus 4",
    [CLAUDE_MODEL_IDS.OPUS_4_1]: "Claude Opus 4.1",
    [CLAUDE_MODEL_IDS.OPUS_3]: "Claude Opus 3",
    [CLAUDE_MODEL_IDS.SONNET_3]: "Claude Sonnet 3",
};
```

### MODEL_SHORT_NAMES

Short names used in UI components (for color mapping, etc.):

```typescript
export const MODEL_SHORT_NAMES: Record<string, string> = {
    [CLAUDE_MODEL_IDS.HAIKU_3_5]: "claude-3.5-haiku",
    [CLAUDE_MODEL_IDS.SONNET_3_5]: "claude-3.5-sonnet",
    [CLAUDE_MODEL_IDS.SONNET_4]: "claude-sonnet-4",
    [CLAUDE_MODEL_IDS.OPUS_4]: "claude-opus-4",
    [CLAUDE_MODEL_IDS.OPUS_4_1]: "claude-opus-4.1",
    [CLAUDE_MODEL_IDS.OPUS_3]: "claude-3-opus",
    [CLAUDE_MODEL_IDS.SONNET_3]: "claude-3-sonnet",
};
```

## Default Models

```typescript
// Default model for general use
export const DEFAULT_MODEL = CLAUDE_MODEL_IDS.SONNET_4;

// Default model for agents
export const DEFAULT_AGENT_MODEL = CLAUDE_MODEL_IDS.SONNET_4;
```

## Helper Functions

### getModelShortName(modelId: string): string

Returns the short name for a given model ID, or the model ID itself if no mapping exists.

```typescript
export function getModelShortName(modelId: string): string {
    return MODEL_SHORT_NAMES[modelId] || modelId;
}
```

### getModelDisplayName(modelId: string): string

Returns the display name for a given model ID, or the model ID itself if no mapping exists.

```typescript
export function getModelDisplayName(modelId: string): string {
    return MODEL_DISPLAY_NAMES[modelId] || modelId;
}
```

### isValidModelId(modelId: string): modelId is ClaudeModelId

Validates if a string is a recognized Claude model ID.

```typescript
export function isValidModelId(modelId: string): modelId is ClaudeModelId {
    return Object.values(CLAUDE_MODEL_IDS).includes(modelId as ClaudeModelId);
}
```

## Type Definitions

```typescript
// Type for all valid model IDs
export type ClaudeModelId = (typeof CLAUDE_MODEL_IDS)[keyof typeof CLAUDE_MODEL_IDS];
```

## Usage Examples

### Getting a Model's Display Name

```typescript
import { getModelDisplayName, CLAUDE_MODEL_IDS } from "@better-ccflare/core";

const modelId = CLAUDE_MODEL_IDS.SONNET_4;
const displayName = getModelDisplayName(modelId);
// Returns: "Claude Sonnet 4"
```

### Validating a Model ID

```typescript
import { isValidModelId } from "@better-ccflare/core";

if (isValidModelId("claude-3-5-sonnet-20241022")) {
    // This is a valid model ID
}
```

### Using the Model Type

```typescript
import type { ClaudeModelId } from "@better-ccflare/core";

function processModel(modelId: ClaudeModelId) {
    // TypeScript knows this is a valid model ID
    console.log(getModelDisplayName(modelId));
}
```

## Model Version Information

The model mappings include both current and legacy model versions:

- **Claude 4 Models** (Latest):
  - `claude-sonnet-4-20250514`
  - `claude-opus-4-20250514`
  - `claude-opus-4-1-20250805`

- **Claude 3.5 Models**:
  - `claude-3-5-haiku-20241022`
  - `claude-3-5-sonnet-20241022`

- **Legacy Claude 3 Models**:
  - `claude-3-opus-20240229`
  - `claude-3-sonnet-20240229`

## Agent Model Preferences

better-ccflare supports agent-specific model preferences through the agent system. When an agent is detected in a request, the system can automatically override the model selection based on the agent's configured preference.

See [Agent Documentation](./providers.md#agent-system) for more details on how agents work with model preferences.