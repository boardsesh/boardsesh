import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Explicit owned full-schema fixture only; never imports shared backend setup.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'credential-writer-proof',
    environment: 'node',
    include: ['src/auth/authority/__tests__/*credential*writer*.proof.ts'],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
