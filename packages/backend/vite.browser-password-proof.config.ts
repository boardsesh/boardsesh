import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

/** Explicit owned existing canonical fixture; no DDL, grants or global-role changes. */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'browser-password-proof',
    environment: 'node',
    include: ['src/auth/authority/__tests__/browser-password-credential-writer.proof.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
