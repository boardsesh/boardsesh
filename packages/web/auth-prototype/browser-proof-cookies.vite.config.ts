import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import webConfiguration from '../vite.config';

// Explicit owned HTTPS/browser+canonical-token proof. No application server or
// production URL is mounted; the existing authority helper owns a fresh DB.
export default defineConfig({
  ...webConfiguration,
  root: fileURLToPath(new URL('..', import.meta.url)),
  test: {
    ...webConfiguration.test,
    name: 'browser-proof-cookie-codec',
    environment: 'node',
    include: ['auth-prototype/browser-proof-cookies.proof.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
  },
});
