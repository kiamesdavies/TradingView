#!/bin/bash
# Build the image with Cloud Build, then roll it out on the VM over IAP SSH.
# Usage: deploy/deploy.sh [tag]   (default: git short SHA, "-dirty" if the tree has changes)
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
set -a; . "$DIR/.env.local"; set +a
ACCOUNT="${GCP_ACCOUNT:-you@example.com}"
REGION="${REGION:-europe-west1}"
ZONE="${ZONE:-europe-west1-b}"
VM="${VM_NAME:-eodview}"
TAG="${1:-$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet || echo -dirty)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/eodview/app:${TAG}"
g() { gcloud --account="$ACCOUNT" --project="$PROJECT_ID" "$@"; }

echo "==> building $IMAGE"
g builds submit "$ROOT" --tag="$IMAGE" --region="$REGION" --machine-type=e2-highcpu-8

echo "==> shipping compose files"
g compute scp --zone="$ZONE" --tunnel-through-iap "$DIR/vm/compose.yaml" "$DIR/vm/run.sh" "$VM":/tmp/
g compute ssh "$VM" --zone="$ZONE" --tunnel-through-iap --command "
  set -e
  sudo install -m 0640 /tmp/compose.yaml /opt/eodview/compose.yaml
  sudo install -m 0750 /tmp/run.sh /opt/eodview/run.sh
  echo '$TF_VAR_hostname' | sudo tee /opt/eodview/HOSTNAME >/dev/null
  sudo /opt/eodview/run.sh '$IMAGE'
"
echo "==> deployed $IMAGE to https://$TF_VAR_hostname"
