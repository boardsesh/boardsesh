import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// A suite-owned template copy of the fresh canonical proof database; never
// imports shared backend setup. The copy needs the source idle, so CI runs this
// straight after the bootstrap and before any other proof connects.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'identity-import-proof',
    environment: 'node',
    include: ['src/scripts/auth-identities/__tests__/identity-import.proof.ts'],
    testTimeout: 60000,
    hookTimeout: 180000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
