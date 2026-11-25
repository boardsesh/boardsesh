import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

/** Full recovery family against its isolated canonical-journal restricted LOGIN. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'recovery-backend-proof',
    environment: 'node',
    include: [
      'src/auth/authority/__tests__/recovery-backend.proof.ts',
      'src/auth/current-store/__tests__/recovery-command-limits.test.ts',
    ],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
