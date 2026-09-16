/**
 * A wall-clock bound on a sitemap read that has no other one.
 *
 * `dbzRead`'s pool sets `connect_timeout: 30` and `statement_timeout` is off by
 * default (PgBouncer rejects it as a startup parameter — see
 * `docs/db-connectivity.md`), so a stalled read would otherwise hold a shard for
 * the whole platform timeout and every caller behind the single-flight with it.
 *
 * Like `withDeadline` in `shard-registry.ts`, this STOPS WAITING rather than
 * cancelling: the abandoned query keeps running and will populate the caches for
 * whoever asks next. Put it INSIDE the shared promise at each call site, so a
 * give-up flows through the same path a query error does — not memoised, seen by
 * every concurrent caller, retried by the next one.
 *
 * One copy, because two config sources want the same bound and a second spelling
 * of it is a second thing to keep in step.
 */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its ${ms}ms budget`)), ms);
    }),
  ]);
}
