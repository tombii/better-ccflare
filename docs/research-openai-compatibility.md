# Research: OpenAI-Compatible Provider Implementation

## Executive Summary

Research conducted on existing solutions for implementing OpenAI-compatible API providers, with focus on format conversion between Anthropic and OpenAI APIs.

## Key Findings

### 1. LiteLLM (Recommended Approach)
**GitHub**: https://github.com/BerriAI/litellm
**Stars**: 22.7K+
**Language**: Python

#### Strengths
- **Battle-tested**: Used by Adobe, Lemonade, and many enterprises
- **Comprehensive**: Supports 100+ LLM providers in OpenAI format
- **Well-documented**: Excellent documentation and examples
- **Active development**: Regular updates and maintenance

#### Key Features
- Unified OpenAI-compatible interface for all providers
- Automatic format conversion (OpenAI ↔ Anthropic)
- Streaming response support
- Token usage tracking
- Cost tracking
- Fallback mechanisms
- Prompt caching support

#### Format Conversion Logic
Located in: `litellm/llms/anthropic/completion/transformation.py`

**Request Transformation:**
- Converts OpenAI message format to Anthropic format
- Parameter mapping:
  - `max_tokens` → `max_tokens_to_sample`
  - `stop` → `stop_sequences`
  - Supports temperature, top_p, metadata

**Response Transformation:**
- Extracts completion text from Anthropic responses
- Calculates token usage manually
- Handles streaming with custom iterators
- Standardizes response format

#### Usage Example
```python
from litellm import completion

# Same message format for both providers
messages = [{"content": "Hello", "role": "user"}]

# OpenAI call
response = completion(model="openai/gpt-4o", messages=messages)

# Anthropic call - same format
response = completion(model="anthropic/claude-sonnet-4", messages=messages)
```

#### Limitations for Our Use Case
- **Python-based**: Would need to port logic to TypeScript/JavaScript
- **Overkill**: We only need OpenAI → Anthropic, not 100+ providers
- **License**: MIT (good for adaptation)

### 2. Claude Code Router
**GitHub**: https://github.com/musistudio/claude-code-router
**Language**: JavaScript/TypeScript

#### Strengths
- **TypeScript-based**: Directly compatible with our stack
- **Flexible architecture**: Transformer-based provider adaptation
- **Active community**: Multiple related projects

#### Key Features
- Provider registry pattern (similar to ours)
- Transformer system for format conversion
- Dynamic model switching
- Support for multiple providers including OpenRouter

#### Provider Configuration Structure
```json
{
  "name": "provider-name",
  "api_base_url": "https://api.provider.com/v1/chat/completions",
  "api_key": "your-key",
  "models": ["model-1", "model-2"],
  "transformer": {
    "use": ["openrouter"]
  }
}
```

#### Transformer System
- Global transformers apply to all models
- Model-specific transformers for granular control
- Can modify request/response payloads
- Supports provider routing preferences

#### Limitations
- Less documented than LiteLLM
- Transformer implementation details unclear
- May be over-engineered for our needs

### 3. Y-Router (Cloudflare Worker)
**GitHub**: https://github.com/luohy15/y-router
**Type**: Cloudflare Worker

#### Strengths
- Lightweight proxy approach
- Specifically designed for Claude Code + OpenRouter
- Real-world usage in production

#### Limitations
- Limited documentation
- Cloudflare Worker specific (not reusable)
- GitHub page failed to load (possible maintenance issues)

### 4. Anthropic-Proxy
**GitHub**: https://github.com/maxnowack/anthropic-proxy
**Language**: JavaScript

#### Features
- Converts Anthropic API → OpenAI format → OpenRouter
- Environment-based configuration
- Simple proxy server approach
- Debug logging support

#### Configuration
```bash
OPENROUTER_API_KEY=key
ANTHROPIC_PROXY_BASE_URL=url
PORT=3000
REASONING_MODEL=model
COMPLETION_MODEL=model
```

#### Limitations
- Reverse direction (Anthropic → OpenAI, we need OpenAI → Anthropic)
- Minimal documentation
- Implementation details not in README

## Recommendations

### Approach 1: Adapt LiteLLM Logic (Recommended)
**Pros:**
- Proven, battle-tested transformation logic
- Well-documented format differences
- Can extract just the parts we need

**Cons:**
- Requires porting Python to TypeScript
- Need to understand their full transformation pipeline

**Implementation Steps:**
1. Study `litellm/llms/anthropic/completion/transformation.py`
2. Create TypeScript equivalent of transformation functions
3. Implement OpenAI provider class using our existing provider interface
4. Add request/response transformers
5. Test with various OpenAI-compatible providers (OpenRouter, Together AI, etc.)

### Approach 2: Study Claude Code Router Architecture
**Pros:**
- Already in TypeScript
- Transformer pattern may be reusable

**Cons:**
- Less documentation on actual transformation logic
- May need to reverse-engineer implementation

**Implementation Steps:**
1. Clone and analyze claude-code-router codebase
2. Extract transformer implementation
3. Adapt to our provider system
4. Implement OpenAI provider

### Approach 3: Build from Scratch Using API Specs
**Pros:**
- Full control over implementation
- Minimal dependencies
- Can optimize for our specific needs

**Cons:**
- More work to handle edge cases
- Need to thoroughly understand both API formats
- Risk of bugs in format conversion

## Key API Differences to Handle

### Message Format
**OpenAI:**
```json
{
  "messages": [
    {"role": "system", "content": "You are helpful"},
    {"role": "user", "content": "Hello"}
  ]
}
```

**Anthropic:**
```json
{
  "system": "You are helpful",
  "messages": [
    {"role": "user", "content": "Hello"}
  ]
}
```

### Parameter Names
| OpenAI | Anthropic |
|--------|-----------|
| `max_tokens` | `max_tokens` (same) |
| `stop` | `stop_sequences` |
| `temperature` | `temperature` (same) |
| `top_p` | `top_p` (same) |
| `stream` | `stream` (same) |

### Response Format
Both use similar structure but field names differ:
- OpenAI: `choices[0].message.content`
- Anthropic: `content[0].text`

### Headers
**OpenAI:**
- `Authorization: Bearer <api_key>`
- No version header required

**Anthropic:**
- `x-api-key: <api_key>` (for API key auth)
- `authorization: Bearer <token>` (for OAuth)
- `anthropic-version: 2023-06-01` (required)

## Next Steps

1. **Review LiteLLM transformation code in detail**
   - Clone repo and study Python implementation
   - Document all transformation rules

2. **Design OpenAI Provider Architecture**
   - Define provider class structure
   - Plan transformer implementation
   - Determine if we need request/response middleware

3. **Prototype Implementation**
   - Start with basic OpenAI provider
   - Add format transformers
   - Test with OpenRouter

4. **Testing Strategy**
   - Test with multiple OpenAI-compatible providers
   - Verify streaming works
   - Validate token usage tracking
   - Check rate limit handling

## Resources

- [LiteLLM GitHub](https://github.com/BerriAI/litellm)
- [LiteLLM Anthropic Docs](https://docs.litellm.ai/docs/providers/anthropic)
- [LiteLLM OpenAI-Compatible Docs](https://docs.litellm.ai/docs/providers/openai_compatible)
- [Claude Code Router](https://github.com/musistudio/claude-code-router)
- [Anthropic API Docs](https://docs.anthropic.com/en/api)
- [OpenAI API Docs](https://platform.openai.com/docs/api-reference)
