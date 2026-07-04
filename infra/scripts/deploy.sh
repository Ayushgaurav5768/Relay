#!/usr/bin/env bash
# =============================================================================
# Relay — Deploy Script
# =============================================================================
# Usage:
#   bash infra/scripts/deploy.sh [environment]
#
# Environment controls which .env file is loaded (default: production).
#   production  → .env.production
#   staging     → .env.staging
#   development → .env.development
#
# What it does:
#   1. Sources environment-specific env file
#   2. Generates self-signed TLS certs if missing (local demo)
#   3. Pulls images from GHCR (or builds if IMAGE_TAG=local)
#   4. Run database migrations
#   5. Starts the full production stack via docker-compose.prod.yml
#   6. Performs a health check against the HTTPS endpoint
#
# Secrets injection: ALL secrets come from environment variables /
#   .env file. No secrets are baked into Docker images.
#   For cloud deployments, inject secrets via your orchestrator
#   (e.g., docker secret, k8s secret, AWS Secrets Manager → env vars).
# =============================================================================

set -euo pipefail

# ── Config ──────────────────────────────────────────────────────────────────
ENV="${1:-production}"
COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.${ENV}"
CERTS_DIR="infra/nginx/certs"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cd "$PROJECT_ROOT"

echo "=== Relay Deploy [${ENV}] ==="

# ── 1. Load environment ────────────────────────────────────────────────────
if [ -f "$ENV_FILE" ]; then
  echo "Loading $ENV_FILE"
  set -a
  source "$ENV_FILE"
  set +a
else
  echo "⚠ No $ENV_FILE found — relying on pre-set environment variables"
fi

# Validate required vars
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${RABBITMQ_PASSWORD:?RABBITMQ_PASSWORD is required}"
: "${INGEST_HMAC_SECRET:?INGEST_HMAC_SECRET is required}"
: "${INGEST_API_KEYS:?INGEST_API_KEYS is required}"
: "${DELIVERY_HMAC_SECRET:?DELIVERY_HMAC_SECRET is required}"

# ── 2. TLS certificates (self-signed for local demo) ────────────────────────
#
# For production deployments, replace these with Let's Encrypt certificates
# (via certbot) or your CA-signed certificates:
#   certbot certonly --standalone -d yourdomain.com
#   cp /etc/letsencrypt/live/yourdomain.com/fullchain.pem "$CERTS_DIR/server.crt"
#   cp /etc/letsencrypt/live/yourdomain.com/privkey.pem   "$CERTS_DIR/server.key"
#
mkdir -p "$CERTS_DIR"

if [ ! -f "$CERTS_DIR/server.crt" ]; then
  echo "Generating self-signed TLS certificate (local demo)"
  openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout "$CERTS_DIR/server.key" \
    -out "$CERTS_DIR/server.crt" \
    -subj "/CN=localhost/O=Relay Development" 2>/dev/null
  echo "  → $CERTS_DIR/server.crt"
  echo "  → $CERTS_DIR/server.key"
fi

# ── 3. Pull / build images ─────────────────────────────────────────────────
if [ "${IMAGE_TAG:-latest}" = "local" ]; then
  echo "Building images locally (IMAGE_TAG=local)"
  docker compose -f "$COMPOSE_FILE" build
else
  echo "Pulling images from GHCR"
  docker compose -f "$COMPOSE_FILE" pull
fi

# ── 4. Database migrations ─────────────────────────────────────────────────
echo "Running database migrations..."
docker compose -f "$COMPOSE_FILE" run --rm \
  -e PGPASSWORD="$PGPASSWORD" \
  ingest node scripts/migrate.js

# ── 5. Start stack ────────────────────────────────────────────────────────
echo "Starting production stack..."
docker compose -f "$COMPOSE_FILE" up -d

# ── 6. Health check ───────────────────────────────────────────────────────
echo "Waiting for services to be healthy..."
HEALTH_URL="https://localhost/api/health"
MAX_RETRIES=30
for i in $(seq 1 $MAX_RETRIES); do
  if curl -skf "$HEALTH_URL" > /dev/null 2>&1; then
    echo "✓ Stack is healthy — https://localhost/"
    docker compose -f "$COMPOSE_FILE" ps
    exit 0
  fi
  echo "  Waiting... ($i/$MAX_RETRIES)"
  sleep 3
done

echo "✗ Health check timed out after $MAX_RETRIES attempts"
docker compose -f "$COMPOSE_FILE" logs --tail=20
exit 1
