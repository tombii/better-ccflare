# Automated Deployment Pipeline

This document explains the complete automated build and publish pipeline for better-ccflare.

## Overview

When you push to the `main` branch, the following happens automatically:

1. **Pre-push hook runs** (`.git/hooks/pre-push`)
2. **Version is bumped** in package.json files
3. **Builds are created** (dashboard + TUI)
4. **npm package is published** to npmjs.com
5. **Git tag is created** (e.g., `v1.2.28`)
6. **Git tag triggers GitHub Actions**:
   - Multi-architecture binaries are built
   - Docker images are built for multiple platforms
   - Both are published to GitHub

## Automated Build Targets

### NPM Package
- Published to: https://www.npmjs.com/package/better-ccflare
- Trigger: Pre-push hook on `main` branch
- Contains: Pre-compiled binary for the user's platform

### Multi-Architecture Binaries
- Published to: GitHub Releases
- Trigger: Git tag (created by pre-push hook)
- Platforms:
  - `linux/amd64` (x86_64)
  - `linux/arm64` (ARM64/aarch64, Raspberry Pi, AWS Graviton, Oracle Cloud)
  - `darwin/amd64` (macOS Intel)
  - `darwin/arm64` (macOS Apple Silicon)
  - `windows/amd64` (Windows x86_64)
- Workflow: `.github/workflows/release.yml`

### Docker Images
- Published to: GitHub Container Registry (ghcr.io)
- Trigger: Git tag (created by pre-push hook)
- Platforms:
  - `linux/amd64` (x86_64)
  - `linux/arm64` (ARM64/aarch64)
- Workflow: `.github/workflows/docker-publish.yml`
- Pull with: `docker pull ghcr.io/tombii/better-ccflare:latest`

## The Automated Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│ Developer: git push origin main                                 │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Pre-push Hook (.git/hooks/pre-push)                             │
├─────────────────────────────────────────────────────────────────┤
│ 1. Check if pushing to main                                     │
│ 2. Check for [skip-version] flag in commit message              │
│ 3. Copy README.md to apps/tui/                                  │
│ 4. Bump version in package.json files                           │
│ 5. Update version.ts fallback                                   │
│ 6. Commit version bump                                          │
│ 7. Exit (require second push)                                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Developer: git push origin main (again)                         │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ Pre-push Hook (second run)                                      │
├─────────────────────────────────────────────────────────────────┤
│ 1. Detect "🚀 chore: bump version" commit                       │
│ 2. Build dashboard: bun run build:dashboard                     │
│ 3. Build TUI: bun run build:tui                                 │
│ 4. Publish to npm: cd apps/tui && bun publish                   │
│    ├─ Shows auth URL: https://www.npmjs.com/auth/cli/[uuid]    │
│    └─ Waits for auth confirmation                               │
│ 5. Create git tag: git tag -a v1.2.28                           │
│ 6. Push git tag: git push origin v1.2.28                        │
│ 7. Allow main push to proceed                                   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ├─────────────────┬─────────────────┐
                         ▼                 ▼                 ▼
    ┌────────────────────────┐  ┌──────────────────┐  ┌─────────────────┐
    │ NPM Registry           │  │ GitHub: Binaries │  │ GitHub: Docker  │
    │ npmjs.com              │  │ Multi-arch       │  │ Multi-platform  │
    └────────────────────────┘  └──────────────────┘  └─────────────────┘
                                          │                     │
                         ┌────────────────┴─────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ GitHub Actions: release.yml                                     │
├─────────────────────────────────────────────────────────────────┤
│ Triggered by: Git tag push (v*)                                 │
│ Runs on: ubuntu-latest                                          │
│                                                                  │
│ Steps:                                                           │
│ 1. Checkout code                                                │
│ 2. Setup Bun                                                    │
│ 3. Install dependencies: bun install                            │
│ 4. Build multi-arch: cd apps/tui && bun run build:multi        │
│    ├─ Linux x64                                                 │
│    ├─ Linux ARM64                                               │
│    ├─ macOS x64                                                 │
│    ├─ macOS ARM64                                               │
│    └─ Windows x64                                               │
│ 5. Create GitHub Release                                        │
│ 6. Upload all binaries as release assets                        │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│ GitHub Actions: docker-publish.yml                              │
├─────────────────────────────────────────────────────────────────┤
│ Triggered by: Git tag push (v*), push to main, or PR           │
│ Runs on: ubuntu-latest                                          │
│                                                                  │
│ Steps:                                                           │
│ 1. Checkout code                                                │
│ 2. Set up QEMU (for cross-platform builds)                     │
│ 3. Set up Docker Buildx                                         │
│ 4. Login to ghcr.io (GitHub Container Registry)                │
│ 5. Extract metadata (tags, labels)                              │
│ 6. Build and push multi-platform images:                        │
│    ├─ linux/amd64                                               │
│    └─ linux/arm64                                               │
│ 7. Push to ghcr.io/tombii/better-ccflare                       │
│    ├─ latest (from main)                                        │
│    ├─ v1.2.28 (from tag)                                        │
│    ├─ 1.2 (from tag)                                            │
│    └─ 1 (from tag)                                              │
│ 8. Generate build attestation                                   │
└─────────────────────────────────────────────────────────────────┘
```

## Installation Methods

After the automated pipeline completes, users can install better-ccflare in multiple ways:

### 1. NPM (Recommended)
```bash
npm install -g better-ccflare
```

### 2. Direct Binary Download
```bash
# Linux x64
wget https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-linux-amd64
chmod +x better-ccflare-linux-amd64
./better-ccflare-linux-amd64

