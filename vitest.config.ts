import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['services/*/src/__tests__/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 60000,
    coverage: {
      provider: 'v8',
      include: ['services/*/src/**/*.ts'],
      exclude: ['services/*/src/__tests__/**', 'services/*/src/index.ts'],
    },
  },
});
