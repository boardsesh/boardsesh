import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'play-view',
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
