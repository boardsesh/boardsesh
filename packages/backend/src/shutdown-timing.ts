/**
 * How long the graceful shutdown in index.ts waits before it gives up and
 * force-exits.
 *
 * This lives in its own module so tests can assert against the real value
 * rather than regex it out of index.ts, which runs `main()` on import and so
 * cannot be pulled into a unit test.
 *
 * It must stay *below* `drainingSeconds` in railway.toml. Railway SIGKILLs the
 * container once the draining window closes, so a force timer above that window
 * would never get to fire — the process would be killed mid-flush instead of
 * exiting on its own terms.
 */
export const FORCE_SHUTDOWN_TIMEOUT_MS = 10_000;
