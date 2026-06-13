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
    },
    include: [
      'services/*/src/__tests__/**/*.test.ts',
      'services/ui/__tests__/**/*.test.tsx',
    ],
    environment: 'node',
    environmentMatchGlobs: [
      ['services/ui/**', 'jsdom'],
    ],
    setupFiles: ['services/ui/__tests__/setup.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: 'threads',
    // Capped at 2 to prevent simultaneous Testcontainer PostgreSQL container
    // exhaustion when all 5 results-service integration test files run together.
    // Each file spins up its own pg container; 4+ concurrent containers race for
    // Docker socket resources and fail with "pool is undefined".
    maxWorkers: 2,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      include: ['services/*/src/**/*.ts'],
      exclude: ['services/*/src/__tests__/**', 'services/*/src/index.ts'],
    },
  },
});
