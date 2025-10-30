# @better-ccflare/security

Centralized security utilities for path validation and sanitization in the better-ccflare monorepo.

## Purpose

This package provides defense-in-depth protection against path traversal and related file system security vulnerabilities. It implements a comprehensive 7-layer validation approach to ensure file paths are safe before accessing the file system.

## Features

- **Multi-layer validation**: 7 independent security checks
- **Defense-in-depth**: Multiple complementary validation strategies
- **Cross-platform**: Handles both Unix (`/`) and Windows (`\`) path separators
- **URL encoding protection**: Detects single and double-encoded attacks
- **Unicode normalization**: Prevents fullwidth character bypasses
- **Whitelist-based**: Only allows paths within explicitly allowed directories
- **Symlink detection**: Optional warning or blocking of symbolic links
- **Comprehensive logging**: Structured security event logging for SIEM integration

## Installation

This is an internal workspace package. Add it to your package dependencies:

```json
{
  "dependencies": {
    "@better-ccflare/security": "workspace:*"
  }
}
```

## Usage

### Basic Usage

```typescript
import { validatePath } from '@better-ccflare/security';

const result = validatePath('/home/user/data/file.txt', {
  description: 'user data file'
});

if (!result.isValid) {
  console.error(`Path validation failed: ${result.reason}`);
  return;
}

// Safe to use result.resolvedPath
const content = readFileSync(result.resolvedPath, 'utf-8');
```

### Throw on Invalid Path

```typescript
import { validatePathOrThrow } from '@better-ccflare/security';

try {
  const safePath = validatePathOrThrow('/home/user/../../etc/passwd', {
    description: 'config file'
  });
  // Use safePath...
} catch (error) {
  console.error('Invalid path:', error.message);
}
```

### Custom Allowed Directories

```typescript
import { validatePath } from '@better-ccflare/security';

const result = validatePath('/opt/app/data/file.txt', {
  description: 'application data',
  additionalAllowedPaths: ['/opt/app']
});
```

### Block Symbolic Links

```typescript
import { validatePath } from '@better-ccflare/security';

const result = validatePath('/home/user/link', {
  description: 'user file',
  blockSymlinks: true  // Reject symlinks instead of warning
});
```

### Control Empty String Handling

By default, empty strings are allowed and resolve to the current working directory. Use `allowEmpty: false` to reject empty paths:

```typescript
import { validatePath } from '@better-ccflare/security';

// For user uploads: disallow empty paths to prevent security issues
const result = validatePath(userPath, {
  description: 'user upload',
  allowEmpty: false
});

// For optional config: allow empty (default behavior)
const configResult = validatePath(configPath, {
  description: 'config file'
  // allowEmpty defaults to true
});
```

## Security Model

### Validation Layers

The `validatePath()` function implements 7 validation layers:

1. **URL Decoding**: Iterative decoding to catch multi-encoded attacks (e.g., `%252e%252e` → `%2e%2e` → `..`)
2. **Unicode Normalization**: NFC normalization to prevent fullwidth character bypasses (e.g., U+FF0E)
3. **Null Byte Detection**: Blocks null bytes (`\0`) that can bypass security checks
4. **Directory Traversal Detection**: Checks for `..` sequences in both Unix and Windows formats
5. **Path Resolution**: Normalizes and converts to absolute paths
6. **Whitelist Validation**: Uses `path.relative()` to ensure path is within allowed directories
7. **Symlink Detection**: Optional detection and blocking of symbolic links

### Default Allowed Directories

By default, paths are allowed within:

- Better-ccflare config directory (`~/.config/better-ccflare` on Linux/macOS, `AppData/Local/better-ccflare` on Windows)
- Current working directory (`process.cwd()`)
- Temp directory (cross-platform: `/tmp` on Unix, `C:\temp` on Windows)

**Important**: This default may be too permissive for some deployments. Always specify `additionalAllowedPaths` explicitly for production use.

### Known Limitations

1. **TOCTOU Vulnerability**: Time-of-check-time-of-use race condition exists between validation and file access. An attacker could create a symlink after validation but before file access.

2. **Symlink Default**: Symbolic links are blocked by default for security. To allow symlinks with warnings, set `blockSymlinks: false`.

3. **Very Long Paths**: Paths exceeding `PATH_MAX` (typically 4096 bytes on Linux) may cause issues on some systems.

4. **Platform Differences**: Windows-specific attacks may not be fully covered when validation runs on Unix systems.

## Security Best Practices

### 1. Use Specific Allowed Paths

Don't rely on defaults. Explicitly specify allowed directories:

```typescript
const result = validatePath(userPath, {
  description: 'user upload',
  additionalAllowedPaths: ['/var/app/uploads']
});
```

### 2. Block Symlinks in Production

For high-security environments, block symlinks:

```typescript
const result = validatePath(configPath, {
  description: 'config file',
  blockSymlinks: true
});
```

### 3. Always Validate Before File Operations

```typescript
// ❌ WRONG
const content = readFileSync(userProvidedPath);

// ✅ CORRECT
const result = validatePathOrThrow(userProvidedPath, {
  description: 'user file'
});
const content = readFileSync(result.resolvedPath);
```

### 4. Use Descriptive Validation Messages

The `description` parameter helps with debugging and security monitoring:

```typescript
validatePath(path, {
  description: 'agent configuration file'  // Appears in logs
});
```

### 5. Monitor Security Logs

All validation failures are logged with structured data:

```json
{
  "source": "config file",
  "path": "../../../etc/passwd",
  "attack_type": "directory_traversal",
  "timestamp": "2025-10-28T15:30:00Z"
}
```

Integrate these logs with your SIEM system for attack detection.

## API Reference

### `validatePath(rawPath: string, options?: PathValidationOptions): PathValidationResult`

Validates a file system path and returns a result object.

**Parameters:**
- `rawPath`: The path to validate
- `options`: Optional configuration

**Returns:**
```typescript
interface PathValidationResult {
  isValid: boolean;           // Whether path passed validation
  decodedPath: string;        // URL-decoded and normalized path
  resolvedPath: string;       // Absolute, normalized path
  reason?: string;            // Failure reason if invalid
}
```

### `validatePathOrThrow(rawPath: string, options?: PathValidationOptions): string`

Validates a path and throws an error if invalid.

**Returns:** The safe resolved path

**Throws:** `Error` if path is invalid

### `getDefaultAllowedBasePaths(forceRefresh?: boolean): string[]`

Gets the default allowed base directories. Results are cached.

**Parameters:**
- `forceRefresh`: Force recomputation of cached paths

**Returns:** Array of allowed directory paths

### `clearValidationCache(): void`

Clears the validation cache. Useful for testing or when path configurations change.

### `getValidationCacheSize(): number`

Gets the current number of cached validation results for monitoring.

**Returns:** Number of cached entries

### `PathValidationOptions`

```typescript
interface PathValidationOptions {
  // Additional allowed directories
  additionalAllowedPaths?: string[];

  // Max URL decoding iterations (default: 2)
  maxUrlDecodeIterations?: number;

  // Block symlinks instead of warning (default: true - block for security)
  blockSymlinks?: boolean;

  // Check for symlinks at all (default: true)
  checkSymlinks?: boolean;

  // Description for logging
  description?: string;

  // Whether to allow empty strings (resolves to CWD). Default: true
  allowEmpty?: boolean;
}
```

## Testing

Run the test suite:

```bash
bun test packages/security/
```

The package includes 44 comprehensive tests covering:
- Direct traversal attempts
- URL-encoded attacks (single and double encoding)
- Whitelist validation and bypass attempts
- Unicode attacks
- Null byte injection
- Windows backslash traversal
- Mixed case and special characters
- Edge cases (empty paths, very long paths, etc.)

## Performance Considerations

Path validation adds overhead to file operations. For high-traffic applications:

### Built-in Optimizations

The security package includes built-in performance optimizations:

1. **LRU Caching**: Validation results are cached (`DEFAULT_CACHE_SIZE = 1000` entries) to avoid repeated validation
2. **Production Logging**: Successful validations log at `debug` level in production, `info` in development
3. **Cached Default Paths**: Default allowed paths are computed once and reused
4. **Optimized Cache Keys**: Minimal string operations for cache key construction

### Monitoring Cache Performance

```typescript
import { getValidationCacheSize, clearValidationCache } from '@better-ccflare/security';

// Monitor cache size
console.log(`Cache entries: ${getValidationCacheSize()}`);

// Clear cache if needed (e.g., after configuration changes)
clearValidationCache();
```

### Additional Recommendations

1. **Monitor Performance**: Use APM tools to track validation overhead
2. **Benchmark**: Test with representative workloads
3. **Adjust Cache Size**: Modify `maxSize` in ValidationCache for your use case

See `packages/proxy/src/handlers/agent-interceptor.ts` for performance notes on per-request validation.

## Contributing

When adding new validation layers:

1. Add tests for both positive and negative cases
2. Update the validation layer count in documentation
3. Add structured logging with appropriate `attack_type`
4. Consider performance impact
5. Update this README

## License

Part of the better-ccflare project.
