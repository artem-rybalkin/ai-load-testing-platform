# Configuration

All configuration is done via environment variables. In local dev, set them in the `.env` file at the project root. In production, set them in your shell or Docker Compose override file.

---

## Required

| Variable | Service | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | ai-service, recorder-service | Google Gemini API key. Get one at [aistudio.google.com](https://aistudio.google.com/app/apikey) |

---

## Service URLs (set automatically by Docker Compose)

These are pre-configured for inter-container communication. Change only if running services outside Docker.

| Variable | Default | Description |
|----------|---------|-------------|
| `RABBITMQ_URL` | `amqp://alt_user:alt_password@rabbitmq:5672` | RabbitMQ connection string |
| `DATABASE_URL` | `postgresql://alt_user:alt_password@postgres:5432/alt_db` | PostgreSQL connection string |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `RESULTS_URL` | `http://results-service:3004` | Results-service base URL (used by api-service and workers) |
| `RECORDER_URL` | `http://recorder-service:3007` | Recorder-service URL (used by results-service health check) |

---

## Security (required for production, optional for dev)

| Variable | Service | Description |
|----------|---------|-------------|
| `API_KEYS` | api-service, results-service | Comma-separated list of valid API keys. Empty string = auth disabled |
| `API_KEY` | ui | Single API key passed to the UI as `NEXT_PUBLIC_API_KEY` |
| `ALLOWED_ORIGIN` | api-service, results-service, ui | CORS allowed origin. Default: `*`. Set to `https://yourdomain.com` in production |

**Example `.env` for production:**
```bash
GEMINI_API_KEY=AIza...
API_KEYS=key1,key2
API_KEY=key1
ALLOWED_ORIGIN=https://yourdomain.com
DOMAIN=yourdomain.com
```

---

## Worker tuning

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `WORKER_CONCURRENCY` | worker-backend | `1` | Parallel k6 tests per replica. Increase cautiously — each k6 process is CPU-intensive |
| `WORKER_CONCURRENCY` | worker-client | `2` | Parallel Puppeteer sessions per replica |
| `WORKER_CONCURRENCY` | ai-service | `3` | Parallel Gemini API calls (I/O-bound, safe to increase) |
| `K6_MAX_DURATION_MS` | worker-backend | `600000` (10 min) | Hard timeout per k6 test. SIGTERM → 30s grace → SIGKILL |
| `PUPPETEER_MAX_DURATION_MS` | worker-client | `300000` (5 min) | Hard timeout per Puppeteer test |

---

## Stale test cleanup

Running in results-service — cleans up tests that got stuck.

| Variable | Default | Description |
|----------|---------|-------------|
| `STALE_RUNNING_MINUTES` | `15` | Tests with `status = 'running'` older than this → marked `failed` |
| `STALE_PENDING_MINUTES` | `30` | Tests with `status = 'pending'` older than this → marked `failed` |

---

## UI (Next.js public env vars)

These are embedded into the Next.js build. Prefix `NEXT_PUBLIC_` means they're exposed to the browser.

| Variable | Default | Description |
|----------|---------|-------------|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | api-service URL (browser-visible) |
| `NEXT_PUBLIC_RESULTS_URL` | `http://localhost:3004` | results-service URL (browser-visible) |
| `NEXT_PUBLIC_RECORDER_URL` | `http://localhost:3007` | recorder-service URL (browser-visible) |
| `NEXT_PUBLIC_API_KEY` | _(empty)_ | API key sent with every UI request as `X-API-Key` |

---

## Recorder service

| Variable | Default | Description |
|----------|---------|-------------|
| `CHROMIUM_PATH` | `/usr/bin/chromium-browser` | Path to Chromium binary inside the container |
| `DISPLAY` | `:99` | Xvfb display number. Use `:0` for real display (local dev without Docker) |
| `NOVNC_URL` | `http://localhost:6080/vnc.html` | URL shown to the user to open the browser viewer |

---

## Ports

| Service | Port | Purpose |
|---------|------|---------|
| api-service | `3000` | REST API |
| ai-service | `3001` | Internal (no direct client traffic) |
| worker-backend | `3002` | Health endpoint |
| worker-client | `3003` | Health endpoint |
| results-service | `3004` | REST API |
| ui | `3006` | Next.js frontend |
| recorder-service | `3007` | Recording REST API |
| recorder-service | `6080` | noVNC browser viewer |
| postgres | `5432` | Database |
| rabbitmq | `5672` | AMQP |
| rabbitmq | `15672` | RabbitMQ management UI |
| redis | `6379` | Cache / pub-sub |

In production (`docker-compose.prod.yml`), only ports `80` and `443` (Caddy) are exposed. All internal service ports are removed.

---

## Docker Compose files

The platform uses three Compose files you can layer:

### `docker-compose.yml` — base (always required)

Defines all services with default configuration. Suitable for production (all services, restart policies, health checks).

```bash
docker compose up --build
```

### `docker-compose.dev.yml` — development overlay

Adds hot-reload (tsx watch) for all TypeScript services and mounts source code as volumes. Includes a `shared-watcher` that rebuilds `@alt/shared` when `packages/shared/src` changes.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Changes to any `.ts` file → service restarts automatically (usually < 2s).

**Notes:**
- On Windows, Next.js HMR requires `WATCHPACK_POLLING=true` (already set)
- The `.next` build cache is stored in a named Docker volume `ui_next_cache` for fast warm starts

### `docker-compose.prod.yml` — production overlay

Removes all internal port bindings, adds Caddy HTTPS, sets resource limits.

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

Required env vars: `DOMAIN`, `API_KEYS`, `API_KEY`, `ALLOWED_ORIGIN`, `GEMINI_API_KEY`.

---

## Scaling workers

Run multiple worker replicas to process more tests in parallel:

```bash
# 3 k6 workers (max 3 concurrent backend tests)
docker compose up --scale worker-backend=3

# 2 Puppeteer workers
docker compose up --scale worker-client=2
```

Each replica is independent. The `cancel-fanout` exchange broadcasts cancel signals to all replicas, so cancellation always works regardless of which replica is running a test.

With `WORKER_CONCURRENCY=2` and 3 replicas, you get 6 parallel test slots for backend tests.

---

## Gemini API limits

The free tier of `gemini-2.5-flash` allows **20 requests per day**. Each test that goes through AI (new URL, no cache, with description comparison) uses 1–2 Gemini calls.

When the quota is exhausted, the platform automatically retries with backoff (60s / 120s / 180s). The UI shows a status message: `"Gemini unavailable — retrying… (N attempts left)"`.

To remove the daily limit, upgrade to a paid Google AI Studio plan and rotate your key in `.env`.

---

## Infrastructure credentials

Default dev credentials (do **not** use in production):

| Service | Username | Password |
|---------|----------|---------|
| PostgreSQL | `alt_user` | `alt_password` |
| RabbitMQ | `alt_user` | `alt_password` |

For production, override via `RABBITMQ_URL` and `DATABASE_URL` with strong passwords.
