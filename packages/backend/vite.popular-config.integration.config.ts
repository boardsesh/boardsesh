import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

const expectedDatabaseUrl = 'postgres://boardsesh_4161:fixture-only-4161@127.0.0.1:32785/boardsesh_pr_sweep_4161';
const expectedContainerId = '47c56beae33b3f73ecce8556290f2f91b24f5f18f44ad538f478ff614126f210';

function assertApproved4161Target(): void {
  if (
    process.env.BOARDSESH_4161_SQL_APPROVED !== '1' ||
    process.env.BOARDSESH_4161_OWNED_CONTAINER_ID !== expectedContainerId ||
    process.env.BOARDSESH_4161_OWNED_PG_PORT !== '32785' ||
    process.env.DATABASE_URL !== expectedDatabaseUrl ||
    process.env.POSTGRES_URL !== expectedDatabaseUrl ||
    process.env.REDIS_URL !== 'redis://127.0.0.1:9/0' ||
    (process.env.READ_REPLICA_URL ?? '') !== '' ||
    process.env.SKIP_TEST_INFRA !== '1'
  ) {
    throw new Error('popular-config integration requires the explicitly approved task-owned 4161 fixture only');
  }
}

// Vite evaluates this config before loading the test module, whose static DB
// imports construct the primary and replica-aware clients.
assertApproved4161Target();

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'backend-owned-popular-config-integration',
    globals: true,
    environment: 'node',
    include: ['src/__tests__/popular-configs-invalid-holds.test.ts'],
    globalSetup: [],
    setupFiles: [],
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
