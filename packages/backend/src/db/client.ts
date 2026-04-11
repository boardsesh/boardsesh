// Re-export db client helpers from @boardsesh/db.
//
// IMPORTANT: the backend intentionally does NOT expose a long-lived pool-backed
// `db` singleton for production code. All reads/writes must go through
// `createRequestDb()` (neon-http, stateless) and all transactions must go
// through `withTransaction()` (ephemeral WebSocket pool that closes
// immediately). This is what lets the Neon compute spin down when the service
// is idle.
//
// The `db` export below is a test-only convenience: in `NODE_ENV=test` (or
// under Vitest), `createDb()` returns a postgres-js client bound to the local
// test database, which supports callback transactions for fixture setup. It
// throws loudly if anyone tries to use it in a non-test environment, which
// prevents it from quietly re-introducing a long-lived pool in production.
import { createDb } from '@boardsesh/db/client';

export {
  createRequestDb,
  withTransaction,
  type RequestDbInstance,
  type TransactionDb,
} from '@boardsesh/db/client';

function isTestEnvironment(): boolean {
  return process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
}

let testDbInstance: ReturnType<typeof createDb> | null = null;

/**
 * Test-only database handle. Backed by postgres-js in test mode so Vitest
 * fixtures can open real transactions and exercise real queries against the
 * local test database. Throws at runtime if referenced outside a test
 * environment — production code must use `createRequestDb()` or
 * `withTransaction()` instead.
 */
export const db = new Proxy({} as ReturnType<typeof createDb>, {
  get(_target, prop) {
    if (!isTestEnvironment()) {
      throw new Error(
        `[db] The 'db' singleton is test-only. Use createRequestDb() for queries or ` +
          `withTransaction() for transactions so the Neon compute can spin down.`,
      );
    }
    if (!testDbInstance) {
      testDbInstance = createDb();
    }
    return Reflect.get(testDbInstance as object, prop);
  },
});
