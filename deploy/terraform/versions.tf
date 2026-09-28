terraform {
  required_version = ">= 1.9"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.14"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.10"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
  }

  # Bucket is passed at init time: terraform init -backend-config="bucket=<project>-tfstate" (see ../tf.sh).
  backend "gcs" {
    prefix = "eodview/prod"
  }
}

# Credentials: ../tf.sh exports GOOGLE_OAUTH_ACCESS_TOKEN for the personal account and CLOUDFLARE_API_TOKEN.
provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}

provider "cloudflare" {}
