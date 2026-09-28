# EODHD key: the value is added outside Terraform so it never lands in state:
#   gcloud secrets versions add eodhd-api-key --data-file=- --project=<project>
resource "google_secret_manager_secret" "eodhd_api_key" {
  secret_id = "eodhd-api-key"
  replication {
    auto {}
  }
}

# Required for /api/config, /api/tokens and pipeline admin routes (every request arrives via the tunnel,
# so none of them count as loopback). Read it with: gcloud secrets versions access latest --secret=eodview-admin-token
resource "random_password" "admin_token" {
  length  = 40
  special = false
}

resource "google_secret_manager_secret" "admin_token" {
  secret_id = "eodview-admin-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "admin_token" {
  secret      = google_secret_manager_secret.admin_token.id
  secret_data = random_password.admin_token.result
}

resource "google_secret_manager_secret" "tunnel_token" {
  secret_id = "cloudflared-tunnel-token"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "tunnel_token" {
  secret      = google_secret_manager_secret.tunnel_token.id
  secret_data = data.cloudflare_zero_trust_tunnel_cloudflared_token.eodview.token
}

resource "google_secret_manager_secret_iam_member" "host_access" {
  for_each = {
    eodhd  = google_secret_manager_secret.eodhd_api_key.id
    admin  = google_secret_manager_secret.admin_token.id
    tunnel = google_secret_manager_secret.tunnel_token.id
  }
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.host.email}"
}
