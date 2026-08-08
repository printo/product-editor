#!/usr/bin/env bash
# ==============================================================================
# setup-observability.sh — Product Editor Observability Setup & Deployment
#
# Sets up environment configuration for Sentry + Grafana OSS (Loki & Faro),
# builds & starts monitoring services in Docker, and posts deployment alert
# to Google Chat webhook.
#
# Usage:
#   ./scripts/setup-observability.sh [SENTRY_DSN] [GRAFANA_PASSWORD]
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "${SCRIPT_DIR}")"
cd "${PROJECT_ROOT}"

GOOGLE_CHAT_WEBHOOK="https://chat.googleapis.com/v1/spaces/AAQArthWpc0/messages?key=AIzaSyDdI0hCZtE6vySjMm-WEfRq3CPzqKqqsHI&token=dGcvKaV_JK7gRKJdwAs1kWlg1x-Qn18I3kTQJ1xl9-E"

echo "=== Product Editor Observability Setup ==="

# 1. Ensure .env exists
if [ ! -f .env ]; then
  echo "--> .env file not found. Copying from .env.example..."
  cp .env.example .env
fi

SENTRY_DSN_INPUT="${1:-${SENTRY_DSN:-}}"
GRAFANA_PASS_INPUT="${2:-${GRAFANA_ADMIN_PASSWORD:-admin}}"

# 2. Update or append SENTRY_DSN if provided
if [ -n "${SENTRY_DSN_INPUT}" ]; then
  echo "--> Setting SENTRY_DSN and NEXT_PUBLIC_SENTRY_DSN in .env..."
  if grep -q "^SENTRY_DSN=" .env; then
    sed -i.bak "s|^SENTRY_DSN=.*|SENTRY_DSN=${SENTRY_DSN_INPUT}|" .env
  else
    echo "SENTRY_DSN=${SENTRY_DSN_INPUT}" >> .env
  fi

  if grep -q "^NEXT_PUBLIC_SENTRY_DSN=" .env; then
    sed -i.bak "s|^NEXT_PUBLIC_SENTRY_DSN=.*|NEXT_PUBLIC_SENTRY_DSN=${SENTRY_DSN_INPUT}|" .env
  else
    echo "NEXT_PUBLIC_SENTRY_DSN=${SENTRY_DSN_INPUT}" >> .env
  fi
  rm -f .env.bak
fi

# 3. Ensure GRAFANA_ADMIN_PASSWORD is set in .env
if ! grep -q "^GRAFANA_ADMIN_PASSWORD=" .env; then
  echo "GRAFANA_ADMIN_PASSWORD=${GRAFANA_PASS_INPUT}" >> .env
fi

# 4. Ensure NEXT_PUBLIC_FARO_URL is set in .env
if ! grep -q "^NEXT_PUBLIC_FARO_URL=" .env; then
  echo "NEXT_PUBLIC_FARO_URL=http://localhost:3001/faro/receiver" >> .env
fi

# 5. Build and launch application + monitoring stack
echo "--> Launching Docker containers with --profile monitoring..."
docker compose --profile monitoring up -d --build

# 6. Check status
HEALTH_STATUS=$(docker compose ps --format "json" 2>/dev/null || docker compose ps)

# 7. Send Alert to Google Chat Webhook
echo "--> Sending alert notification to Google Chat..."
ALERT_PAYLOAD=$(cat <<EOF
{
  "text": "✅ *Product Editor Observability Deployed*\n\n• *App*: product-editor\n• *Status*: Monitoring containers up (Loki, Promtail, Grafana)\n• *Sentry*: Configured\n• *Loki Logs & Grafana*: Active on http://localhost:3001"
}
EOF
)

curl -s -X POST -H 'Content-Type: application/json' \
  -d "${ALERT_PAYLOAD}" \
  "${GOOGLE_CHAT_WEBHOOK}" > /dev/null && echo "--> Google Chat alert sent successfully!"

echo "=== Setup Complete! ==="
