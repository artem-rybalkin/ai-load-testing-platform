# CONTEXT.md — AI Load Testing Platform

Business context and target state. No technical details, no changelog.

## Purpose

AI-powered distributed load testing platform. Users describe what they want to test in plain language — the platform generates k6 or Puppeteer scripts automatically using Gemini AI, executes them on workers, and provides performance analysis with regression detection.

## Core User Flows

1. **Describe and run** — user describes a test in natural language; AI generates and executes the script automatically
2. **Multi-step flow testing** — user builds a flow (login → search → checkout) using the visual FlowBuilder or flow recorder; AI generates a k6 script with per-step metrics
3. **Re-run and compare** — user reruns previous tests and compares results side-by-side to detect regressions
4. **Schedule and alert** — user sets up recurring scheduled tests with webhook alerts on degradation or failure

## Key Capabilities

- **AI script generation** — Gemini generates k6 (backend) and Puppeteer (browser) scripts from plain-language descriptions
- **Smart script reuse** — Gemini compares descriptions to decide whether to reuse a cached script or regenerate
- **Flow recording** — visual browser recorder captures real user interactions and converts them to flow steps with AI-powered correlation detection
- **Real-time metrics** — live streaming of response time, error rate, throughput during test execution
- **Performance analysis** — threshold-based pass/degrade/fail classification with regression detection vs baseline or previous run
- **AI insights** — Gemini provides narrative analysis, anomalies, root causes, and recommendations per test result
- **Load profiles** — load / spike / capacity / soak profiles with configurable VUs, duration, ramp-up
- **External log links** — deep-link buttons to Grafana, Datadog, Kibana, etc. for test time window
- **PDF reports** — downloadable PDF for sharing results
- **Project-scoped auth** — HMAC-SHA256 cookie sessions; each project's data (tests, scripts, schedules, webhooks) is isolated by `project_id`
- **Extended browser metrics** — INP, TBT, TTI, JS errors, long task count, DOM node count, resource breakdown (in addition to Core Web Vitals)

## Users

- Backend engineers running API/service load tests
- Frontend engineers running browser performance audits
- QA engineers setting up regression baselines and scheduled regression tests
- DevOps running soak/capacity tests before production deployments

## Non-Goals

- No support for JMeter, Gatling, or other load testing tools (k6 and Puppeteer only)
- No real user monitoring (RUM) — synthetic testing only (RUM is on the future roadmap)
- No built-in APM — external log sources are deep-linked, not ingested

## Current Status

Production-ready across 23+ completed phases. All core features implemented and tested (~430 tests). Deployable to cloud via docker-compose.prod.yml + Caddy HTTPS. Includes project-scoped multi-tenancy with cookie-session authentication.
