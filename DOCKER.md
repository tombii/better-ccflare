# Docker Deployment Guide

This guide covers how to use better-ccflare with Docker for easy deployment across multiple architectures.

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Pull and start the container
docker-compose up -d

# View logs
docker-compose logs -f

# Stop the container
docker-compose down
```

### Using Docker CLI

```bash
# Pull the latest image
docker pull ghcr.io/tombii/better-ccflare:latest

# Run the container
docker run -d \
  --name better-ccflare \
  -p 8080:8080 \
  -v better-ccflare-data:/data \
  ghcr.io/tombii/better-ccflare:latest
```

## Supported Architectures

The Docker images support the following platforms:
- `linux/amd64` (x86_64)
- `linux/arm64` (ARM64/aarch64)

Docker will automatically pull the correct image for your architecture.

## Configuration

### Environment Variables

- `BETTER_CCFLARE_DB_PATH` - Database file path (default: `/data/better-ccflare.db`)
- `NODE_ENV` - Environment mode (default: `production`)
- `LOG_LEVEL` - Logging level (optional)
- `PORT` - Server port (default: `8080`)
- `SSL_KEY_PATH` - SSL private key path (for HTTPS)
- `SSL_CERT_PATH` - SSL certificate path (for HTTPS)
- `LB_STRATEGY` - Load balancing strategy (default: `session`)

### Using .env Files

better-ccflare Docker containers now support `.env` files for easy configuration management:

#### Docker Compose (Recommended)

Create a `.env` file in the same directory as your `docker-compose.yml`:

```bash
# Copy the example .env file
curl -O https://raw.githubusercontent.com/tombii/better-ccflare/main/.env.example
mv .env.example .env

# Edit with your configuration
nano .env
```

Docker Compose will automatically load the `.env` file and pass the environment variables to the container.

#### Docker CLI

You can mount a `.env` file into the container:

```bash
docker run -d \
  --name better-ccflare \
  -p 8080:8080 \
  -v better-ccflare-data:/data \
  -v $(pwd)/.env:/app/.env:ro \
  ghcr.io/tombii/better-ccflare:latest
```

**Example `.env` file**:
```bash
# Server Configuration
PORT=8080

# SSL/TLS Configuration (optional)
SSL_KEY_PATH=/path/to/ssl/key.pem
SSL_CERT_PATH=/path/to/ssl/cert.pem

# Load Balancing
LB_STRATEGY=session

# Logging and Debugging
LOG_LEVEL=INFO
LOG_FORMAT=pretty

# Database configuration
DATA_RETENTION_DAYS=7
REQUEST_RETENTION_DAYS=365
```

### Volume Mounts

The container uses `/data` for persistent storage. Mount this volume to persist your database:

```bash
docker run -v /path/on/host:/data ghcr.io/tombii/better-ccflare:latest
```

Or with docker-compose (already configured):

```yaml
volumes:
  - better-ccflare-data:/data
```

## Managing Accounts

### Interactive Mode

```bash
# Add an account
docker exec -it better-ccflare better-ccflare --add-account myaccount --mode claude-oauth --priority 0

# List accounts
docker exec -it better-ccflare better-ccflare --list

# Remove an account
docker exec -it better-ccflare better-ccflare --remove myaccount

# Set priority
docker exec -it better-ccflare better-ccflare --set-priority myaccount 5
```

### Using Volume Mount

Alternatively, you can manage accounts by mounting your existing database:

```bash
docker run -v ~/.config/better-ccflare:/data ghcr.io/tombii/better-ccflare:latest
```

## Building Your Own Images

### Local Build

```bash
# Build for your current architecture
docker build -t better-ccflare:local .

# Run your local build
docker run -p 8080:8080 better-ccflare:local
```

### Multi-Architecture Build

To build for multiple architectures, use Docker Buildx:

```bash
# Create a new builder instance
docker buildx create --name multiarch --use

# Build and push for multiple architectures
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag ghcr.io/tombii/better-ccflare:latest \
  --push \
  .
```

## Automated Builds

The repository includes a GitHub Actions workflow that automatically builds and publishes Docker images to GitHub Container Registry (ghcr.io) when you:

1. Push to the `main` branch
2. Create a new tag (e.g., `v1.2.28`)
3. Manually trigger the workflow

### Available Tags

- `latest` - Latest build from main branch
- `v1.2.28` - Specific version tags
- `main-sha-abc123` - Commit SHA tags
- `1.2` - Major.minor version tags
- `1` - Major version tags

## Publishing to Docker Hub (Optional)

To also publish to Docker Hub, add these secrets to your GitHub repository:

1. Go to Settings → Secrets and variables → Actions
2. Add `DOCKERHUB_USERNAME` - Your Docker Hub username
3. Add `DOCKERHUB_TOKEN` - Your Docker Hub access token

The workflow will automatically push to both registries.

## Health Checks

The container includes a health check that runs every 30 seconds:

```bash
# Check container health
docker ps

# View health check logs
docker inspect --format='{{json .State.Health}}' better-ccflare
```

## Troubleshooting

### Container won't start

Check logs:
```bash
docker logs better-ccflare
```

### Database permissions

Ensure the volume has correct permissions:
```bash
docker exec better-ccflare ls -la /data
```

### Port conflicts

If port 8080 is in use, change the host port:
```bash
docker run -p 8081:8080 ghcr.io/tombii/better-ccflare:latest
```

Or in docker-compose.yml:
```yaml
ports:
  - "8081:8080"
```

### Accessing the dashboard

Once running, access the dashboard at:
- `http://localhost:8080` - Web dashboard
- `http://localhost:8080/health` - Health check endpoint

## Resource Limits

The docker-compose.yml includes resource limits. Adjust as needed:

```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 1G
    reservations:
      cpus: '0.5'
      memory: 256M
```

## Production Deployment

### Using Docker Compose in Production

```bash
# Start in detached mode
docker-compose up -d

# View logs
docker-compose logs -f

# Update to latest version
docker-compose pull
docker-compose up -d

# Backup database
docker cp better-ccflare:/data/better-ccflare.db ./backup-$(date +%Y%m%d).db
```

### Using Orchestration Tools

For production deployments with Kubernetes, see the example manifests in the `/k8s` directory (if available) or adapt the docker-compose.yml to your orchestration tool of choice.

## Security Considerations

1. **Network Security**: Use a reverse proxy (nginx, traefik) with TLS
2. **Database Backups**: Regularly backup the `/data` volume
3. **Updates**: Keep the image updated with `docker-compose pull`
4. **Access Control**: Restrict access to the container's ports using firewall rules

## Next Steps

- Configure your accounts using `docker exec -it better-ccflare better-ccflare --add-account <name> --mode <mode> --priority <number>`
- Access the web dashboard at `http://localhost:8080`
- Monitor logs with `docker-compose logs -f`
- Set up automated backups of the `/data` volume
