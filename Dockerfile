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
      file \
      && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Download the appropriate binary based on architecture
# TARGETARCH is automatically set by Docker buildx (amd64 or arm64)
ARG TARGETARCH
ARG VERSION

# Determine correct architecture and download binary
RUN echo "=== Binary Download Information ===" && \
    echo "TARGETARCH from buildx: ${TARGETARCH}" && \
    echo "System uname -m: $(uname -m)" && \
    echo "Version: ${VERSION}" && \
    # Use TARGETARCH if set, otherwise detect from system
    if [ -z "${TARGETARCH}" ]; then \
      case "$(uname -m)" in \
        x86_64) ARCH=amd64 ;; \
        aarch64) ARCH=arm64 ;; \
        *) echo "Unsupported architecture: $(uname -m)"; exit 1 ;; \
      esac; \
    else \
      ARCH="${TARGETARCH}"; \
    fi && \
    echo "Using architecture: ${ARCH}" && \
    if [ "${VERSION}" = "latest" ]; then \
      DOWNLOAD_URL="https://github.com/tombii/better-ccflare/releases/latest/download/better-ccflare-linux-${ARCH}"; \
    else \
      DOWNLOAD_URL="https://github.com/tombii/better-ccflare/releases/download/v${VERSION}/better-ccflare-linux-${ARCH}"; \
    fi && \
    echo "Downloading from: ${DOWNLOAD_URL}" && \
    curl -L -f -o /usr/local/bin/better-ccflare "${DOWNLOAD_URL}" || (echo "Failed to download binary from ${DOWNLOAD_URL}"; exit 1) && \
    chmod +x /usr/local/bin/better-ccflare && \
    echo "Binary downloaded successfully" && \
    file /usr/local/bin/better-ccflare && \
    # Verify the binary can execute (basic sanity check)
    /usr/local/bin/better-ccflare --version || (echo "Binary verification failed - exec format error"; exit 1) && \
    echo "==================================="

# Create a non-root user to run the application
RUN useradd -r -u 1000 -m -s /bin/bash ccflare && \
    mkdir -p /data && \
    chown -R ccflare:ccflare /data /app

# Set environment variables
ENV NODE_ENV=production
ENV BETTER_CCFLARE_DB_PATH=/data/better-ccflare.db
ENV BETTER_CCFLARE_LOG_DIR=/app/logs

# Create logs directory with proper permissions
RUN mkdir -p /app/logs /data && chown -R ccflare:ccflare /app/logs /data

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

# Create startup script that shows version
RUN echo '#!/bin/bash\n\
echo "================================="\n\
echo "better-ccflare Docker Container"\n\
echo "================================="\n\
echo "Architecture: $(uname -m)"\n\
echo ""\n\
/usr/local/bin/better-ccflare --version\n\
echo "================================="\n\
echo ""\n\
exec /usr/local/bin/better-ccflare "$@"\n\
' > /usr/local/bin/entrypoint.sh && chmod +x /usr/local/bin/entrypoint.sh

# Switch to non-root user
USER ccflare

# Add volume mount for persistent data only
VOLUME ["/data"]

# Use the startup script as entrypoint
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--serve", "--port", "8080"]
