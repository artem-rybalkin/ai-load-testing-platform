# Pattern: Testcontainers Integration Test

## Context
Used in: results-service/__tests__/api.test.ts, consumer.test.ts, stale.test.ts, api-service/__tests__/scripts.test.ts

## Problem
Mocked database tests pass but real migration failures or query bugs go undetected. Need real PostgreSQL without managing a running instance.

## Solution

```typescript
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { createSchema } from '../db.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  await createSchema(pool); // run real migrations
}, 60_000); // generous timeout for image pull

afterAll(async () => {
  await pool.end();
  await container.stop();
});

beforeEach(async () => {
  // Clean tables between tests (faster than re-creating schema)
  await pool.query('TRUNCATE TABLE test_results, test_scripts, ... RESTART IDENTITY CASCADE');
});
```

## Key Rules
- Requires Docker Desktop running — document in test setup
- 60s beforeAll timeout for image pull on first run
- TRUNCATE with RESTART IDENTITY CASCADE between tests (not DROP/CREATE — too slow)
- createSchema() must be idempotent (use IF NOT EXISTS, safe migrations)
- vitest.config.ts must set DATABASE_URL and RABBITMQ_URL env vars as placeholders so Vitest doesn't fail on missing env
