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
      // react-router-dom v7 is just react-router + a couple of DOM-only extras
      // (HydratedRouter, unused here) re-exported under a separate package
      // entrypoint. Left un-aliased, app code importing hooks from
      // 'react-router-dom' and tests importing `createRoutesStub` from
      // 'react-router' resolve to two distinct module instances, each with
      // their own DataRouterContext — so useLoaderData() throws "must be
      // used within a data router" even though a stub router is rendered.
      // Forcing both specifiers to the same module keeps context identity
      // consistent.
      'react-router-dom': 'react-router',
    },
  },
  test: {
    // Root cause of a leaked-mock bug found and fixed by hand in worker-backend
    // (a queued mockReturnValueOnce leaked into the next test's spawn queue) —
    // reset all mocks between tests instead of relying on every file's own
    // beforeEach to call vi.clearAllMocks()/mockReset() correctly.
    mockReset: true,
    clearMocks: true,
    env: {
      DATABASE_URL: 'postgresql://placeholder:placeholder@localhost:5432/placeholder',
      RABBITMQ_URL: 'amqp://placeholder:placeholder@localhost:5672',
      API_KEYS: '',
      INTERNAL_API_KEY: '',
      // Production uses 12 rounds (auth.ts); every registerUser()-based integration
      // test would otherwise pay the full ~750ms bcrypt cost per call for no security
      // benefit — rounds=4 (~5ms) cuts the suite's slowest files dramatically.
      AUTH_BCRYPT_ROUNDS: '4',
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
