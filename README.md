# AI Load Testing Platform

A distributed, AI-powered load testing platform. Describe what you want to test — Gemini AI generates the k6 or Puppeteer script automatically — then track live metrics, compare results, and get automated performance analysis.

---

## Features

- 💬 **Chat-based / one-prompt test creation** — describe what you want to test; Gemini asks follow-up questions for anything ambiguous, then generates the k6 or Puppeteer script
- ⚡ **Backend + browser load testing** — k6 (VUs, load profiles, full metrics) and Puppeteer + Lighthouse (Web Vitals, performance scores)
- 🔗 **Multi-step flow testing & recording** — build authenticated flows by hand or record a real browser session with AI-detected correlations
- 📈 **Live metrics, regression detection & SLO thresholds** — real-time charts, automatic comparison vs baseline, per-test pass/fail criteria
- 👥 **Teams, orgs, RBAC & scheduled tests** — multi-tenant accounts, per-team quotas and API keys, cron-based recurring runs, webhooks

→ Full feature list: [docs/CONTEXT.md](docs/CONTEXT.md)

---

## Architecture

Nine services communicate over RabbitMQ: an API gateway routes test requests to a pluggable
AI service (Gemini / OpenAI / Claude) for script generation, k6 and Puppeteer workers execute
tests, and a results service persists metrics to PostgreSQL and pushes live updates to the UI
over WebSocket, backed by Redis for rate limiting and cross-replica pub/sub.

→ Full architecture diagram + services table: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)

---

## Quick Start

**Prerequisites:** Docker + Docker Compose, a [Gemini API key](https://aistudio.google.com/app/apikey) (free tier works).

```bash
# 1. Clone
git clone https://github.com/artem-rybalkin/ai-load-testing-platform.git
cd ai-load-testing-platform

# 2. Configure
echo "GEMINI_API_KEY=your_key_here" > .env

# 3. Start everything
docker compose up --build

# 4. Open the UI
# → http://localhost:3006
```

First startup takes ~2–3 minutes to build all images. After that, the UI is served by Vite, which
pre-bundles vendor chunks at server startup rather than compiling them lazily on first browser
request — no `ERR_CONNECTION_RESET` workaround needed even on Docker Desktop's slower Windows
filesystem bridge (see [Vite Migration](docs/vite-migration.md) for why this used to be a problem
under the previous Next.js-based UI).

| What | URL |
|------|-----|
| UI dashboard | http://localhost:3006 |
| API (Swagger-style) | http://localhost:3000 |
| Results & data API | http://localhost:3004 |
| RabbitMQ management | http://localhost:15672 (user: `alt_user`, pass: `alt_password`) |
| noVNC browser viewer | http://localhost:6080 (recorder-service only) |

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Context & Capabilities](docs/CONTEXT.md) | Full feature list, user flows, and product scope |
| [Architecture](docs/ARCHITECTURE.md) | Architecture diagram, services table, data flows |
| [Getting Started](docs/how-to/getting-started.md) | Zero-to-running in 5 minutes |
| [Test Types](docs/how-to/test-types.md) | Backend, Browser, and Flow tests explained |
| [Flow Recording](docs/how-to/flow-recording.md) | Record a browser session and convert to a test |
| [Custom Scripts](docs/how-to/custom-scripts.md) | Upload your own k6 script |
| [API Reference](docs/api.md) | Full REST API for all services |
| [Configuration](docs/configuration.md) | All environment variables and tuning options |
| [Production Deployment](docs/how-to/production.md) | Caddy HTTPS, DNS, security hardening |
| [Free-Tier Demo Deployment](docs/how-to/free-demo-deployment.md) | Shareable public URL at zero cost (Render + Neon + CloudAMQP) |
| [Development Guide](docs/how-to/development.md) | Hot-reload dev mode, test suite, adding services |
| [Grafana Integration](docs/how-to/grafana-integration.md) | Connect Prometheus, Loki, and Tempo for AI-enriched analysis |
| [AI Features](docs/AI-FEATURES.md) | Every AI capability, including LLM observability and guardrails |
| [Vite Migration](docs/vite-migration.md) | Why Next.js was replaced, what failed, final solution |

---

## License

MIT
