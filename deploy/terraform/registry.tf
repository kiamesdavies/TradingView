resource "google_artifact_registry_repository" "app" {
  location      = var.region
  repository_id = var.name
  format        = "DOCKER"
  description   = "EODView images (built by Cloud Build from ../deploy.sh)"

  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 10
    }
  }

  cleanup_policies {
    id     = "delete-old"
    action = "DELETE"
    condition {
      older_than = "2592000s"
    }
  }
}
