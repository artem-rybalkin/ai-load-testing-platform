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
    threads: {
      maxThreads: 4,
    },
    coverage: {
      provider: 'v8',
      include: ['services/*/src/**/*.ts'],
      exclude: ['services/*/src/__tests__/**', 'services/*/src/index.ts'],
    },
  },
});
