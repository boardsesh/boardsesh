/**
 * No `server-only` marker, deliberately: this file is a timer race with no
 * database handle, no secrets and no server-side data, and the modules that DO
 * hold a pool (`app/lib/data/queries.ts`, `app/lib/db/queries/climbs/…`) carry
 * the marker themselves. Keeping it importable is what lets the bounded-wait
 * oracle in `packages/backend/src/__tests__/db-pool-exhaustion.test.ts` — the
 * only Vitest project in this repo with a live Postgres — exercise it.
 */

/** The deadline when `DB_READ_DEADLINE_MS` is unset or unparseable. */
export const DEFAULT_READ_DEADLINE_MS = 6000;

/**
 * Wall-clock ceiling for one front-door *request's* reads — queue wait +
 * connect + execute, shared across them by `request-read-budget.ts`. A caller
 * that passes no explicit `ms` gets the whole thing for a single read.
 *
 * 6 s is deliberately *below* `DB_CONNECT_RETRY_BUDGET_MS` (10 s, see
 * docs/db-connectivity.md). On a brownout we want the front door to shed load,
 * not to spend a second and third connect attempt holding a pool slot while a
 * crawler waits. It is also far inside Vercel's function limit and inside
 * Googlebot's patience.
 *
 * It does NOT hide behind the CDN. `stale-while-revalidate` only cushions a URL
 * whose `age` is already past `s-maxage` — climb views are covered for age 1 h
 * to 7 h, lists for 24 h to 7 d — and Vercel supports no `stale-if-error`
 * (https://vercel.com/docs/caching/cdn-cache). A cold-MISS crawl of a long-tail
 * sitemap URL therefore sees the 500 directly. That is still the right answer:
 * 5xx is not a cacheable status on Vercel, so it is never pinned, where the 404
 * this replaces *is* cacheable and could stick for a full `s-maxage`.
 */
export const FRONT_DOOR_READ_DEADLINE_MS = parseReadDeadlineMs(process.env.DB_READ_DEADLINE_MS);

/**
 * Exported for its own test: the constant above is captured at module load, so
 * the parse branches are unreachable from a test that only reads it.
 */
export function parseReadDeadlineMs(raw: string | undefined): number {
  if (!raw) return DEFAULT_READ_DEADLINE_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_READ_DEADLINE_MS;
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

/**
 * What `.cancel()` actually costs, because the two regimes differ and only one
 * of them is free:
 *
 * - **Still queued** — the saturated-pool case this deadline exists for.
 *   `postgres/src/index.js:350` removes the query from the queue and rejects it
 *   locally (`57014`). No connection is opened. The rejection is already handled
 *   because `settled` above attached to `pending` before the race.
 * - **Already executing on the server.** postgres.js opens a *brand new*
 *   connection to send the cancel request. During a brownout that connect can
 *   itself fail, and postgres.js keeps the promise for it internally —
 *   `Query.cancel()` returns `null` (a comma expression ending in an
 *   assignment, `postgres/src/query.js:52`), so there is nothing to attach a
 *   handler to from out here. Such a failure surfaces as an unhandled rejection
 *   that Next's process-level handler logs. Accepted: leaving a zombie
 *   statement to fire against a recovered pool is worse than one log line.
 */
function cancelQuietly(pending: Cancellable): void {
  if (typeof pending.cancel !== 'function') return;
  try {
    pending.cancel();
  } catch {
    // Cancelling is best effort; a failure here must not mask the deadline.
  }
}
