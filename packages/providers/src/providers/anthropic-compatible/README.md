# Anthropic-Compatible Provider

A flexible, configurable provider that can interface with any Anthropic-compatible API endpoint. This provider supports custom endpoints, model mappings, and API key authentication.

## Features

- **Custom Endpoints**: Configure any base URL for your Anthropic-compatible service
- **Model Mapping**: Map Anthropic model names to your provider's model names
- **API Key Authentication**: Support for custom API key headers
- **Configurable Headers**: Custom authorization headers
- **Streaming Support**: Configurable streaming response handling
- **Rate Limit Handling**: Compatible with Anthropic-style rate limiting

## Installation

```typescript
import { AnthropicCompatibleProvider } from "@better-ccflare/providers";
```

## Basic Usage

### 1. Simple Configuration

```typescript
import { AnthropicCompatibleProvider } from "@better-ccflare/providers";

// Create a basic provider with API key authentication
const provider = new AnthropicCompatibleProvider({
  name: "my-anthropic-service",
  baseUrl: "https://api.myservice.com/v1",
  authType: "api_key",
  authHeader: "x-api-key",
});
```

### 2. Authorization Header

```typescript
const provider = new AnthropicCompatibleProvider({
  name: "my-service",
  baseUrl: "https://api.myservice.com",
  authHeader: "authorization",
});
```

### 3. Model Mapping

```typescript
const provider = new AnthropicCompatibleProvider({
  name: "mapped-service",
  baseUrl: "https://api.custom-service.com",
  authType: "api_key",
  modelMappings: {
    "claude-3-opus": "custom-opus-v1",
    "claude-3-sonnet": "custom-sonnet-v2",
    "claude-3-haiku": "custom-haiku-v1",
    "claude-2.1": "custom-claude-v3",
    "claude-2": "custom-claude-v2",
    "claude-instant": "custom-instant-v1",
  },
});
```

### 4. Advanced Configuration

```typescript
const provider = new AnthropicCompatibleProvider({
  name: "advanced-provider",
  baseUrl: "https://advanced-api.service.com",
  authType: "oauth",
  authHeader: "x-oauth-token",
  supportsStreaming: true,
  defaultModel: "claude-3-sonnet",
  modelMappings: {
    "claude-3-opus": "premium-model",
    "claude-3-sonnet": "standard-model",
    "claude-3-haiku": "fast-model",
  },
});

// You can update configuration dynamically
provider.updateConfig({
  baseUrl: "https://new-endpoint.service.com",
  modelMappings: {
    ...provider.getConfig().modelMappings,
    "claude-3-opus": "new-premium-model",
  },
});
```

## Factory Functions

For common use cases, use the provided factory functions:

### Create Generic Provider

```typescript
import { createAnthropicCompatibleProvider } from "@better-ccflare/providers";

const provider = createAnthropicCompatibleProvider({
  name: "generic-service",
  baseUrl: "https://generic-api.service.com",
  authType: "api_key",
});
```

### Create Provider for Specific Service

```typescript
import { createProviderForService } from "@better-ccflare/providers";

// For services using custom API key headers
const apiKeyProvider = createProviderForService(
  "my-service",
  "https://my-api.service.com",
  "x-api-key"
);

// For services using authorization headers
const authProvider = createProviderForService(
  "auth-service",
  "https://auth-api.service.com",
  "authorization"
);
```

### Preset Providers

For common Anthropic-compatible services:

```typescript
import { PresetProviders } from "@better-ccflare/providers";

// Zai-compatible provider (based on z.ai API)
const zaiProvider = PresetProviders.createZaiCompatible();

// Minimax-compatible provider (based on MiniMax API)
const minimaxProvider = PresetProviders.createMinimaxCompatible();

// Generic OpenAI-compatible provider
const openaiProvider = PresetProviders.createOpenAICompatible();

// Custom provider with model mapping
const customProvider = PresetProviders.createWithModelMapping(
  "https://custom-api.service.com",
  {
    "claude-3-opus": "custom-opus",
    "claude-3-sonnet": "custom-sonnet",
  },
  {
    type: "bearer",
    header: "authorization",
    prefix: "Bearer ",
  }
);
```

## Model Mapping Example

When you need to map Anthropic model names to your provider's model names:

```typescript
const provider = new AnthropicCompatibleProvider({
  name: "mapped-provider",
  baseUrl: "https://api.my-service.com",
  modelMappings: {
    // Map high-end models
    "claude-3-opus": "premium-v3",
    "claude-3-sonnet": "standard-v3",
    "claude-3-haiku": "fast-v3",
    
    // Map legacy models
    "claude-2.1": "claude-v3",
    "claude-2": "claude-v2",
    "claude-instant": "claude-instant-v1",
  },
});

// Requests with Anthropic models will be automatically mapped:
// { model: "claude-3-sonnet" } → { model: "standard-v3" }
```

