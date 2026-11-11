import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import webConfiguration from '../vite.config';

// Real backend/web proof owns a disposable PostgreSQL database. Keep it out of
// database-free web tests and the web-only Docker build context.
export default defineConfig({
  ...webConfiguration,
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    ...webConfiguration.test,
    name: 'auth-web-credential-proof',
    environment: 'node',
    include: ['auth-prototype/web-credential-proof.integration.proof.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30000,
    hookTimeout: 60000,
    maxWorkers: 1,
  },
});
