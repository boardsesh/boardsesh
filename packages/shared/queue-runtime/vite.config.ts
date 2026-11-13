import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'queue-runtime',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
