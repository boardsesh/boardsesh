import { defineConfig } from 'vite-plus';

export default defineConfig({
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'crypto',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    env: {
      NODE_ENV: 'development',
    },
  },
});
