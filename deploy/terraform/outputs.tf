output "url" {
  value = "https://${var.hostname}"
}

output "instance_name" {
  value = google_compute_instance.host.name
}

output "zone" {
  value = var.zone
}

output "image_repository" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.app.repository_id}/app"
}

output "iap_ssh_command" {
  value = "gcloud compute ssh ${google_compute_instance.host.name} --project=${var.project_id} --zone=${var.zone} --tunnel-through-iap --account=${var.admin_user}"
}

output "agent_service_token_client_id" {
  value = cloudflare_zero_trust_access_service_token.agents.client_id
}

output "agent_service_token_client_secret" {
  value     = cloudflare_zero_trust_access_service_token.agents.client_secret
  sensitive = true
}
