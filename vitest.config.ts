import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'services/ui'),
    },
  },
  test: {
    env: {
      DATABASE_URL: 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
      RABBITMQ_URL: 'amqp://placeholder:placeholder@localhost:5672',
      API_KEYS: '',
      INTERNAL_API_KEY: '',
    },
    include: [
      'services/*/src/__tests__/**/*.test.ts',
      'services/ui/__tests__/**/*.test.tsx',
      'packages/*/src/__tests__/**/*.test.ts',
      'chaos/**/*.test.ts',
    ],
    environment: 'node',
    environmentMatchGlobs: [
      ['services/ui/**', 'jsdom'],
    ],
    setupFiles: ['services/ui/__tests__/setup.ts'],
    globalSetup: ['./test-support/globalSetup.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: 'threads',
    // All Testcontainers-based integration test files share a single PostgreSQL
    // container (started once in globalSetup), each creating its own isolated
    // database on it — see test-support/sharedPostgres.ts. This removes the
    // per-file container startup cost that previously forced maxWorkers down to 2
    // and caused resource-contention timeouts on the full suite.
    maxWorkers: 4,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      include: ['services/*/src/**/*.ts'],
      exclude: ['services/*/src/__tests__/**', 'services/*/src/index.ts'],
    },
  },
});
