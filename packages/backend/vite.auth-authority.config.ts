import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// No shared backend setup: every suite creates and drops its own local database.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'auth-authority',
    environment: 'node',
    include: ['src/auth/authority/__tests__/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 2,
  },
});