## Configuration Reference

### AnthropicCompatibleConfig

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `name` | `string` | `"anthropic-compatible"` | Provider name for identification |
| `baseUrl` | `string` | `process.env.ANTHROPIC_COMPATIBLE_BASE_URL` | API base URL |
| `authHeader` | `string` | `"x-api-key"` | Custom auth header name |
| `modelMappings` | `Record<string, string>` | `undefined` | Model name mappings |
| `supportsStreaming` | `boolean` | `true` | Enable streaming support |
| `defaultModel` | `string` | `undefined` | Default model fallback |

## Integration with Registry

```typescript
import { registerProvider } from "@better-ccflare/providers";
import { createAnthropicCompatibleProvider } from "@better-ccflare/providers";

// Register the provider
const myProvider = createAnthropicCompatibleProvider({
  name: "my-anthropic-service",
  baseUrl: "https://api.my-service.com",
  authType: "api_key",
});

registerProvider(myProvider);

// Now you can get it by name
import { getProvider } from "@better-ccflare/providers";
const provider = getProvider("my-anthropic-service");
```

## Environment Variables

You can configure the default base URL using environment variables:

```bash
# Set in your .env file
ANTHROPIC_COMPATIBLE_BASE_URL=https://my-custom-api.service.com
```

## Examples

### Complete Setup Example

```typescript
import { 
  AnthropicCompatibleProvider,
  createAnthropicCompatibleProvider,
  registerProvider 
} from "@better-ccflare/providers";

// Method 1: Direct instantiation
const customProvider = new AnthropicCompatibleProvider({
  name: "my-ai-service",
  baseUrl: "https://ai-api.mycompany.com/v1",
  authType: "api_key",
  authHeader: "x-api-key",
  modelMappings: {
    "claude-3-opus": "ai-premium",
    "claude-3-sonnet": "ai-standard",
    "claude-3-haiku": "ai-fast",
  },
  supportsStreaming: true,
});

// Method 2: Using factory
const aiProvider = createAnthropicCompatibleProvider({
  name: "company-ai",
  baseUrl: "https://company-ai.internal.com/api",
  authHeader: "authorization",
});

// Register with the global registry
registerProvider(customProvider);
registerProvider(aiProvider);

// Check what providers are available
import { listProviders } from "@better-ccflare/providers";
console.log("Available providers:", listProviders());
// ["anthropic", "minimax", "zai", "openai", "my-ai-service", "company-ai"]
```

### Dynamic Configuration

```typescript
const provider = new AnthropicCompatibleProvider();

// Start with basic config
provider.updateConfig({
  name: "dynamic-service",
  baseUrl: "https://initial-api.service.com",
  authType: "api_key",
});

// Later, update with model mappings
provider.updateConfig({
  modelMappings: {
    "claude-3-sonnet": "service-sonnet-v2",
    "claude-3-haiku": "service-haiku-v1",
  },
});

// Check current configuration
const config = provider.getConfig();
console.log("Current config:", config);
```

## Migration from Existing Providers

If you're migrating from z.ai or minimax providers:

```typescript
// Old z.ai setup
import { ZaiProvider } from "@better-ccflare/providers";
const zaiProvider = new ZaiProvider();

// New anthropic-compatible setup (equivalent)
import { PresetProviders } from "@better-ccflare/providers";
const zaiCompatibleProvider = PresetProviders.createZaiCompatible();

// Old minimax setup
import { MinimaxProvider } from "@better-ccflare/providers";
const minimaxProvider = new MinimaxProvider();

// New anthropic-compatible setup (equivalent)
import { PresetProviders } from "@better-ccflare/providers";
const minimaxCompatibleProvider = PresetProviders.createMinimaxCompatible();
```

## Testing

The provider includes comprehensive tests. Run them with:

```bash
npm test -- anthropic-compatible
```

## Error Handling

The provider handles various error scenarios gracefully:

- Missing API keys or tokens
- Invalid configuration
- Network timeouts during streaming
- Malformed JSON responses
- Rate limiting

All errors are properly logged and propagated with meaningful messages.

## Best Practices

1. **Always specify a provider name** for easier debugging and identification
2. **Use model mappings** when your service uses different model names than Anthropic
3. **Enable streaming** only when your endpoint supports it
4. **Use environment variables** for sensitive configuration like base URLs
5. **Register providers** with the global registry for easy access across your application
6. **Test your configuration** with the provided test suite

This provider provides a flexible foundation for integrating any Anthropic-compatible service into your application while maintaining compatibility with the existing provider ecosystem.