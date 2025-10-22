# Docker Quick Start Guide

## What Happens When You Push

When you `git push origin main`, this is the complete flow:

```
You: git push origin main
  ↓
Pre-push hook:
  ✓ Bumps version (1.2.27 → 1.2.28)
  ✓ Builds dashboard + TUI
  ✓ Publishes to npm
  ✓ Creates git tag v1.2.28
  ✓ Pushes tag to GitHub
  ↓
GitHub Actions (automatically triggered by tag):
  ✓ Builds multi-arch binaries (release.yml)
  ✓ Builds Docker images (docker-publish.yml) ← NEW!
  ↓
Published everywhere:
  ✓ npm: better-ccflare@1.2.28
  ✓ GitHub Releases: v1.2.28 with binaries
  ✓ Docker: ghcr.io/tombii/better-ccflare:1.2.28 ← NEW!
```

## First Time Setup (One-time)

No additional setup needed! The workflow uses `GITHUB_TOKEN` which is automatically provided by GitHub Actions.

## Testing the Docker Build

### Option 1: Push to Main (Full Pipeline)

```bash
# Make a small change to trigger the pipeline
git add .
git commit -m "feat: add Docker support"
git push origin main

# The pre-push hook will:
# 1. Bump version to 1.2.28
# 2. Build and publish to npm
# 3. Create and push tag v1.2.28
# 4. This triggers Docker build automatically
```

### Option 2: Test Docker Build Locally (No Publishing)

```bash
# Build for your current architecture only
docker build -t better-ccflare:local .

# Run it
docker run -p 8080:8080 -v better-ccflare-data:/data better-ccflare:local

# Or use docker-compose
docker-compose up
```

## Monitoring the Build

After pushing to main:

1. **NPM publish**: Watch pre-push hook output for auth URL
2. **GitHub Actions**:
   - Binaries: https://github.com/tombii/better-ccflare/actions/workflows/release.yml
   - Docker: https://github.com/tombii/better-ccflare/actions/workflows/docker-publish.yml

3. **Results**:
   - NPM: https://www.npmjs.com/package/better-ccflare
   - Releases: https://github.com/tombii/better-ccflare/releases
   - Docker: https://github.com/tombii/better-ccflare/pkgs/container/better-ccflare

## What Docker Images Are Built

For git tag `v1.2.28`, these images are created:

```bash
ghcr.io/tombii/better-ccflare:1.2.28  # Specific version
ghcr.io/tombii/better-ccflare:1.2     # Minor version
ghcr.io/tombii/better-ccflare:1       # Major version
ghcr.io/tombii/better-ccflare:latest  # Latest release
```

Each image is built for:
- `linux/amd64` (x86_64)
- `linux/arm64` (ARM64, Raspberry Pi, AWS Graviton)

## Using the Published Images

After the build completes (~5 minutes):

```bash
# Pull and run
docker pull ghcr.io/tombii/better-ccflare:latest
docker run -d \
  --name better-ccflare \
  -p 8080:8080 \
  -v better-ccflare-data:/data \
  ghcr.io/tombii/better-ccflare:latest

# Or use docker-compose
docker-compose pull  # Get latest image
docker-compose up -d
```

## Troubleshooting

### Build fails in GitHub Actions

Check the workflow logs:
- https://github.com/tombii/better-ccflare/actions/workflows/docker-publish.yml

Common issues:
- Dockerfile syntax error
- Missing dependencies
- Build timeout (increase if needed)

### Can't pull image

Make sure the package is public:
1. Go to https://github.com/tombii/better-ccflare/pkgs/container/better-ccflare
2. Click "Package settings"
3. Scroll to "Danger Zone"
4. Click "Change visibility" → "Public"

### Image has wrong version

Check:
```bash
docker pull ghcr.io/tombii/better-ccflare:latest
docker inspect ghcr.io/tombii/better-ccflare:latest | jq '.[0].Config.Labels'
```

Should show:
```json
{
  "org.opencontainers.image.version": "1.2.28",
  "org.opencontainers.image.source": "https://github.com/tombii/better-ccflare"
}
```

## Next Steps

1. **Commit and push** the new Docker files
2. **Watch the magic happen** - GitHub Actions builds everything
3. **Test the image**: `docker pull ghcr.io/tombii/better-ccflare:latest`
4. **Share with users** - they can now use Docker!

## Files Added

- `Dockerfile` - Multi-stage Docker build
- `.dockerignore` - Optimize Docker context
- `docker-compose.yml` - Easy deployment
- `.github/workflows/docker-publish.yml` - Automated builds
- `DOCKER.md` - Full Docker documentation
- `DEPLOYMENT.md` - Complete deployment guide
- `VERSION-TRACKING.md` - Version sync explanation
- `QUICKSTART-DOCKER.md` - This file

No changes needed to:
- ✅ Pre-push hook (already perfect)
- ✅ Binary builds (already working)
- ✅ npm publish (already working)

Just commit and push!
