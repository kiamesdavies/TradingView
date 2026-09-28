resource "google_service_account" "host" {
  account_id   = "${var.name}-host"
  display_name = "EODView host"
}

resource "google_project_iam_member" "host_observability" {
  for_each = toset(["roles/logging.logWriter", "roles/monitoring.metricWriter"])
  project  = var.project_id
  role     = each.value
  member   = "serviceAccount:${google_service_account.host.email}"
}

resource "google_artifact_registry_repository_iam_member" "host_pull" {
  location   = google_artifact_registry_repository.app.location
  repository = google_artifact_registry_repository.app.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.host.email}"
}

resource "google_compute_instance_iam_member" "admin_login" {
  zone          = var.zone
  instance_name = google_compute_instance.host.name
  role          = "roles/compute.osAdminLogin"
  member        = "user:${var.admin_user}"
}

resource "google_project_iam_member" "admin_iap" {
  project = var.project_id
  role    = "roles/iap.tunnelResourceAccessor"
  member  = "user:${var.admin_user}"
}

resource "google_compute_instance" "host" {
  name                      = var.name
  machine_type              = var.machine_type
  zone                      = var.zone
  allow_stopping_for_update = true
  tags                      = [var.name]

  labels = {
    app        = "eodview"
    managed_by = "terraform"
  }

  boot_disk {
    auto_delete = false # keep the SQLite data if the VM is recreated

    initialize_params {
      image = "projects/debian-cloud/global/images/family/debian-12"
      size  = var.boot_disk_size_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.main.self_link
    # no access_config: no public IP; egress via Cloud NAT
  }

  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
  }

  metadata_startup_script = templatefile("${path.module}/startup.sh.tftpl", {
    registry = "${var.region}-docker.pkg.dev"
  })

  service_account {
    email  = google_service_account.host.email
    scopes = ["cloud-platform"] # access is limited by the IAM grants above
  }

  scheduling {
    automatic_restart   = true
    on_host_maintenance = "MIGRATE"
    preemptible         = false
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # The startup script needs NAT for apt/docker downloads.
  depends_on = [google_project_iam_member.host_observability, google_compute_router_nat.main]
}

resource "google_compute_resource_policy" "daily_snapshots" {
  name   = "${var.name}-daily-snapshots"
  region = var.region

  snapshot_schedule_policy {
    schedule {
      daily_schedule {
        days_in_cycle = 1
        start_time    = "03:00"
      }
    }
    retention_policy {
      max_retention_days    = 14
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }
    snapshot_properties {
      guest_flush       = false
      storage_locations = ["eu"]
      labels            = { app = "eodview" }
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "daily_snapshots" {
  name = google_compute_resource_policy.daily_snapshots.name
  disk = google_compute_instance.host.name
  zone = var.zone
}
