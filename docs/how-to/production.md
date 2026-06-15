# Production Deployment

This guide covers deploying the platform to a cloud server with automatic HTTPS via Caddy.

---

## Overview

Production uses Caddy as a reverse proxy with automatic TLS certificates from Let's Encrypt. All internal services are hidden behind Caddy — only ports 80 and 443 are exposed to the internet.

```
Internet
   │
   ▼
Caddy :80/:443
   ├── yourdomain.com      → ui:3006
   ├── api.yourdomain.com  → api-service:3000
   └── data.yourdomain.com → results-service:3004
```

---

## Prerequisites

- A Linux server (Ubuntu 22.04 / Debian 12 recommended)
- Docker Engine 24+ and Docker Compose v2
- A domain name with DNS access
- Ports 80 and 443 open in your firewall

---

## Step 1 — DNS

Create three A records pointing to your server's public IP:

| Hostname | Type | Value |
|----------|------|-------|
| `yourdomain.com` | A | `<server-ip>` |
| `api.yourdomain.com` | A | `<server-ip>` |
| `data.yourdomain.com` | A | `<server-ip>` |

DNS propagation takes a few minutes. Verify with:
```bash
dig +short yourdomain.com
dig +short api.yourdomain.com
dig +short data.yourdomain.com
```

All three should return your server IP.

---

## Step 2 — Server setup

```bash
# Clone the repository
git clone https://github.com/youruser/ai-load-testing-platform.git
cd ai-load-testing-platform

# Install Docker (Ubuntu)
curl -fsSL https://get.docker.com | sh
```

---

## Step 3 — Configure environment

Create a `.env` file:

```bash
# Required
GEMINI_API_KEY=AIza...

# Domain
DOMAIN=yourdomain.com

# Security — generate strong random keys
API_KEYS=key1,key2     # comma-separated; UI uses the first one
API_KEY=key1

# CORS — match your domain
ALLOWED_ORIGIN=https://yourdomain.com
```

Generate a strong random API key:
```bash
openssl rand -hex 32
```

---

## Step 4 — Deploy

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

This starts all services plus Caddy. Caddy will:
1. Contact Let's Encrypt to issue TLS certificates for all three subdomains
2. Store certificates in the `caddy_data` Docker volume (survives restarts)
3. Automatically renew certificates before they expire

Watch Caddy logs to confirm certificate issuance:
```bash
docker compose logs -f caddy
```

You should see: `certificate obtained successfully` for each subdomain.

---

## Step 5 — Verify

```bash
# UI
curl -I https://yourdomain.com

# API
curl https://api.yourdomain.com/health

# Results API (with auth key)
curl -H "X-API-Key: key1" https://data.yourdomain.com/results
```

---

## Production Compose changes

The `docker-compose.prod.yml` overlay applies:

| Change | Reason |
|--------|--------|
| Caddy service added | Automatic HTTPS, reverse proxy |
| `postgres` port removed | Never expose DB to internet |
| `redis` port removed | Never expose Redis to internet |
| `rabbitmq` ports removed | Never expose RabbitMQ to internet |
| Worker ports removed | Internal only |
| Service ports (3000/3004/3006) removed | Traffic routes through Caddy only |
| CPU/memory limits added | Prevent any service from starving others |

Resource limits:

| Service | Memory | CPU |
|---------|--------|-----|
| worker-backend | 1 GB | 1.0 core |
| worker-client | 1 GB | 1.0 core |
| ai-service | 512 MB | 0.5 core |
| results-service | 512 MB | 0.5 core |
| api-service | 256 MB | 0.5 core |
| ui | 512 MB | 0.5 core |

---

## Security checklist

Before going public, verify:

- [ ] `GEMINI_API_KEY` is rotated (never commit `.env`)
- [ ] `API_KEYS` contains strong random keys (not default values)
- [ ] `ALLOWED_ORIGIN` is set to `https://yourdomain.com` (not `*`)
- [ ] `.env` is in `.gitignore` (already is)
- [ ] PostgreSQL and RabbitMQ ports are not exposed (prod compose removes them)
- [ ] Firewall allows only 80, 443, and SSH
- [ ] Server has automatic security updates enabled
- [ ] PostgreSQL/RabbitMQ data volumes are on encrypted storage (see "Encryption at rest" below)

---

## Firewall (Ubuntu/ufw)

```bash
ufw allow ssh
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

---

## Updating

```bash
git pull
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Docker Compose recreates only services whose images changed. Zero-downtime for stateless services (api-service, ai-service, workers). The results-service applies DB migrations on startup.

---

## Encryption at rest

`test_results`, `test_scripts`, `users`, and recorded flow steps (`steps` JSONB) contain target URLs, generated scripts, request/response bodies, and credentials — all stored as plaintext in the `postgres` data volume. If your deployment has compliance requirements (GDPR, SOC 2, customer contracts), encrypt the underlying storage.

### Recommended: volume / disk-level encryption

Encrypt the entire `postgres_data` Docker volume (and any host disk it lives on) rather than individual columns. This protects all data uniformly with no application changes, no query-pattern restrictions, and no key-management code to maintain.

