import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import backendConfiguration from '../vite.config';
import { ownedAppRouterAdminDatabase } from '../src/auth/current-store/__tests__/fixtures/app-router-owned-db';

// Explicit browser proof owns these local services. It never selects user5433.
const databaseUrl = ownedAppRouterAdminDatabase(process.env.BOARDSESH_AUTH_PROOF_DATABASE_URL);
const environment = {
  DATABASE_URL: databaseUrl,
  READ_REPLICA_URL: databaseUrl,
  REDIS_URL: 'redis://127.0.0.1:15476',
  SKIP_TEST_INFRA: '1',
  BOARDSESH_TEST_DB_SALT: `web-oauth-browser-${randomUUID()}`,
};
Object.assign(process.env, environment);

export default {
  ...backendConfiguration,
  root: fileURLToPath(new URL('../', import.meta.url)),
  test: {
    ...backendConfiguration.test,
    include: ['src/auth/current-store/__tests__/web-oauth-browser.proof.ts'],
    maxWorkers: 1,
    env: { ...backendConfiguration.test?.env, ...environment },
  },
};
