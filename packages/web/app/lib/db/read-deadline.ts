/**
 * No `server-only` marker, deliberately: this file is a timer race with no
 * database handle, no secrets and no server-side data, and the modules that DO
 * hold a pool (`app/lib/data/queries.ts`, `app/lib/db/queries/climbs/…`) carry
 * the marker themselves. Keeping it importable is what lets the bounded-wait
 * oracle in `packages/backend/src/__tests__/db-pool-exhaustion.test.ts` — the
 * only Vitest project in this repo with a live Postgres — exercise it.
 */

/**
 * Wall-clock ceiling for one front-door read: queue wait + connect + execute.
 *
 * 6 s is deliberately *below* `DB_CONNECT_RETRY_BUDGET_MS` (10 s, see
 * docs/db-connectivity.md). On a brownout we want the front door to shed load,
 * not to spend a second and third connect attempt holding a pool slot while a
 * crawler waits. It is also far inside Vercel's function limit and inside
 * Googlebot's patience, and every front-door URL carries a CDN
 * `stale-while-revalidate` window, so a shed request is usually invisible.
 */
export const FRONT_DOOR_READ_DEADLINE_MS = readDeadlineMs();

function readDeadlineMs(): number {
  const raw = process.env.DB_READ_DEADLINE_MS;
  if (!raw) return 6000;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 6000;
}

export class DbReadTimeoutError extends Error {
  readonly code = 'DB_READ_TIMEOUT';

  constructor(label: string, ms: number) {
    super(`[db] front-door read "${label}" exceeded ${ms}ms`);
    this.name = 'DbReadTimeoutError';
  }
}

/** postgres.js `PendingQuery` shape we care about; a plain Promise satisfies it too. */
type Cancellable = { cancel?: () => unknown };

/**
 * Bounds one read client-side.
 *
 * postgres.js has no acquire timeout and its internal queue is unbounded and
 * untimed (`postgres/src/index.js:341`), so a saturated pool turns a cheap
 * statement into an unbounded wait — which is what makes a crawl burst look
 * like a hang rather than an error. This races the pending read against a
 * timer and rejects with `DbReadTimeoutError` when the timer wins.
 *
 * When the pending value is a postgres.js query it is also `.cancel()`ed, the
 * same way `packages/backend/src/services/db-health.ts` does, so a timed-out
 * statement does not become a zombie that fires when the pool recovers.
 * drizzle-issued queries expose no `.cancel()`, so for those this is a deadline
 * without cancellation — the caller still fails fast, the statement still
 * completes in the background.
 */
export async function withReadDeadline<T>(
  label: string,
  pending: PromiseLike<T> & Cancellable,
  ms: number = FRONT_DOOR_READ_DEADLINE_MS,
): Promise<T> {
  // Settle inside the race so cancelling below can never surface as an
  // unhandled rejection.
  const settled = pending.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([settled, deadline]);

    if (outcome === 'timeout') {
      cancelQuietly(pending);
      throw new DbReadTimeoutError(label, ms);
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function cancelQuietly(pending: Cancellable): void {
  if (typeof pending.cancel !== 'function') return;
  try {
    // Typed `void`, but postgres.js hands back a promise when the query already
    // reached the server, so swallow its rejection too.
    const cancelled: unknown = pending.cancel();
    if (cancelled && typeof (cancelled as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(cancelled).catch(() => {});
    }
  } catch {
    // Cancelling is best effort; a failure here must not mask the deadline.
  }
}