- **Cloud-managed databases** (RDS, Cloud SQL, Azure Database for PostgreSQL): enable "encryption at rest" when provisioning — it's a checkbox, AES-256, fully transparent. Prefer this if you're not self-hosting Postgres.
- **Self-hosted on a cloud VM**: most providers offer encrypted block storage by default or as an option (AWS EBS encryption, GCP Persistent Disk CMEK, Azure Disk Encryption). Enable it on the volume backing `/var/lib/docker/volumes`.
- **Bare-metal / on-prem Linux host**: use LUKS/dm-crypt on the partition that holds the Docker data root:
  ```bash
  # one-time setup before `docker compose up` is ever run on this host
  cryptsetup luksFormat /dev/sdb1
  cryptsetup luksOpen /dev/sdb1 docker-data
  mkfs.ext4 /dev/mapper/docker-data
  mount /dev/mapper/docker-data /var/lib/docker
  ```
  The volume must be unlocked (passphrase or keyfile) on boot — plan for unattended unlock (TPM-bound key, cloud KMS-backed keyfile) if the server reboots without an operator present.

### Why not column-level encryption (`pgcrypto`)

`pgcrypto` (`pgp_sym_encrypt`/`pgp_sym_decrypt`) was considered for `test_results.metrics`, `test_scripts.script`, and `test_results.target_url`, but rejected for now:

- **Breaks indexed lookups** — `test_scripts` is looked up by `UNIQUE(target_url, test_type)` and `test_results` is filtered/sorted by `target_url`, `status`, `created_at` for the trend chart and results list. Encrypted columns can't be indexed or compared with `=`/`ORDER BY` without decrypting every row.
- **Breaks JSONB queries** — `metrics`, `steps`, and `analysis` are JSONB and read with `->`/`->>` operators throughout `results-service`, `analyzer.ts`, and the AI insight prompts. Encrypting the whole JSONB blob means every read path needs an encrypt/decrypt step, and partial-field access (e.g. `metrics->>'p95ResponseTime'`) becomes impossible without decrypting first.
- **Key management** — `pgcrypto` needs the encryption key reachable by the app at query time, which (without an external KMS/HSM) usually means storing it in the same env-var surface as `DATABASE_URL` — protecting against the same threat model as disk encryption, but with more code and a performance cost on every row.

Volume-level encryption covers the actual threat (a stolen disk, snapshot, or backup file) without any of the above tradeoffs. If a future requirement needs *field-level* encryption (e.g. a specific PII field that must stay encrypted even from DB admins), revisit `pgcrypto` for that single column only — not as a blanket policy.

### Also encrypt

- **Backups** — `pg_dump` output is plaintext; encrypt backup files at rest (`gpg -c backup.sql` or your cloud provider's encrypted snapshot/object-storage option)
- **RabbitMQ persistence** (`rabbitmq_data` volume) — test payloads and generated scripts transit through queues and are persisted to disk (see Architecture Improvements → RabbitMQ persistence); covered by the same volume encryption
- **`.env`** — contains `GEMINI_API_KEY`, `SESSION_SECRET`, `INTERNAL_API_KEY`; never committed, but also benefits from disk encryption at rest

---

## Backup

Backup the PostgreSQL database:

```bash
# Dump
docker compose exec postgres pg_dump -U alt_user alt_db > backup-$(date +%Y%m%d).sql

# Restore
docker compose exec -T postgres psql -U alt_user alt_db < backup-20240115.sql
```

TLS certificates are in the `caddy_data` volume — they auto-renew, so backups are optional.

---

## Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f results-service

# Last 100 lines
docker compose logs --tail=100 worker-backend
```

All services use structured JSON logging (Pino). Parse with `jq`:

```bash
docker compose logs results-service 2>&1 | grep '"level":50' | jq .
```

---

## Horizontal scaling

For higher throughput, run multiple worker replicas:

```bash
# In docker-compose.prod.yml, add replicas:
worker-backend:
  deploy:
    replicas: 3
    resources:
      limits:
        memory: 1G
        cpus: '1.0'
```

Or use `--scale` on the command line:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --scale worker-backend=3
```

---

## Monitoring

The system health endpoint provides a quick overview:

```bash
curl -H "X-API-Key: key1" https://data.yourdomain.com/system/health | jq .
```

Worker services report CPU%, memory, and active test counts in their health response. The UI dashboard shows this in the **Worker Health** panel.

For more detailed monitoring, consider:
- **Grafana + Prometheus** — scrape the health endpoints
- **Datadog / New Relic** — agent on the host
- **Uptime monitoring** — check `https://api.yourdomain.com/health` every minute

---

## Troubleshooting

**Caddy fails to get TLS certificate:**
- DNS must resolve before Caddy starts. Check `dig +short yourdomain.com`
- Let's Encrypt rate-limits failed attempts. Wait an hour and retry
- Check `docker compose logs caddy` for the specific error

**Services not starting:**
- Check for missing env vars: `docker compose logs api-service | grep Error`
- Verify PostgreSQL and RabbitMQ are healthy: `docker compose ps`

**API returns 401:**
- Include `X-API-Key: <key>` in every request
- Verify the key matches one in `API_KEYS`

**Tests not completing:**
- `docker compose logs worker-backend` — look for k6 errors
- Check the system health: `curl https://data.yourdomain.com/system/health`
