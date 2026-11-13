import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'public-api',
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
