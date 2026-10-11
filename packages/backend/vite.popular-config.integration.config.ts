import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite-plus';

const expectedPort = process.env.BOARDSESH_4161_OWNED_PG_PORT;
const inspectedContainerId = process.env.BOARDSESH_4161_OWNED_CONTAINER_ID;
const expectedDatabaseUrl = `postgres://boardsesh_4161:fixture-only-4161@127.0.0.1:${expectedPort}/boardsesh_pr_sweep_4161`;

function assertApproved4161Target(): void {
  if (
    process.env.BOARDSESH_4161_SQL_APPROVED !== '1' ||
    !inspectedContainerId ||
    !/^[0-9a-f]{64}$/i.test(inspectedContainerId) ||
    !expectedPort ||
    !/^\d+$/.test(expectedPort) ||
    Number(expectedPort) < 1024 ||
    Number(expectedPort) > 65535 ||
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
