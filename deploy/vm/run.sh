#!/bin/bash
# Usage: run.sh <image-ref>. Pulls secrets from Secret Manager, writes env files, (re)starts the stack.
set -euo pipefail
IMAGE="${1:?image ref required}"
HOSTNAME_PUBLIC="$(cat /opt/eodview/HOSTNAME)"
cd /opt/eodview

secret() { gcloud secrets versions access latest --secret="$1" --quiet; }

umask 077
{
  echo "EODHD_API_KEY=$(secret eodhd-api-key)"
  echo "EODVIEW_ADMIN_TOKEN=$(secret eodview-admin-token)"
  echo "EODVIEW_API_REQUIRE_TOKEN=1"
  echo "EODVIEW_ALLOWED_ORIGINS=https://${HOSTNAME_PUBLIC}"
  if [ -f /opt/eodview/deploy.env ]; then cat /opt/eodview/deploy.env; fi   # non-secret info for Settings
  if [ -f /opt/eodview/app.env ]; then cat /opt/eodview/app.env; fi   # optional overrides, e.g. EODVIEW_MARKETS
} > .env.app.tmp && mv .env.app.tmp .env.app
echo "TUNNEL_TOKEN=$(secret cloudflared-tunnel-token)" > .env.tunnel.tmp && mv .env.tunnel.tmp .env.tunnel

echo "$IMAGE" > IMAGE
export IMAGE
docker compose pull --quiet
docker compose up -d --remove-orphans
docker image prune -f >/dev/null
docker compose ps
