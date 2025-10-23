# Simplified Dockerfile using pre-built binaries from GitHub Releases
# Supports: linux/amd64, linux/arm64

ARG VERSION=latest

FROM debian:bookworm-slim

# Install required dependencies
RUN apt-get update && \
    apt-get install -y \
      sqlite3 \
      ca-certificates \
      curl \
      && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download the appropriate binary based on architecture
# TARGETARCH is automatically set by Docker buildx (amd64 or arm64)
ARG TARGETARCH
ARG VERSION
RUN echo "Downloading binary for architecture: ${TARGETARCH}" && \
    if [ "${VERSION}" = "latest" ]; then \
      DOWNLOAD_URL="https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-linux-${TARGETARCH}"; \
    else \
      DOWNLOAD_URL="https://github.com/tombii/better-ccflare/releases/download/v${VERSION}/better-ccflare-linux-${TARGETARCH}"; \
    fi && \
    echo "Downloading from: ${DOWNLOAD_URL}" && \
    curl -L -o /usr/local/bin/better-ccflare "${DOWNLOAD_URL}" && \
    chmod +x /usr/local/bin/better-ccflare

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

# Add labels for version tracking (will be overridden by GitHub Actions metadata)
ARG VERSION
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.title="better-ccflare"
LABEL org.opencontainers.image.description="Load balancer proxy for Claude API with intelligent distribution across multiple OAuth accounts"
LABEL org.opencontainers.image.source="https://github.com/tombii/better-ccflare"

# Default command: start the server
CMD ["better-ccflare", "--serve", "--port", "8080"]
