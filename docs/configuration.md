# Configuration

All configuration is done via environment variables. In local dev, set them in the `.env` file at the project root. In production, set them in your shell or Docker Compose override file.

---

## Required

| Variable | Service | Description |
|----------|---------|-------------|
| `GEMINI_API_KEY` | ai-service, recorder-service | Google Gemini API key. Get one at [aistudio.google.com](https://aistudio.google.com/app/apikey) |

---

## AI provider keys (multi-provider fallback)

Gemini is the only required provider. OpenAI and Anthropic are optional — set either (or both) to enable them as an admin-configured primary or fallback provider. See [AI-FEATURES.md → Model configuration & multi-provider fallback](AI-FEATURES.md#model-configuration--multi-provider-fallback) for how the fallback chain and per-team overrides work.

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `OPENAI_API_KEY` | ai-service, analyser-service, recorder-service, results-service | _(empty)_ | OpenAI API key. Empty = OpenAI unavailable as a provider option |
| `OPENAI_MODEL` | ai-service, analyser-service, recorder-service, results-service | `gpt-4o-mini` | OpenAI model ID used when OpenAI is the active provider |
| `ANTHROPIC_API_KEY` | ai-service, analyser-service, recorder-service, results-service | _(empty)_ | Anthropic API key. Empty = Anthropic unavailable as a provider option |
| `ANTHROPIC_MODEL` | ai-service, analyser-service, recorder-service, results-service | `claude-3-5-haiku-latest` | Anthropic model ID used when Anthropic is the active provider |

---

## LLM tracing (Langfuse, optional)

Traces every `generateAIText()` call (prompt, completion, provider used) to [Langfuse](https://langfuse.com) when configured. See [AI-FEATURES.md → LLM tracing](AI-FEATURES.md#llm-tracing-langfuse-optional) for details. Leaving the keys empty disables tracing entirely.

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `LANGFUSE_PUBLIC_KEY` | ai-service, analyser-service, recorder-service, results-service | _(empty)_ | Langfuse public key. Empty = tracing disabled |
| `LANGFUSE_SECRET_KEY` | ai-service, analyser-service, recorder-service, results-service | _(empty)_ | Langfuse secret key. Empty = tracing disabled |
| `LANGFUSE_BASE_URL` | ai-service, analyser-service, recorder-service, results-service | `https://cloud.langfuse.com` | Langfuse ingestion endpoint. Override when self-hosting |

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
| `API_KEY` | ui | Single API key passed to the UI as `VITE_API_KEY` |
| `SESSION_SECRET` | results-service | Secret for HMAC-SHA256 cookie signing. Empty string = auth disabled (dev). Use a minimum 32-character random string in production |
| `ALLOWED_ORIGIN` | api-service, results-service, ui | CORS allowed origin. Default: `*`. Set to `https://yourdomain.com` in production |
| `INTERNAL_API_KEY` | all 7 backend services | Shared secret for internal service-to-service callbacks (e.g. worker → results-service). Empty string = disabled (dev only) |

**Example `.env` for production:**
```bash
GEMINI_API_KEY=AIza...
API_KEYS=key1,key2
API_KEY=key1
SESSION_SECRET=change-me-to-a-long-random-string
ALLOWED_ORIGIN=https://yourdomain.com
DOMAIN=yourdomain.com
```

---

## Rate limiting

Global per-IP request limits, enforced via `@fastify/rate-limit`. See [API reference → Rate limiting](api.md#rate-limiting-429) for response shape and the stricter per-route limits.

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| `RATE_LIMIT_MAX` | api-service, results-service | `600`/min | Global per-IP request limit |
| `AUTH_RATE_LIMIT_MAX` | results-service | `10`/min | Per-IP limit on `POST /auth/login` and `POST /auth/register` |
| `AI_RATE_LIMIT_MAX` | results-service | `20`/min | Per-IP limit on `/ai/*`, `suggest-*`, and `/results/:testId/diagnose` |

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
| `LIVE_METRICS_RETENTION_DAYS` | `30` | `live_metrics` rows older than this are purged |
| `TEST_RESULTS_RETENTION_DAYS` | `0` (disabled) | GDPR auto-purge: `test_results` rows (+ their `live_metrics`) older than this are deleted |
| `AUDIT_LOG_RETENTION_DAYS` | `180` | `audit_log` rows older than this are purged; set to `0` to disable |

Expired/revoked `sessions` rows are also purged on every cleanup cycle, unconditionally (no env var — an expired or revoked session has no future purpose).

---

## UI (Vite public env vars)

These are embedded into the Vite build. Prefix `VITE_` means they're exposed to the browser.

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_URL` | `http://localhost:3000` | api-service URL (browser-visible) |
| `VITE_RESULTS_URL` | `http://localhost:3004` | results-service URL (browser-visible) |
| `VITE_RECORDER_URL` | `http://localhost:3007` | recorder-service URL (browser-visible) |
| `VITE_API_KEY` | _(empty)_ | API key sent with every UI request as `X-API-Key` |

In dev, the Vite dev server proxies `/api/*` → api-service and `/data/*` → results-service so auth cookies work on the same origin without CORS issues.

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
| results-service | `3004` | REST API + WebSocket + auth |
| ui | `3006` | Vite + React SPA |
| recorder-service | `3007` | Recording REST API |
| recorder-service | `6080` | noVNC browser viewer |
| postgres | `5432` | Database |
| rabbitmq | `5672` | AMQP |
| rabbitmq | `15672` | RabbitMQ management UI |
| redis | `6379` | Cache / pub-sub (not yet wired) |

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
- On Windows, Vite HMR requires `WATCHPACK_POLLING=true` (already set)
- See [UI (Vite public env vars)](#ui-vite-public-env-vars) for the dev-proxy paths (`/api/*`, `/data/*`)

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

The default model is `gemini-3.1-flash-lite` (set via `GEMINI_MODEL`). Its free tier is roughly **15 requests/minute and ~1,000 requests/day** (flash-lite class — Google adjusts preview-model quotas frequently, so check [AI Studio's rate limit page](https://aistudio.google.com/rate-limit) for current values). Each test that goes through AI (new URL, no cache, with description comparison) uses 1–2 Gemini calls.

What happens when this limit (or the platform's own per-team daily quota) is hit — automatic retry with backoff vs. immediate fail-closed fallback, and the UI banner — is documented in [AI-FEATURES.md → Rate limit handling](AI-FEATURES.md#rate-limit-handling).

To remove the daily limit, upgrade to a paid Google AI Studio plan and rotate your key in `.env`, or configure OpenAI/Anthropic as a fallback provider (see [AI provider keys](#ai-provider-keys-multi-provider-fallback) below).

---

## Infrastructure credentials

Default dev credentials (do **not** use in production):

| Service | Username | Password |
|---------|----------|---------|
| PostgreSQL | `alt_user` | `alt_password` |
| RabbitMQ | `alt_user` | `alt_password` |

For production, override via `RABBITMQ_URL` and `DATABASE_URL` with strong passwords.