# Linux x64, CPUs without AVX2 ("Illegal instruction" with the build above)
wget https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-linux-amd64-baseline
chmod +x better-ccflare-linux-amd64-baseline
./better-ccflare-linux-amd64-baseline

# Linux ARM64
wget https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-linux-arm64
chmod +x better-ccflare-linux-arm64
./better-ccflare-linux-arm64
```

### 3. Docker
```bash
# Pull and run
docker pull ghcr.io/tombii/better-ccflare:latest
docker run -p 8080:8080 ghcr.io/tombii/better-ccflare:latest

# Or use docker-compose
docker-compose up -d
```

## Skipping Automatic Version Bump

To skip the automatic version bump and publishing, add `[skip-version]` or `[no-version]` to your commit message:

```bash
git commit -m "docs: update README [skip-version]"
git push origin main  # Will skip version bump
```

## Monitoring Builds

### NPM Publish
- Watch the pre-push hook output for the npm auth URL
- Complete auth in browser
- Check publish status at: https://www.npmjs.com/package/better-ccflare

### GitHub Actions
- Multi-arch binaries: https://github.com/tombii/better-ccflare/actions/workflows/release.yml
- Docker images: https://github.com/tombii/better-ccflare/actions/workflows/docker-publish.yml
- Releases: https://github.com/tombii/better-ccflare/releases

### Docker Images
- Registry: https://github.com/tombii/better-ccflare/pkgs/container/better-ccflare
- Pull: `docker pull ghcr.io/tombii/better-ccflare:latest`

## Troubleshooting

### Pre-push hook fails
```bash
# Check if you're on main branch
git branch

# Check commit message
git log -1 --pretty=format:"%s"

# Skip version bump if needed
git commit --amend -m "$(git log -1 --pretty=%B) [skip-version]"
```

### NPM publish fails
```bash
# Check if logged in
bun whoami

# Login if needed
bun login

# Manually publish
cd apps/tui
bun publish
```

### GitHub Actions fails
1. Check workflow runs: https://github.com/tombii/better-ccflare/actions
2. View logs for failed jobs
3. Common issues:
   - Missing secrets (GITHUB_TOKEN is automatic)
   - Build failures (check bun version compatibility)
   - Permission issues (check repository settings)

### Docker build fails
1. Check Docker workflow: https://github.com/tombii/better-ccflare/actions/workflows/docker-publish.yml
2. Common issues:
   - Dockerfile syntax errors
   - Missing dependencies
   - Platform-specific build failures (check QEMU setup)

## Manual Builds

If you need to build manually without the automated pipeline:

### NPM Package
```bash
cd apps/tui
bun run build
bun publish
```

### Multi-arch Binaries
```bash
cd apps/tui
bun run build:multi
```

### Docker (Local)
```bash
# Single platform
docker build -t better-ccflare:local .

# Multi-platform (requires buildx)
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/tombii/better-ccflare:test \
  .
```

## GitHub Container Registry Setup

The workflow is already configured to use GitHub Container Registry (ghcr.io). No additional setup needed!

- Authentication: Automatic via `GITHUB_TOKEN`
- Permissions: Automatic for repository actions
- Public access: Images are publicly pullable
- URL: `ghcr.io/tombii/better-ccflare`

### Optional: Docker Hub Publishing

If you also want to publish to Docker Hub, add these repository secrets:

1. Go to: https://github.com/tombii/better-ccflare/settings/secrets/actions
2. Click "New repository secret"
3. Add:
   - `DOCKERHUB_USERNAME`: Your Docker Hub username
   - `DOCKERHUB_TOKEN`: Docker Hub access token (create at https://hub.docker.com/settings/security)

The workflow will automatically detect these secrets and push to both registries.

## Security

### NPM Authentication
- Uses interactive auth via browser
- Auth URL shown in pre-push hook output
- Token stored locally after first auth

### GitHub Actions
- Uses `GITHUB_TOKEN` (automatic, scoped to repository)
- No manual token management needed
- Workflow permissions defined in workflow files

### Docker Registry
- GitHub Container Registry: Automatic via `GITHUB_TOKEN`
- Docker Hub: Optional, uses secrets if configured
- Build attestations: Automatically generated for security

## Best Practices

1. **Always review pre-push hook output** - especially the npm auth URL
2. **Monitor GitHub Actions** - check that all builds succeed
3. **Test before pushing to main** - use feature branches
4. **Use semantic versioning** - version bumps are automatic (patch only)
5. **Check releases** - verify binaries and Docker images are published correctly

## Timeline

Typical deployment timeline after `git push origin main`:

1. **0-1 min**: Pre-push hook (local)
   - Version bump
   - Build
   - npm publish
   - Git tag creation

2. **1-5 min**: GitHub Actions (parallel)
   - Multi-arch binary builds (~3-4 min)
   - Docker multi-platform builds (~4-5 min)

3. **5-6 min**: Publishing
   - GitHub Release created with binaries
   - Docker images pushed to ghcr.io

**Total time**: ~5-6 minutes from push to full deployment across all platforms
