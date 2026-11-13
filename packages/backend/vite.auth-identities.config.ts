import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    // Preserve mock history from setup and beforeAll when upgrading from Vitest 4.
    clearMocks: false,
    name: 'auth-identities',
    environment: 'node',
    include: ['src/scripts/auth-identities/__tests__/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 2,
  },
});
