# Multi-stage Dockerfile for better-ccflare
# Supports: linux/amd64, linux/arm64

ARG BUN_VERSION=1.2.8

# Stage 1: Builder
FROM oven/bun:${BUN_VERSION} AS builder

WORKDIR /app

# Copy everything (monorepo needs all code for workspace dependencies)
COPY . .

# Install dependencies
RUN bun install --frozen-lockfile

# Build the dashboard and TUI
RUN bun run build

# Stage 2: Runtime
FROM oven/bun:${BUN_VERSION}-slim AS runtime

WORKDIR /app

# Install SQLite (needed for database operations)
RUN apt-get update && \
    apt-get install -y sqlite3 && \
    rm -rf /var/lib/apt/lists/*

# Copy built artifacts from builder
COPY --from=builder /app/apps/tui/dist/better-ccflare /usr/local/bin/better-ccflare
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages

# Add labels for version tracking (will be overridden by GitHub Actions metadata)
ARG VERSION
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.title="better-ccflare"
LABEL org.opencontainers.image.description="Load balancer proxy for Claude API with intelligent distribution across multiple OAuth accounts"
LABEL org.opencontainers.image.source="https://github.com/tombii/better-ccflare"

# Make the binary executable
RUN chmod +x /usr/local/bin/better-ccflare

# Create data directory for database
RUN mkdir -p /data

# Set environment variables
ENV NODE_ENV=production
ENV BETTER_CCFLARE_DB_PATH=/data/better-ccflare.db

# Expose default port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

# Default command: start the server
CMD ["bun", "run", "apps/server/src/server.ts", "--serve"]
