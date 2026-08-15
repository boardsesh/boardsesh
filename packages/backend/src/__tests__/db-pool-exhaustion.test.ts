import { describe, expect, it } from 'vite-plus/test';
import postgres from 'postgres';
import { getWorkerDatabaseUrl } from './worker-db';

/**
 * The bounded-wait oracle for #4461, against a live Postgres.
 *
 * postgres.js has no acquire timeout: once every connection in the pool is
 * busy, further statements sit in an unbounded, untimed internal queue. That is
 * what turns a crawl burst into a hang rather than an error, and it is the
 * property `withReadDeadline` exists to bound. Asserting a config value ("max
 * is 4") would prove nothing about it, so this drives a real pool into
 * saturation and measures what the callers see.
 *
 * The helper lives in `packages/web` on purpose — #4461 rules it must NOT go
 * into `packages/db`, which would change behaviour for the backend, the sync
 * runners and every script. The backend project is the only Vitest project in
 * this repo with a live Postgres, so the test has to reach across. The
 * specifier is computed rather than a literal so `tsc --rootDir src` never
 * tries to type-link a file outside this package.
 */
const READ_DEADLINE_MODULE = new URL('../../../web/app/lib/db/read-deadline.ts', import.meta.url).href;

type ReadDeadlineModule = {
  withReadDeadline: <T>(label: string, pending: PromiseLike<T> & { cancel?: () => unknown }, ms?: number) => Promise<T>;
  DbReadTimeoutError: new (label: string, ms: number) => Error & { code: string };
};

/** Far longer than the deadline, so a statement that survives it cannot be mistaken for one that completed. */
const SLEEP_SECONDS = 30;
const DEADLINE_MS = 1500;
const POOL_MAX = 2;
const CONCURRENT_READS = 6;

async function activeSleepCount(admin: postgres.Sql, databaseName: string): Promise<number> {
  const rows = await admin`
    SELECT count(*)::int AS count
    FROM pg_stat_activity
    WHERE datname = ${databaseName}
      AND state = 'active'
      AND query LIKE '%pg_sleep%'
      AND pid <> pg_backend_pid()
  `;
  return rows[0]?.count ?? 0;
}

describe('front-door read deadline under pool exhaustion', () => {
  it('fails every saturated read fast instead of draining the queue serially', async () => {
    const { withReadDeadline, DbReadTimeoutError } = (await import(
      /* @vite-ignore */ READ_DEADLINE_MODULE
    )) as ReadDeadlineModule;

    const url = getWorkerDatabaseUrl();
    const databaseName = new URL(url).pathname.slice(1);
    // `backoff: () => 0` keeps postgres.js's own connect pacing out of the
    // measurement, the same way the connect-retry tests do.
    const pool = postgres(url, { max: POOL_MAX, backoff: () => 0, onnotice: () => {} });
    const admin = postgres(url, { max: 1, onnotice: () => {} });

    try {
      const startedAt = Date.now();
      const outcomes = await Promise.allSettled(
        Array.from({ length: CONCURRENT_READS }, (_, index) =>
          withReadDeadline(`saturation-${index}`, pool`SELECT pg_sleep(${SLEEP_SECONDS})`, DEADLINE_MS),
        ),
      );
      const elapsedMs = Date.now() - startedAt;

      // Serially draining 6 reads through a pool of 2 would take three rounds
      // of SLEEP_SECONDS. Everything must instead land on the deadline.
      expect(elapsedMs).toBeLessThan(DEADLINE_MS * 2);

      const timedOut = outcomes.filter(
        (outcome) => outcome.status === 'rejected' && outcome.reason instanceof DbReadTimeoutError,
      );
      expect(timedOut).toHaveLength(CONCURRENT_READS);

      // The two statements that reached the server must be cancelled, not left
      // to fire when the pool recovers. Poll briefly: the cancel is a separate
      // connection and Postgres tears the backend down asynchronously.
      let remaining = await activeSleepCount(admin, databaseName);
      const cancelDeadline = Date.now() + 2000;
      while (remaining > 0 && Date.now() < cancelDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remaining = await activeSleepCount(admin, databaseName);
      }
      expect(remaining).toBe(0);
    } finally {
      await pool.end({ timeout: 5 });
      await admin.end({ timeout: 5 });
    }
  });
});
