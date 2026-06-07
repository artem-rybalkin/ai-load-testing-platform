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
