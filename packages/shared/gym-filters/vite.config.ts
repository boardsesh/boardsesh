import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'gym-filters',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
