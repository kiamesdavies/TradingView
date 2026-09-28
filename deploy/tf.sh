#!/bin/bash
# Terraform wrapper: personal GCP account token + Cloudflare token, without touching global gcloud/ADC config.
# Needs deploy/.env.local with PROJECT_ID, CLOUDFLARE_API_TOKEN, TF_VAR_hostname, TF_VAR_cloudflare_zone_name.
# Usage: deploy/tf.sh init | plan | apply | output ...
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; . "$DIR/.env.local"; set +a
ACCOUNT="${GCP_ACCOUNT:?set GCP_ACCOUNT (your Google account) in deploy/.env.local}"
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token --account="$ACCOUNT")"
export TF_VAR_project_id="$PROJECT_ID"
cd "$DIR/terraform"
if [ "${1:-}" = "init" ]; then
  shift
  exec terraform init -backend-config="bucket=${PROJECT_ID}-tfstate" "$@"
fi
exec terraform "$@"
