# Deploying EODView to GCP

One small VM in a GCP project, reachable only through Cloudflare (Tunnel + Access). No public IP and no open
inbound ports.

```
browser / agent ──HTTPS──> Cloudflare Access ──> Cloudflare Tunnel ──(outbound from VM)──> cloudflared ──> app:3001
                                                                                            (docker compose on the VM)
```

- **VM**: `e2-medium` Debian 12, 40 GB balanced disk, no public IP (egress via Cloud NAT), Shielded VM, OS Login,
  SSH only through IAP, daily snapshots kept 14 days, boot disk kept if the VM is deleted.
- **App**: the `Dockerfile` at the repo root (Bun serves API, `/ws`, `/mcp` and the built client); SQLite data in
  `/opt/eodview/data` on the VM.
- **Secrets** (Secret Manager): `eodhd-api-key` (you add it), `eodview-admin-token` (generated),
  `cloudflared-tunnel-token` (from the tunnel). `vm/run.sh` writes them into env files at deploy/boot time.
- **Access**: the whole hostname requires your email login. `/api/v1` and `/mcp` also accept the agents' Cloudflare
  service token; the app additionally requires an EODView bearer token there (`EODVIEW_API_REQUIRE_TOKEN=1`).
  Every request arrives through the tunnel, so `/api/config` and the other admin routes need `EODVIEW_ADMIN_TOKEN`.
- **Cost**: roughly $25–30/month (VM ~$25, NAT ~$1 + traffic, disk + snapshots a few dollars). Cloudflare Tunnel
  and Access are free for this use.

## First deploy

```bash
# 0. config
cp deploy/.env.local.example deploy/.env.local   # fill in project, your Google account, hostname, zone, Cloudflare token

# 1. project, billing, APIs, state bucket (uses GCP_ACCOUNT from .env.local)
deploy/bootstrap.sh eodview-prod <billing-account-id>

# 2. infrastructure
deploy/tf.sh init
deploy/tf.sh plan -out=eodview.tfplan
deploy/tf.sh apply eodview.tfplan

# 3. the EODHD key (never stored in Terraform state)
printf '%s' "$EODHD_API_KEY" | gcloud secrets versions add eodhd-api-key --data-file=- \
  --project=eodview-prod --account=you@example.com

# 4. build + roll out (wait ~2 min after apply for the VM to install Docker)
deploy/deploy.sh
```

Later deploys: `deploy/deploy.sh` (image tag = git short SHA).

## Operating

```bash
deploy/tf.sh output iap_ssh_command        # SSH in
sudo docker compose -f /opt/eodview/compose.yaml logs -f app
gcloud secrets versions access latest --secret=eodview-admin-token --project=eodview-prod --account=you@example.com
```

- Settings in the UI asks for the admin token before it shows config or API tokens.
- Extra app settings (e.g. `EODVIEW_MARKETS=US,ST`, `EODVIEW_DAILY_CREDIT_BUDGET=30000`): put them in
  `/opt/eodview/app.env` on the VM and re-run `deploy/deploy.sh` (or `sudo /opt/eodview/run.sh "$(cat /opt/eodview/IMAGE)"`).
- Restore: create a disk from the latest `eodview-daily-snapshots` snapshot and swap it in.

## Agents (Claude Code / MCP)

```bash
deploy/tf.sh output agent_service_token_client_id
deploy/tf.sh output -raw agent_service_token_client_secret
# create an EODView token in Settings → API access (needs the admin token), then:
claude mcp add --transport http eodview https://<hostname>/mcp \
  --header "CF-Access-Client-Id: <id>" \
  --header "CF-Access-Client-Secret: <secret>" \
  --header "Authorization: Bearer <eodview token>"
```
