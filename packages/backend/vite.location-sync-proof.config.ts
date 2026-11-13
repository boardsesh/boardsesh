import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

// Explicit owned full-schema PostGIS fixture; ordinary backend setup never substitutes simplified tables.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'location-sync-proof',
    environment: 'node',
    include: ['src/auth/prototype/location-sync.integration.proof.ts'],
    testTimeout: 40_000,
    hookTimeout: 60_000,
    maxWorkers: 1,
    env: {
      DATABASE_URL: process.env.LOCATION_SYNC_PROOF_DATABASE_URL ?? '',
      NODE_ENV: 'test',
      AUTH_IDENTITY_MIRROR: 'off',
      DEBUG_SQL: 'false',
    },
  },
});
