variable "project_id" {
  description = "Personal GCP project that hosts EODView (created by ../bootstrap.sh)."
  type        = string
}

variable "region" {
  type    = string
  default = "europe-west1"
}

variable "zone" {
  type    = string
  default = "europe-west1-b"
}

variable "name" {
  description = "Stable name for the VM and its supporting resources."
  type        = string
  default     = "eodview"
}

variable "machine_type" {
  description = "Bun server + SQLite universe DB for ~17k symbols fits comfortably in 4 GB."
  type        = string
  default     = "e2-medium"
}

variable "boot_disk_size_gb" {
  description = "Docker images, logs and the SQLite database (a few GB)."
  type        = number
  default     = 40
}

variable "admin_user" {
  description = "Google identity allowed to administer the VM through OS Login and IAP (TF_VAR_admin_user)."
  type        = string
}

variable "hostname" {
  description = "Public hostname for EODView, e.g. charts.example.com. Must be in cloudflare_zone_name."
  type        = string
}

variable "cloudflare_zone_name" {
  description = "Cloudflare zone (apex domain) that holds the hostname, e.g. example.com."
  type        = string
}

variable "access_emails" {
  description = "Emails allowed through Cloudflare Access (TF_VAR_access_emails, e.g. [\"you@example.com\"])."
  type        = list(string)
}
