# ASSUMPTIONS.md — AI Load Testing Platform

Assumptions, unknowns, and open decisions.

## Architecture Assumptions

| # | Assumption | Impact if Wrong |
|---|------------|----------------|
| A1 | Single PostgreSQL instance is sufficient (no read replicas needed) | Results queries slow under high concurrent load |
| A2 | Redis will be used for rate limiting and caching in a future phase | Redis container is running but unused today |
| A3 | Gemini 2.5 Flash is the optimal model for cost/quality tradeoff | May need to upgrade to Pro for better script quality |
| A4 | k6 and Puppeteer cover all needed test types (no JMeter/Gatling) | Feature gap if users have existing JMeter scripts |
| A5 | Single RabbitMQ broker is sufficient (no cluster needed) | Message loss risk if broker goes down without persistence |

## Security Assumptions

| # | Assumption | Impact if Wrong |
|---|------------|----------------|
| S1 | API_KEYS env var is safe to pass via docker-compose environment | Secrets visible in docker inspect; consider secrets manager in prod |
| S2 | Internal service-to-service communication doesn't need auth | Internal network breach exposes all services |
| S3 | HMAC webhook signing is optional (most users won't use secrets) | Webhook spoofing possible without signing |
| S4 | SESSION_SECRET empty = auth disabled is a safe default for local dev | Accidental misconfiguration in production would expose all data |
| S5 | HMAC-SHA256 with `crypto.timingSafeEqual` is sufficient for session integrity | Brute-force attacks on short secrets possible; mitigated by requiring 32+ chars |
| S6 | Project-scoped isolation (not user-scoped) is the right granularity | Teams wanting per-user data separation would need a different model |

## Operational Assumptions

| # | Assumption | Impact if Wrong |
|---|------------|----------------|
| O1 | WORKER_CONCURRENCY=1 for worker-backend is safe default | Bottleneck if multiple tests queued |
| O2 | 15-minute stale running timeout is sufficient | Long k6 soak tests (>15 min) incorrectly marked failed |
| O3 | k6 max duration 10 minutes is acceptable | Users wanting >10 min tests need to override K6_MAX_DURATION_MS |
| O4 | analyser-service 12s timeout is sufficient for Gemini response | AI insights missing if Gemini is slow under load |

## UI/UX Assumptions

| # | Assumption | Impact if Wrong |
|---|------------|----------------|
| U1 | WebSocket auto-reconnect with exponential backoff (1s→30s) is sufficient | Users miss live updates during reconnection window |
| U2 | Command Center design (GitHub palette) fits the user demographic | UX mismatch if users expect dark theme by default |
| U3 | React Router v7 SPA routing is stable enough for production | Breaking changes in minor versions may require migration |

## Unknowns

| # | Unknown | Decision Needed |
|---|---------|----------------|
| K1 | Playwright→Puppeteer script import feasibility | Whether to build converter-service (noted as future work) |
| K2 | Optimal analyser-service prompt payload schema | Need typed AnalysisPromptPayload to cap tokens and normalize units |
| K3 | Rate limiting strategy when Redis is wired up | @fastify/rate-limit vs custom middleware |
| K4 | Mobile application performance testing approach | Appium vs WebDriverIO vs cloud device farms (AWS Device Farm, BrowserStack) |
| K5 | Natural language one-prompt test creation | How to reliably infer test type, URL, steps, load profile, and SLOs from a single free-text prompt |
