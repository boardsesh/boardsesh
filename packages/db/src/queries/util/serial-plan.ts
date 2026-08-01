import { sql } from 'drizzle-orm';
import type { DbInstance } from '../../client/postgres';

/**
 * A drizzle transaction handle, derived from `DbInstance` so this stays in step
 * with the schema-typed client instead of hand-rolling the shape.
 */
type TransactionDb = Parameters<Parameters<DbInstance['transaction']>[0]>[0];

/** A top-level drizzle client, an open transaction, or an execute-only test double. */
export type SerialPlanDb = DbInstance | TransactionDb;

type SerialPlanTransaction = DbInstance['transaction'];
type SerialPlanExecute = (query: unknown) => Promise<unknown>;

/** The statement every guarded query runs before its SELECT. Exported for tests. */
export const SERIAL_PLAN_STATEMENT = 'SET LOCAL max_parallel_workers_per_gather = 0';

function getTransaction(db: SerialPlanDb): SerialPlanTransaction | null {
  const candidate = db as SerialPlanDb & { transaction?: unknown };
  return typeof candidate.transaction === 'function' ? (candidate.transaction.bind(db) as SerialPlanTransaction) : null;
}

function getExecute(db: SerialPlanDb): SerialPlanExecute | null {
  const candidate = db as SerialPlanDb & { execute?: unknown };
  return typeof candidate.execute === 'function' ? (candidate.execute.bind(db) as SerialPlanExecute) : null;
}

/**
 * Run `query` with per-gather parallelism disabled.
 *
 * Postgres allocates a dynamic-shared-memory segment per parallel worker. On a
 * container with a small `/dev/shm` (our Railway Postgres), a handful of
 * concurrent parallel plans exhaust the budget and the driver raises
 * `could not resize shared memory segment ... No space left on device`
 * (pgCode 53100) — issues #1969, #2378, #3856, #4105. The failure mode is a
 * *parallel hash join*: the shared hash table grows its DSA segment by doubling
 * (1 MB → 2 MB → 4 MB), which is exactly the segment-size ladder those incidents
 * report.
 *
 * `SET LOCAL` needs a transaction, and the pool runs `prepare: false` behind
 * PgBouncer transaction pooling, so the guard has to open one explicitly rather
 * than relying on a session-level `SET` (PgBouncer's `DISCARD ALL` on release
 * would wipe it, and it could leak across clients before it did).
 *
 * Apply this to reads that hash-join two large tables (`board_climbs`,
 * `board_climb_stats`, `boardsesh_ticks`) or aggregate across one. A plan that
 * was already serial is unaffected; a plan that was parallel runs single-threaded,
 * which cannot change results — only, at worst, latency.
 *
 * The execute-only fallback exists for query test doubles that expose `execute`
 * but not `transaction`; production call sites always pass a real client, so the
 * transaction branch is what scopes `SET LOCAL` correctly.
 */
export async function withSerialPlan<T>(db: SerialPlanDb, query: (tx: SerialPlanDb) => Promise<T>): Promise<T> {
  const transaction = getTransaction(db);
  if (transaction) {
    return transaction(async (transactionDb) => {
      await transactionDb.execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
      return query(transactionDb);
    });
  }

  const execute = getExecute(db);
  if (execute) {
    await execute(sql`SET LOCAL max_parallel_workers_per_gather = 0`);
  }

  return query(db);
}
