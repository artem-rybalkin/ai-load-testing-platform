# REQUIREMENTS/INDEX.md — AI Load Testing Platform

Functional and non-functional requirements. Extracted from CLAUDE.md + architecture (CLAUDE.md was since split into the current `docs/*.md` structure — see `docs/CONTEXT.md`, `docs/ARCHITECTURE.md`, `docs/TECHSTACK.md`, `docs/CODEMAP.md`, etc.).

## Functional Requirements

### FR-1: Test Execution
- FR-1.1 [MUST] System SHALL accept a natural-language description and generate a k6 or Puppeteer test script automatically
- FR-1.2 [MUST] System SHALL execute backend load tests using k6 with configurable VUs, duration, ramp-up, and load profile (load/spike/capacity/soak)
- FR-1.3 [MUST] System SHALL execute browser tests using Puppeteer with Web Vitals (LCP, FID, CLS, TTFB, FCP) and Lighthouse scores
- FR-1.4 [MUST] System SHALL support multi-step flow tests with per-step metrics (avg, p95, requests, errors)
- FR-1.5 [MUST] System SHALL allow cancellation of running or pending tests
- FR-1.6 [SHOULD] System SHALL accept a user-supplied custom k6 script, bypassing AI generation

### FR-2: Script Intelligence
- FR-2.1 [MUST] System SHALL cache generated scripts and reuse them when the same URL + type is requested again
- FR-2.2 [MUST] When a description is provided and a cached script exists, system SHALL use Gemini to compare descriptions and decide REUSE or REGENERATE
- FR-2.3 [MUST] System SHALL never store envVars, testData, csvData, or customScript in the database

### FR-3: Results & Analysis
- FR-3.1 [MUST] System SHALL store all test results with metrics, status, and performance analysis in PostgreSQL
- FR-3.2 [MUST] System SHALL classify results as passed / degraded / failed based on configurable SLO thresholds
- FR-3.3 [MUST] System SHALL detect regressions by comparing against a baseline or the previous run for the same URL
- FR-3.4 [SHOULD] System SHALL generate AI narrative insights (anomalies, root causes, recommendations) via Gemini per test result
- FR-3.5 [MUST] System SHALL stream live metrics (response time, error rate, throughput) during k6 execution at an admin-configurable aggregation window (10s/30s/1min, default 10s; changes apply to new tests only)

### FR-4: Flow Recording
- FR-4.1 [SHOULD] System SHALL capture real browser interactions via CDP and convert them to FlowStep definitions
- FR-4.2 [SHOULD] System SHALL use AI correlation detection to identify variable extraction rules from recorded requests

### FR-5: Scheduling & Webhooks
- FR-5.1 [SHOULD] System SHALL support scheduled recurring tests via cron expressions
- FR-5.2 [SHOULD] System SHALL fire webhooks on test completion when perf_status is failed or degraded
- FR-5.3 [SHOULD] System SHALL support optional HMAC signing of webhook payloads

### FR-6: UI
- FR-6.1 [MUST] System SHALL provide a web UI for test creation, result browsing, and comparison
- FR-6.2 [MUST] UI SHALL update in real-time using WebSocket push without page refresh
- FR-6.3 [SHOULD] UI SHALL provide external log source deep-links (Grafana, Datadog, Kibana, etc.)

## Non-Functional Requirements

### NFR-1: Performance
- NFR-1.1 [MUST] k6 tests MUST NOT exceed K6_MAX_DURATION_MS (default: 10 min) hard limit
- NFR-1.2 [MUST] Puppeteer tests MUST NOT exceed PUPPETEER_MAX_DURATION_MS (default: 5 min) hard limit
- NFR-1.3 [SHOULD] analyser-service AI insights MUST complete within 12 seconds or fall back to local analysis

### NFR-2: Reliability
- NFR-2.1 [MUST] All RabbitMQ consumers MUST retry failed messages up to 3 times before routing to DLQ
- NFR-2.2 [MUST] Tests marked as running > 15 min or pending > 30 min MUST be automatically marked failed
- NFR-2.3 [MUST] AI service unavailability MUST NOT block result storage

### NFR-3: Security
- NFR-3.1 [MUST] All API endpoints (except /health) MUST require X-API-Key authentication when API_KEYS is set
- NFR-3.2 [MUST] Sensitive fields (envVars, testData, csvData) MUST never appear in logs or API responses
- NFR-3.3 [MUST] All containers MUST run as non-root user (UID 1000)

### NFR-4: Observability
- NFR-4.1 [MUST] All services MUST expose GET /health with dependency checks
- NFR-4.2 [MUST] All services MUST use structured Pino JSON logging with testId on every log line

## Changes

See [CHANGES.md](CHANGES.md).
