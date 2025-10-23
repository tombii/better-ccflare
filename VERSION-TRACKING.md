# Version Tracking Across Platforms

This document explains how version numbers are automatically synchronized across all deployment platforms.

## Version Source of Truth

The version number is defined in:
- **Primary**: `/apps/tui/package.json`
- **Synced**: `/package.json` (root)

## Automated Version Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ Pre-push Hook: Version Bump                                     │
├─────────────────────────────────────────────────────────────────┤
│ 1. Read current version from apps/tui/package.json              │
│    Current: 1.2.27                                              │
│                                                                  │
│ 2. Increment patch version                                      │
│    New: 1.2.28                                                  │
│                                                                  │
│ 3. Update files:                                                │
│    ✓ apps/tui/package.json → "version": "1.2.28"               │
│    ✓ package.json (root) → "version": "1.2.28"                 │
│    ✓ packages/core/src/version.ts → cachedVersion = "1.2.28"   │
│                                                                  │
│ 4. Commit version bump                                          │
│ 5. Create git tag: v1.2.28                                      │
│ 6. Push tag to GitHub                                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
         ┌───────────────┼───────────────┐
         ▼               ▼               ▼
    ┌─────────┐    ┌──────────┐    ┌─────────┐
    │   NPM   │    │ Binaries │    │ Docker  │
    └─────────┘    └──────────┘    └─────────┘
```

## Platform-Specific Version Tracking

### 1. NPM Package (npmjs.com)

**Version Source**: `apps/tui/package.json`

```json
{
  "name": "better-ccflare",
  "version": "1.2.28"  ← Used by npm publish
}
```

**Where it appears**:
- Package registry: https://www.npmjs.com/package/better-ccflare
- `npm info better-ccflare version` → `1.2.28`
- User installation: `npm install -g better-ccflare@1.2.28`

**How it's set**: Pre-push hook updates package.json before `bun publish`

### 2. Multi-Architecture Binaries (GitHub Releases)

**Version Source**: Git tag (`v1.2.28`)

**Build Process**:
1. Git tag triggers `.github/workflows/release.yml`
2. Workflow reads version from `apps/tui/package.json`
3. Build script (`build-multi-arch.ts`) injects version:
   ```typescript
   const packageJson = await Bun.file("./package.json").json();
   const version = packageJson.version; // "1.2.28"
   ```
4. Bun compiles with: `--define process.env.BETTER_CCFLARE_VERSION='"1.2.28"'`

**Where it appears**:
- GitHub Release: `v1.2.28`
- Binary filenames: `better-ccflare-linux-amd64` (version in release tag)
- Runtime: `better-ccflare --version` → `1.2.28`
- Download URL: `https://github.com/tombii/better-ccflare/releases/download/v1.2.28/better-ccflare-linux-amd64`

**How it's set**:
- Release tag: From git tag (`v1.2.28`)
- Binary version: From `package.json` during build
- Runtime version: Compiled into binary via `BETTER_CCFLARE_VERSION` env var

### 3. Docker Images (ghcr.io)

**Version Source**: Git tag + Docker metadata

**Build Process**:
1. Git tag triggers `.github/workflows/docker-publish.yml`
2. `docker/metadata-action@v5` extracts version from git tag:
   ```yaml
   tags: |
     type=semver,pattern={{version}}      → 1.2.28
     type=semver,pattern={{major}}.{{minor}} → 1.2
     type=semver,pattern={{major}}        → 1
     type=raw,value=latest                → latest
   ```
3. Dockerfile copies `package.json` files (contains version)
4. Build runs with version labels:
   ```dockerfile
   LABEL org.opencontainers.image.version="1.2.28"
   ```

**Where it appears**:
- Image tags: `ghcr.io/tombii/better-ccflare:1.2.28`
- Image tags: `ghcr.io/tombii/better-ccflare:1.2`
- Image tags: `ghcr.io/tombii/better-ccflare:1`
- Image tags: `ghcr.io/tombii/better-ccflare:latest`
- Image labels: `org.opencontainers.image.version=1.2.28`
- Container registry: https://github.com/tombii/better-ccflare/pkgs/container/better-ccflare
- Runtime inside container: `better-ccflare --version` → `1.2.28`

**How it's set**:
- Image tags: Automatically from git tag via `docker/metadata-action`
- Image labels: From Dockerfile `LABEL` directives + metadata action
- Binary version: From `package.json` copied during Docker build

**Inspect version**:
```bash
# Check image labels
docker inspect ghcr.io/tombii/better-ccflare:latest | jq '.[0].Config.Labels'

# Check binary version inside container
docker run --rm ghcr.io/tombii/better-ccflare:latest better-ccflare --version
```

