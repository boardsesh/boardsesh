import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'kilter-sync-owned-compatibility-integration',
    globals: true,
    environment: 'node',
    include: ['src/sync/catalog-sync-owner-order.test.ts'],
    globalSetup: [],
    setupFiles: [],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
