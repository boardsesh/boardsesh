import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'aurora-sync-recovery-integration',
    globals: true,
    environment: 'node',
    include: ['src/sync/shared-sync.recovery.integration.test.ts'],
    globalSetup: [],
    setupFiles: [],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
