# TECHSTACK.md — AI Load Testing Platform

Tech stack across all services. Single source for technology decisions.

## Runtime & Language

| Layer | Technology | Version |
|-------|-----------|---------|
| Runtime | Node.js | 20 (LTS) |
| Language | TypeScript | strict mode, ES2022 target |
| Package manager | npm | workspaces monorepo |

## API Framework

| Service | Framework | Notes |
|---------|-----------|-------|
| api-service | Fastify + @fastify/cors + @fastify/cookie | REST API, CORS, cookie parsing |
| results-service | Fastify + @fastify/cookie | REST + WebSocket (noServer) + auth endpoints |
| analyser-service | Fastify | REST only |
| worker-backend | Fastify | Health server only (port 3002) |
| worker-client | Fastify | Health server only (port 3003) |
| recorder-service | Fastify | REST only |

## Message Queue

| Component | Technology |
|-----------|-----------|
| Broker | RabbitMQ |
| Client | amqplib |
| Pattern | Work queues + fanout exchange + DLQ |
| Retry | x-retry-count header, 3 attempts, then DLQ |

## Database

| Component | Technology |
|-----------|-----------|
| DB | PostgreSQL |
| Client | pg (node-postgres) |
| Connection | Pool per service |
| Schema | Manual SQL migrations via createSchema() |

## AI

| Component | Technology |
|-----------|-----------|
| Provider | Google Gemini API |
| Package | @google/generative-ai |
| Model | gemini-2.5-flash |
| Usage | Script generation, description comparison, AI insights, correlation detection |

## Load Testing

| Component | Technology |
|-----------|-----------|
| Backend runner | k6 (installed in worker-backend Docker image) |
| Client runner | Puppeteer 22 + Lighthouse |
| Browser | Chromium (headless Alpine) |

## Frontend

| Component | Technology |
|-----------|-----------|
| Build tool | Vite 6 |
| Framework | React Router v7 (SPA) |
| Styling | Tailwind CSS 4 (CSS-first via @tailwindcss/vite) |
| Charts | Recharts |
| Font | @fontsource-variable/geist |

## Real-time

| Component | Technology |
|-----------|-----------|
| WebSocket server | ws package (noServer mode, attached to Fastify HTTP server) |
| WebSocket client | Browser native WebSocket API |
| Pattern | Push events: test:status, test:live, tests:changed |

## Containerization

| Component | Technology |
|-----------|-----------|
| Containers | Docker |
| Orchestration | docker-compose (dev / prod overlays) |
| Reverse proxy | Caddy (prod only, auto-TLS via Let's Encrypt) |
| Base images | node:20-alpine |

## Logging

| Component | Technology |
|-----------|-----------|
| Library | Pino |
| Format | Structured JSON |
| Redaction | Pino redact: envVars, testData, csvData |

## Scheduling

| Component | Technology |
|-----------|-----------|
| Cron | node-cron (in results-service) |

## PDF Reports

| Component | Technology |
|-----------|-----------|
| Library | pdfkit |

## Testing

| Layer | Framework |
|-------|-----------|
| Unit + Integration | Vitest |
| Real DB | @testcontainers/postgresql |
| UI Components | @testing-library/react + jsdom |
| E2E | Playwright |

## Flow Recorder

| Component | Technology |
|-----------|-----------|
| Browser automation | puppeteer-core (non-headless) |
| Protocol | Chrome DevTools Protocol (CDP) |
| Virtual display | Xvfb + x11vnc |
| Browser viewer | noVNC |
| Correlation | Gemini AI (gemini-2.5-flash) |

## Auth / Session

| Component | Technology | Notes |
|-----------|-----------|-------|
| Session cookies | @fastify/cookie v11 + HMAC-SHA256 | HttpOnly `alt_session` cookie; `SESSION_SECRET` empty = disabled |
| Project isolation | PostgreSQL `project_id` FK | All resource tables carry `project_id`; null = auth disabled |

## Cache

| Component | Technology | Status |
|-----------|-----------|--------|
| Redis | Redis | Running, not yet used (planned: rate limiting + pub/sub) |
