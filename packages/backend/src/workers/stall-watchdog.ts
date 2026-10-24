/**
 * The backstop for a worker whose job queue has stopped answering (#6683).
 *
 * A wedged worker used to stay up for days: its `/health` went 503, Docker
 * marked the container unhealthy, and nothing acted on that, because Docker
 * only restarts a container whose process exits. This watchdog turns "the job
 * queue has not answered for 10 minutes" into an exit, and the compose
 * `restart: unless-stopped` policy starts a fresh process.
 *
 * It measures a real round trip on the worker's pg-boss pool, run on its own
 * timer. That keeps it independent of two things that can look like a stall
 * without being one:
 *
 * - The probe chain in runtime.ts reschedules only after a probe settles, so a
 *   probe stuck on the application pool would freeze any check made there.
 * - A long job. A running job never uses the pg-boss pool: families get no
 *   queue client, and every pg-boss call in jobs.ts goes through the Drizzle
 *   adapter. So the round trip keeps succeeding however long a batch job runs.
 *
 * Exiting is a SIGTERM that may not finish draining. Attempts are fenced by
 * token and lease, and the backend supervisor recovers leases, so nothing is
 * replayed or retried here.
 */
export const WORKER_STALL_EXIT_MS = 10 * 60_000;

/** How often the watchdog checks, and starts a round trip when none is in flight. */
export const WORKER_STALL_CHECK_MS = 30_000;

/**
 * Start watching. Call it right after a successful round trip (startup's
 * probe), because the silence is measured from now. Calls `onStalled` at most
 * once. Returns a disposer.
 */
export function watchJobQueueStall(options: {
  /** One real round trip on the worker's pg-boss pool. */
  roundTrip: () => Promise<unknown>;
  isStopping: () => boolean;
  onStalled: (silentMs: number) => void;
}): () => void {
  let lastSuccess = Date.now();
  let inFlight = false;
  let finished = false;
  const timer = setInterval(() => {
    if (finished || options.isStopping()) return;
    // Judged before anything else, so a round trip that never settles still
    // counts as silence instead of parking the check behind it.
    const silentMs = Date.now() - lastSuccess;
    if (silentMs >= WORKER_STALL_EXIT_MS) {
      finished = true;
      clearInterval(timer);
      options.onStalled(silentMs);
      return;
    }
    if (inFlight) return;
    inFlight = true;
    void Promise.resolve()
      .then(options.roundTrip)
      .then(
        () => {
          lastSuccess = Date.now();
        },
        () => {
          // A failed round trip is the silence this measures; there is nothing else to do.
        },
      )
      .finally(() => {
        inFlight = false;
      });
  }, WORKER_STALL_CHECK_MS);
  timer.unref();
  return () => {
    finished = true;
    clearInterval(timer);
  };
}
