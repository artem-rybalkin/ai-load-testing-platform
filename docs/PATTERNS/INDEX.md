# PATTERNS/INDEX.md — AI Load Testing Platform

Index of coding and architectural patterns used in this project.

## Patterns

| Pattern | File | Domain |
|---------|------|--------|
| RabbitMQ consumer with DLQ retry | [rabbitmq-consumer-dlq.md](rabbitmq-consumer-dlq.md) | Messaging |
| Three-way routing with cache | [three-way-script-routing.md](three-way-script-routing.md) | API design |
| WebSocket push (noServer) | [websocket-noserver.md](websocket-noserver.md) | Real-time |
| Fastify service with health check | [fastify-service-health.md](fastify-service-health.md) | Services |
| Per-test run directory isolation | [per-test-run-dir.md](per-test-run-dir.md) | Workers |
| Non-root Docker container | [non-root-docker.md](non-root-docker.md) | Infrastructure |
| Pino logger with redact | [pino-redact-logger.md](pino-redact-logger.md) | Observability |
| Testcontainers integration test | [testcontainers-integration.md](testcontainers-integration.md) | Testing |

## Changes

See [CHANGES.md](CHANGES.md).
