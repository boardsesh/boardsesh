import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import webConfiguration from '../vite.config';

export default defineConfig({
  ...webConfiguration,
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    name: 'registration-credential-writer-proof',
    environment: 'node',
    include: ['auth-proofs/registration-family.integration.proof.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    fileParallelism: false,
  },
});
