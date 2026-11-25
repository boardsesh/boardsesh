import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

/** Default-only command through owned canonical/current-profile private LOGIN. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'set-password-compatibility-backend-proof',
    environment: 'node',
    include: ['src/auth/authority/__tests__/set-password-compatibility-backend.proof.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