## Version Consistency Verification

All three platforms use the same version number from the same source:

| Platform | Version Source | Example |
|----------|---------------|---------|
| NPM | `apps/tui/package.json` | `1.2.28` |
| GitHub Releases | Git tag (from package.json) | `v1.2.28` |
| Docker Images | Git tag → semver tags | `1.2.28`, `1.2`, `1`, `latest` |
| Binary Runtime | Compiled from package.json | `1.2.28` |

## Checking Versions

### NPM
```bash
npm info better-ccflare version
# Output: 1.2.28
```

### GitHub Releases
```bash
curl -s https://api.github.com/repos/tombii/better-ccflare/releases/latest | jq -r .tag_name
# Output: v1.2.28
```

### Docker Image
```bash
# Check image tags
docker pull ghcr.io/tombii/better-ccflare:latest
docker image inspect ghcr.io/tombii/better-ccflare:latest | jq '.[0].Config.Labels."org.opencontainers.image.version"'
# Output: "1.2.28"

# Check binary version
docker run --rm ghcr.io/tombii/better-ccflare:latest better-ccflare --version
# Output: 1.2.28
```

### Installed Binary
```bash
better-ccflare --version
# Output: 1.2.28
```

## Version in Code

The version is accessible at runtime via:

```typescript
// packages/core/src/version.ts
export function getVersion(): string {
  // Try environment variable first (set during compilation)
  if (process.env.BETTER_CCFLARE_VERSION) {
    return process.env.BETTER_CCFLARE_VERSION;
  }

  // Fallback to hardcoded version (updated by pre-push hook)
  return "1.2.28";
}
```

This version is displayed:
- In `--version` CLI flag
- In server logs on startup
- In API responses (user-agent)
- In dashboard footer

## Docker Tag Strategy

When git tag `v1.2.28` is pushed, the following Docker tags are created:

1. **Specific version**: `ghcr.io/tombii/better-ccflare:1.2.28`
   - Immutable reference to exact version
   - Use for reproducible deployments

2. **Minor version**: `ghcr.io/tombii/better-ccflare:1.2`
   - Points to latest patch in the 1.2.x series
   - Automatically updated on new patches

3. **Major version**: `ghcr.io/tombii/better-ccflare:1`
   - Points to latest minor in the 1.x.x series
   - Automatically updated on new minors

4. **Latest**: `ghcr.io/tombii/better-ccflare:latest`
   - Points to the most recent release
   - Always updated on new versions

**Recommendation**: Use specific version tags in production for stability.

## Versioning Scheme

better-ccflare follows Semantic Versioning (SemVer):

```
v1.2.28
│ │ │
│ │ └─ PATCH: Bug fixes, small changes (auto-incremented by pre-push hook)
│ └─── MINOR: New features, backwards-compatible (manual bump)
└───── MAJOR: Breaking changes (manual bump)
```

**Currently**: Pre-push hook only auto-increments PATCH version.

**To bump MINOR or MAJOR manually**:
```bash
# Edit apps/tui/package.json
{
  "version": "1.3.0"  # or "2.0.0"
}

# Commit with [skip-version] to prevent auto-bump
git commit -m "feat: major new feature [skip-version]"
git push origin main
```

## Troubleshooting Version Mismatches

### NPM version doesn't match Git tag

**Cause**: npm publish failed but git tag was created

**Fix**:
```bash
cd apps/tui
bun publish  # Re-publish manually
```

### Docker image has wrong version label

**Cause**: Dockerfile was updated without git tag

**Fix**: Push a new git tag to trigger rebuild:
```bash
git tag -d v1.2.28  # Delete locally
git push origin :v1.2.28  # Delete remotely
git tag -a v1.2.28 -m "Release v1.2.28"
git push origin v1.2.28
```

### Binary reports wrong version at runtime

**Cause**: Binary was built without version environment variable

**Fix**: Rebuild with proper version:
```bash
cd apps/tui
bun run build  # Includes BETTER_CCFLARE_VERSION
```

## Summary

✅ **Single source of truth**: `apps/tui/package.json`
✅ **Automatic synchronization**: Pre-push hook updates all files
✅ **Consistent across platforms**: NPM, GitHub, Docker all use same version
✅ **Git tag drives automation**: Triggers multi-arch builds + Docker publish
✅ **Semantic versioning**: Major.Minor.Patch (currently auto-incrementing patch only)
✅ **Multiple Docker tags**: Specific version + minor + major + latest
✅ **Runtime accessible**: `better-ccflare --version` works everywhere

The entire system ensures that when you push to `main`, all platforms receive the same version number automatically!
