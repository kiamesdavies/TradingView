#!/bin/bash
# One-time: create the personal GCP project, link billing, enable APIs, create the Terraform state bucket.
# Usage: deploy/bootstrap.sh <project-id> <billing-account-id>
set -euo pipefail
PROJECT="${1:?project id}"
BILLING="${2:?billing account id}"
ACCOUNT="${GCP_ACCOUNT:-you@example.com}"
REGION="${REGION:-europe-west1}"
g() { gcloud --account="$ACCOUNT" "$@"; }

if ! g projects describe "$PROJECT" >/dev/null 2>&1; then
  g projects create "$PROJECT" --name="EODView"
fi
g billing projects link "$PROJECT" --billing-account="$BILLING"
g services enable --project="$PROJECT" \
  compute.googleapis.com iap.googleapis.com oslogin.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com \
  logging.googleapis.com monitoring.googleapis.com cloudresourcemanager.googleapis.com

BUCKET="gs://${PROJECT}-tfstate"
if ! g storage buckets describe "$BUCKET" >/dev/null 2>&1; then
  g storage buckets create "$BUCKET" --project="$PROJECT" --location="$REGION" \
    --uniform-bucket-level-access --public-access-prevention
  g storage buckets update "$BUCKET" --versioning
fi
echo "Project $PROJECT ready; state bucket $BUCKET"
