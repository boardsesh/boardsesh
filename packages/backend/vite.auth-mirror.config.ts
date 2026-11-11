import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';
import backendConfiguration from './vite.config.ts';

// Function-level staged writer qualification only. Production startup stays blocked.
// Existing setup owns its checkout-scoped worker DB; no shared global infra setup.
export default defineConfig({
  ...backendConfiguration,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    ...backendConfiguration.test,
    name: 'auth-mirror',
    globalSetup: [],
    include: ['src/auth/current-store/__tests__/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    fileParallelism: false,
    maxWorkers: 2,
    env: {
      ...backendConfiguration.test?.env,
      TZ: 'UTC',
      // The public mirror task pins this to on; off selects the same suite's baseline.
      AUTH_IDENTITY_MIRROR: process.env.BOARDSESH_MIRROR_PROOF_MODE === 'off' ? 'off' : 'on',
      SKIP_TEST_INFRA: '0',
    },
  },
});
