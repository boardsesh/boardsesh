import postgres from 'postgres';
import { vi } from 'vite-plus/test';
import type { DbInstance } from '@boardsesh/db/client';

/**
 * Two-connection lock-order proofs: each command runs on its own PostgreSQL
 * connection, one is parked before COMMIT holding every lock it took, and the
 * observer connection reads which statement the other is waiting on and who
 * holds what it waits for.
 */
export function barrier() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

export async function bounded<T>(pending: Promise<T>, milliseconds = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Lock-order race did not settle in time')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A single-connection client named so `pg_stat_activity` can tell the commands apart. */
export function connectAs(databaseName: string, applicationName: string) {
  const address = new URL(
    process.env.AUTH_PROTOTYPE_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5433/postgres',
  );
  address.pathname = `/${databaseName}`;
  return postgres(address.toString(), {
    max: 1,
    onnotice: () => {},
    connection: { application_name: applicationName },
  });
}

/**
 * Wraps one database's transactions so the one whose result `parks` matches
 * waits before COMMIT, still holding every row and advisory lock it took.
 */
export function parkBeforeCommit(database: DbInstance, parks: (result: unknown) => boolean) {
  const reached = barrier();
  const release = barrier();
  const runTransaction = database.transaction.bind(database);
  vi.spyOn(database, 'transaction').mockImplementation(((work, config) =>
    runTransaction(async (transaction) => {
      const result = await work(transaction);
      if (parks(result)) {
        reached.resolve();
        await release.promise;
      }
      return result;
    }, config)) as typeof database.transaction);
  return { reached: reached.promise, release: release.resolve };
}

export interface BlockedStatement {
  readonly query: string;
  readonly blockers: string[];
}

/** The waiting statement of one connection and the application names holding what it waits for. */
export async function blockedStatement(
  observer: ReturnType<typeof postgres>,
  applicationName: string,
  pending: Promise<unknown>,
): Promise<BlockedStatement> {
  const deadline = Date.now() + 5000;
  let settled = false;
  void pending.then(
    () => (settled = true),
    () => (settled = true),
  );
  while (Date.now() < deadline) {
    const [waiting] = await observer<BlockedStatement[]>`
      SELECT waiter.query, array_agg(blocker.application_name ORDER BY blocker.application_name) AS blockers
      FROM pg_stat_activity waiter
      JOIN pg_stat_activity blocker ON blocker.pid = ANY (pg_blocking_pids(waiter.pid))
      WHERE waiter.datname = current_database()
        AND waiter.application_name = ${applicationName}
        AND waiter.wait_event_type = 'Lock'
      GROUP BY waiter.query`;
    if (waiting) return waiting;
    if (settled) throw new Error(`${applicationName} finished without waiting on a lock`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${applicationName} never waited on a lock`);
}
