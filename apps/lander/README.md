# Claudeflare Landing Page

Static landing page for Claudeflare

## Local Development

```bash
# Preview the site locally
bun run preview
```

## Build

```bash
# Build the site (copies src to dist)
bun run build
```

## Deploy to Cloudflare Pages

### Option 1: GitHub Integration

1. Push your code to GitHub
2. Go to [Cloudflare Pages](https://pages.cloudflare.com)
3. Connect your GitHub repository
4. Use these build settings:
   - Build command: `cd apps/lander && bun run build`
   - Build output directory: `apps/lander/dist`
   - Root directory: `/`

### Option 2: Direct Upload

1. Build the site locally:
   ```bash
   cd apps/lander
   bun run build
   ```

2. Upload the `dist` folder to Cloudflare Pages

### Option 3: Wrangler CLI

1. Install Wrangler:
   ```bash
   bun add -g wrangler
   ```

2. Deploy:
   ```bash
   cd apps/lander
   bun run build
   wrangler pages deploy dist --project-name=claudeflare-landing
   ```

## Features

- Dark theme matching Claudeflare dashboard
- Mobile responsive
- Security headers configured
- Optimized for performance
- Static HTML/CSS (no JavaScript framework)