# DEPENDENCIES.md — AI Load Testing Platform

Key external dependencies across services. See package.json files for exact versions.

## Shared / Root

| Package | Purpose |
|---------|---------|
| typescript | Language |
| vitest | Test runner |
| @testcontainers/postgresql | Real DB for integration tests |
| @testing-library/react | UI component testing |
| @testing-library/dom | Peer dep of @testing-library/react (DOM query utilities) |
| @playwright/test | E2E testing |

## @alt/shared (packages/shared)

| Package | Purpose |
|---------|---------|
| *(build only, no runtime deps)* | Shared TypeScript types |

## api-service

| Package | Purpose |
|---------|---------|
| fastify | HTTP server |
| @fastify/cors | CORS |
| @fastify/cookie | Cookie parsing (v11, Fastify 5 compatible) |
| amqplib | RabbitMQ client |
| pg | PostgreSQL client |
| pino | Structured logging |
| @alt/shared | Shared types |

## ai-service

| Package | Purpose |
|---------|---------|
| amqplib | RabbitMQ consumer/producer |
| @google/generative-ai | Gemini API (script gen, comparison) |
| pino | Logging |
| @alt/shared | Shared types |

## worker-backend

| Package | Purpose |
|---------|---------|
| fastify | Health HTTP server |
| amqplib | RabbitMQ consumer |
| pg | PostgreSQL (saveScript) |
| pino | Logging |
| @alt/shared | Shared types |
| *(k6 binary)* | Load testing (installed in Docker image) |

## worker-client

| Package | Purpose |
|---------|---------|
| fastify | Health HTTP server |
| amqplib | RabbitMQ consumer |
| puppeteer | Headless Chromium automation |
| lighthouse | Lighthouse audit |
| pino | Logging |
| @alt/shared | Shared types |

## analyser-service

| Package | Purpose |
|---------|---------|
| fastify | HTTP server |
| @google/generative-ai | Gemini AI insights |
| pino | Logging |
| @alt/shared | Shared types |

## results-service

| Package | Purpose |
|---------|---------|
| fastify | HTTP + WebSocket server |
| @fastify/cookie | Cookie parsing (v11, Fastify 5 compatible) |
| ws | WebSocket server (noServer mode) |
| @types/ws | WS types |
| amqplib | RabbitMQ consumer |
| pg | PostgreSQL |
| node-cron | Schedule runner |
| pdfkit | PDF report generation |
| pino | Logging |
| @alt/shared | Shared types |

## recorder-service

| Package | Purpose |
|---------|---------|
| fastify | HTTP server |
| puppeteer-core | Non-headless Chromium + CDP |
| @google/generative-ai | AI correlation detection |
| pino | Logging |
| @alt/shared | Shared types |

## ui

| Package | Purpose |
|---------|---------|
| vite | Build tool (v6) |
| @vitejs/plugin-react | React JSX transform |
| @tailwindcss/vite | Tailwind CSS v4 plugin |
| react | UI framework |
| react-dom | DOM rendering |
| react-router-dom | SPA routing (v7) |
| recharts | Charts |
| @fontsource-variable/geist | Geist font |
| @testing-library/react | Component tests |
| vitest | Test runner |
| jsdom | DOM simulation for tests |

## Infrastructure (docker-compose)

| Component | Image |
|-----------|-------|
| PostgreSQL | postgres:16-alpine |
| RabbitMQ | rabbitmq:3-management-alpine |
| Redis | redis:7-alpine |
| Caddy (prod) | caddy:2-alpine |
