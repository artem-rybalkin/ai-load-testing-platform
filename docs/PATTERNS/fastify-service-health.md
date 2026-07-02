# Pattern: Fastify Service with Health Check

## Context
Used in: api-service, results-service, analyser-service, recorder-service, worker-backend (health only), worker-client (health only), ai-service (health only)

## Problem
All services need a health endpoint for docker-compose health checks and system health aggregation.

## Solution

```typescript
import Fastify from 'fastify';
import { logger } from './logger.js';

const app = Fastify({ logger: false }); // use Pino directly, not Fastify's logger

// Deep health check: check all dependencies
app.get('/health', async (req, reply) => {
  const checks: Record<string, string> = {};
  try {
    await pool.query('SELECT 1');
    checks.db = 'ok';
  } catch {
    checks.db = 'error';
  }
  const healthy = Object.values(checks).every(v => v === 'ok');
  return reply.status(healthy ? 200 : 503).send({ status: healthy ? 'ok' : 'degraded', checks });
});

await app.listen({ port: PORT, host: '0.0.0.0' });
```

## Key Rules
- Health endpoints return 200 (ok) or 503 (degraded/unreachable)
- Include named checks per dependency (db, rabbitmq, etc.)
- Workers expose health on a dedicated port, not the main worker port
- /health is exempt from API key authentication
