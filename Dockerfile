# Simplified Dockerfile using pre-built binaries from GitHub Releases
# Supports: linux/amd64, linux/arm64

ARG VERSION=latest

FROM debian:trixie-slim

# Install required dependencies (and apply pending security updates, e.g. perl-base)
RUN apt-get update && \
    apt-get upgrade -y && \
    apt-get install -y --no-install-recommends \
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
    mkdir -p /usr/local/lib/better-ccflare && \
    echo "Downloading from: ${DOWNLOAD_URL}" && \
    curl -L -f -o /usr/local/lib/better-ccflare/better-ccflare "${DOWNLOAD_URL}" || (echo "Failed to download binary from ${DOWNLOAD_URL}"; exit 1) && \
    chmod +x /usr/local/lib/better-ccflare/better-ccflare && \
    echo "Binary downloaded successfully" && \
    file /usr/local/lib/better-ccflare/better-ccflare && \
    # amd64 also ships the baseline build for CPUs without AVX2. Only a confirmed 404 means
    # "older release without it"; network errors and other HTTP codes fail the build so a
    # published image never silently loses baseline support.
    if [ "${ARCH}" = "amd64" ]; then \
      BASELINE_HTTP=$(curl -L -sS --retry 3 --retry-delay 2 \
        -o /usr/local/lib/better-ccflare/better-ccflare-baseline \
        -w '%{http_code}' "${DOWNLOAD_URL}-baseline") || \
        { echo "Failed to download ${DOWNLOAD_URL}-baseline (network error)"; exit 1; }; \
      case "${BASELINE_HTTP}" in \
        200) chmod +x /usr/local/lib/better-ccflare/better-ccflare-baseline && \
             echo "Baseline binary downloaded successfully" ;; \
        404) rm -f /usr/local/lib/better-ccflare/better-ccflare-baseline && \
             echo "No baseline binary at ${DOWNLOAD_URL}-baseline (older release); CPUs without AVX2 are not supported by this image" ;; \
        *) echo "Unexpected HTTP ${BASELINE_HTTP} downloading ${DOWNLOAD_URL}-baseline"; exit 1 ;; \
      esac; \
    fi && \
    echo "==================================="

# Pick the baseline build at runtime when the CPU lacks AVX2 (the default x64 build dies with SIGILL)
RUN printf '%s\n' \
      '#!/bin/sh' \
      'BIN_DIR=/usr/local/lib/better-ccflare' \
      'if [ -x "$BIN_DIR/better-ccflare-baseline" ] && ! grep -qw avx2 /proc/cpuinfo; then' \
      '  exec "$BIN_DIR/better-ccflare-baseline" "$@"' \
      'fi' \
      'exec "$BIN_DIR/better-ccflare" "$@"' \
      > /usr/local/bin/better-ccflare && \
    chmod +x /usr/local/bin/better-ccflare

# Verify through the wrapper so the build host runs the binary its CPU supports (building on a
# CPU without AVX2 no longer dies on the default build); the baseline build runs on any x86-64,
# so it is always checked when present.
RUN /usr/local/bin/better-ccflare --version || \
      { echo "Binary verification failed: exec format error, or this CPU lacks AVX2 and the release has no baseline binary"; exit 1; } && \
    if [ -x /usr/local/lib/better-ccflare/better-ccflare-baseline ]; then \
      /usr/local/lib/better-ccflare/better-ccflare-baseline --version || \
        { echo "Baseline binary verification failed"; exit 1; }; \
    fi

# Create a non-root user to run the application
RUN useradd -r -u 1000 -m -s /bin/bash ccflare && \
    mkdir -p /data && \
    chown -R ccflare:ccflare /data /app

# Build provenance for the /health endpoint (packages/http-api/src/handlers/health.ts)
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ARG BUILD_DATE=unknown

# Set environment variables
ENV NODE_ENV=production
ENV BETTER_CCFLARE_DB_PATH=/data/better-ccflare.db
ENV XDG_CONFIG_HOME=/data
ENV BETTER_CCFLARE_LOG_DIR=/app/logs
ENV CCFLARE_VERSION=${VERSION}
ENV CCFLARE_GIT_SHA=${GIT_SHA}
ENV CCFLARE_GIT_REF=${GIT_REF}
ENV CCFLARE_BUILD_DATE=${BUILD_DATE}

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
