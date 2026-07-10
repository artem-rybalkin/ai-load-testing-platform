# Free-tier public demo deployment

Goal: get a shareable public URL (e.g. for a LinkedIn post) running the real platform, at zero cost, without fighting free-tier resource limits. This is deliberately a *trimmed* deployment — not the full `docker-compose.prod.yml` stack from `docs/how-to/production.md`, which assumes a real VPS.

## Why not one platform

No single free host runs Postgres + RabbitMQ + 7 Node services + a browser-automation worker as one unit. This plan splits the stack across a few free-tier providers instead:

| Piece | Provider | Why |
|-------|----------|-----|
| api-service, ai-service, analyser-service, worker-backend, worker-client, results-service, ui | [Render](https://render.com) free Web Services | No credit card required; one Dockerfile per service → one public `*.onrender.com` URL per service |
| PostgreSQL | [Neon](https://neon.tech) free tier | Permanent (Render's free Postgres self-destructs after 30 days) |
| RabbitMQ | [CloudAMQP](https://www.cloudamqp.com) free "Little Lemur" plan | Permanent, single node, fine for demo-level traffic |
| Redis | *(skip)* | `REDIS_URL` unset → app already falls back to in-memory rate limiting (see `docs/ARCHITECTURE.md` § Security Architecture) |

## What to leave out

- **`recorder-service`** (Puppeteer + Xvfb + noVNC for flow recording) — the heaviest piece; unlikely to run reliably in Render free tier's 512MB RAM. Everything else (AI script generation, k6/Puppeteer test execution, results, dashboards, AI insights) works without it. Flow *recording* specifically becomes unavailable in the public demo; recording a flow locally and importing it still works fine, or flows can be built manually via FlowBuilder.

## Known tradeoffs to accept before sharing the link

- Render free services spin down after 15 min idle → first visitor after a gap eats a ~30–60s cold-start delay on each service (api, ui, results all need to wake up).
- CloudAMQP's free plan caps connections/throughput — fine for a single demo visitor running one test at a time, not for concurrent load.
- No horizontal scaling — this is a single-replica demo, not a production posture.

## Steps (not yet started)

1. Create accounts: Render, Neon, CloudAMQP (all free, no card needed for the tiers above).
2. Neon: create a project, get the connection string, run the platform's migrations against it (`results-service` applies its own numbered migrations on boot — see `schema_migrations` in `docs/ARCHITECTURE.md`).
3. CloudAMQP: create a "Little Lemur" instance, get the AMQP URL.
4. Render: one Web Service per service below, each built from its own `services/<name>/Dockerfile`, wired to the shared `DATABASE_URL` / `RABBITMQ_URL` env vars plus each service's existing required env vars (see `docs/configuration.md`):
   - `api-service`, `ai-service`, `analyser-service`, `worker-backend`, `worker-client`, `results-service`, `ui`
5. UI's `VITE_API_URL` / `VITE_RESULTS_URL` build args point at the deployed api-service/results-service Render URLs (same mechanism `docker-compose.prod.yml` already uses for the real prod build — see the `ui` service's `build.args`).
6. Set `SESSION_SECRET`, `API_KEYS`/`INTERNAL_API_KEY`, and a `GEMINI_API_KEY` (or leave AI features gracefully degraded if not providing one — see `docs/AI-FEATURES.md`).
7. Smoke test: register a team, run a simple backend test end-to-end, confirm results/dashboards render.
8. Share the `ui` service's Render URL.

## Open questions for whoever picks this up

- Whether to seed the public demo with a fixed demo account / sample data, or leave it as a truly blank first-run experience.
- Whether to rate-limit more aggressively than the defaults, given it's an unauthenticated-signup public demo link.
