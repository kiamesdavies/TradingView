data "cloudflare_zone" "main" {
  filter = {
    name = var.cloudflare_zone_name
  }
}

locals {
  cf_account_id = data.cloudflare_zone.main.account.id
}

# ---- Tunnel: cloudflared on the VM dials out; no inbound ports on the VM.

resource "random_bytes" "tunnel_secret" {
  length = 32
}

resource "cloudflare_zero_trust_tunnel_cloudflared" "eodview" {
  account_id    = local.cf_account_id
  name          = var.name
  config_src    = "cloudflare"
  tunnel_secret = random_bytes.tunnel_secret.base64
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "eodview" {
  account_id = local.cf_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.eodview.id

  config = {
    ingress = [
      {
        hostname = var.hostname
        service  = "http://app:3001" # compose service name on the VM
      },
      {
        service = "http_status:404"
      },
    ]
  }
}

data "cloudflare_zero_trust_tunnel_cloudflared_token" "eodview" {
  account_id = local.cf_account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.eodview.id
}

resource "cloudflare_dns_record" "eodview" {
  zone_id = data.cloudflare_zone.main.id
  name    = var.hostname
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.eodview.id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "EODView via Cloudflare Tunnel (managed by Terraform)"
}

# ---- Access: the app has no login of its own, so nothing reaches it without passing Access.

resource "cloudflare_zero_trust_access_policy" "owner" {
  account_id = local.cf_account_id
  name       = "${var.name}-owner"
  decision   = "allow"
  include    = [for e in var.access_emails : { email = { email = e } }]
}

# Agents (Claude Code MCP, scripts) authenticate with this service token
# (CF-Access-Client-Id / CF-Access-Client-Secret headers) plus an EODView bearer token.
resource "cloudflare_zero_trust_access_service_token" "agents" {
  account_id = local.cf_account_id
  name       = "${var.name}-agents"
  duration   = "8760h"
}

resource "cloudflare_zero_trust_access_policy" "agents" {
  account_id = local.cf_account_id
  name       = "${var.name}-agents"
  decision   = "non_identity"
  include    = [{ service_token = { token_id = cloudflare_zero_trust_access_service_token.agents.id } }]
}

resource "cloudflare_zero_trust_access_application" "site" {
  account_id       = local.cf_account_id
  name             = "EODView"
  type             = "self_hosted"
  session_duration = "720h"
  destinations     = [{ type = "public", uri = var.hostname }]
  policies         = [{ id = cloudflare_zero_trust_access_policy.owner.id, precedence = 1 }]
}

# More specific paths win in Access, so agent endpoints also accept the service token.
resource "cloudflare_zero_trust_access_application" "agent_api" {
  account_id       = local.cf_account_id
  name             = "EODView agent API"
  type             = "self_hosted"
  session_duration = "24h"
  destinations = [
    { type = "public", uri = "${var.hostname}/api/v1" },
    { type = "public", uri = "${var.hostname}/mcp" },
  ]
  policies = [
    { id = cloudflare_zero_trust_access_policy.agents.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.owner.id, precedence = 2 },
  ]
}
