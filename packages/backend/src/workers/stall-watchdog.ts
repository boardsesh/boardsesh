import type { PgBoss } from 'pg-boss';
import { assertQueuePrimary } from '../services/job-queue-client';
import { logger } from '../utils/logger';

/**
 * The backstop for a worker that has stopped doing work while its process
 * stays up (#6683).
 *
 * A wedged worker used to stay up for days: its `/health` went 503, Docker
 * marked the container unhealthy, and nothing acted on that, because Docker
 * only restarts a container whose process exits. This watchdog turns either of
 * two conditions into an exit, and the compose `restart: unless-stopped` policy
 * starts a fresh process:
 *
 * - **The job queue stays silent for 10 minutes.** Every 30 s, on its own timer,
 *   it runs one real round trip on the worker's pg-boss pool. That keeps it
 *   independent of the probe chain in runtime.ts, which reschedules only after
 *   a probe settles, and of long jobs. A running job never uses the pg-boss
 *   pool: families get no queue client, and every pg-boss call in jobs.ts goes
 *   through the Drizzle adapter. So the round trips keep landing however long a
 *   batch job runs.
 * - **The poll loop is still inside one job 10 minutes after that job's lease
 *   ended.** That is the same wedge on the application pool: a query or call
 *   that never returns inside a job, which the pool round trip cannot see. Past
 *   its lease (`startedOn + expireInSeconds`) the attempt is already lost.
 *   pg-boss expires it, and the attempt fence refuses every write
 *   (`lockActiveQueueAttempt` requires the lease to be current). Heartbeats
 *   never extend the lease, so no job can legitimately still be working by
 *   then.
 *
 * Time is monotonic (`performance.now()`), so a wall-clock step changes
 * nothing. A check that arrives long after the previous one means the process
 * was suspended (a VM backup in suspend mode, `docker pause`) or its event loop
 * was blocked. That is not job-queue silence, so the silence clock restarts
 * instead of being judged.
 *
 * Exiting is a SIGTERM that may not finish draining. Attempts are fenced by
 * token and lease, and the backend supervisor recovers leases, so nothing is
 * replayed or retried here.
 */
export const WORKER_STALL_EXIT_MS = 10 * 60_000;

/** How often the watchdog checks, and starts a round trip when none is in flight. */
export const WORKER_STALL_CHECK_MS = 30_000;

/** A gap this long between two checks means the process could not see the time pass. */
const SUSPENDED_GAP_MS = 2 * WORKER_STALL_CHECK_MS;

export type WorkerStall =
  | { reason: 'job-queue-silent'; silentMs: number }
  | { reason: 'job-past-lease'; overdueMs: number };

/**
 * Start watching. Call it right after a successful round trip (startup's
 * probe), because the silence is measured from now. Calls `onStalled` at most
 * once. Returns a disposer.
 */
export function watchJobQueueStall(options: {
  /** One real round trip on the worker's pg-boss pool. */
  roundTrip: () => Promise<unknown>;
  isStopping: () => boolean;
  /** When the job the poll loop is running loses its lease, on the `now` clock. `undefined` between jobs. */
  jobLeaseEndsAt: () => number | undefined;
  onStalled: (stall: WorkerStall) => void;
  /** Monotonic milliseconds; defaults to `performance.now()`. */
  now?: () => number;
}): () => void {
  const now = options.now ?? (() => performance.now());
  let lastCheck = now();
  let lastSuccess = lastCheck;
  let inFlight = false;
  let finished = false;
  const finish = () => {
    finished = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    if (finished || options.isStopping()) return;
    const checkedAt = now();
    const gapMs = checkedAt - lastCheck;
    lastCheck = checkedAt;
    const leaseEndsAt = options.jobLeaseEndsAt();
    if (leaseEndsAt !== undefined && checkedAt - leaseEndsAt >= WORKER_STALL_EXIT_MS) {
      finish();
      options.onStalled({ reason: 'job-past-lease', overdueMs: checkedAt - leaseEndsAt });
      return;
    }
    if (gapMs > SUSPENDED_GAP_MS) {
      // The process was suspended or blocked: start counting silence again from now.
      lastSuccess = checkedAt;
    } else if (checkedAt - lastSuccess >= WORKER_STALL_EXIT_MS) {
      // Judged before the in-flight guard, so a round trip that never settles
      // still counts as silence instead of parking the check behind it.
      finish();
      options.onStalled({ reason: 'job-queue-silent', silentMs: checkedAt - lastSuccess });
      return;
    }
    if (inFlight) return;
    inFlight = true;
    void Promise.resolve()
      .then(options.roundTrip)
      .then(
        () => {
          lastSuccess = now();
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
  return finish;
}

/**
 * The watchdog as runtime.ts wires it: the round trip runs on `boss`, the
 * worker's own pg-boss pool. A round trip on the application pool would bring
 * #6683 back, because that pool keeps answering while this one is wedged.
 */
export function watchWorkerJobQueue(options: {
  boss: Pick<PgBoss, 'getDb'>;
  role: string;
  isStopping: () => boolean;
  jobLeaseEndsAt: () => number | undefined;
  onStalled: () => void;
}): () => void {
  return watchJobQueueStall({
    roundTrip: () => assertQueuePrimary(options.boss.getDb()),
    isStopping: options.isStopping,
    jobLeaseEndsAt: options.jobLeaseEndsAt,
    onStalled: (stall) => {
      if (stall.reason === 'job-queue-silent') {
        logger.error('[worker] job queue unreachable, exiting so Docker restarts the worker', {
          role: options.role,
          silentSeconds: Math.round(stall.silentMs / 1000),
        });
      } else {
        logger.error('[worker] job still running past its lease, exiting so Docker restarts the worker', {
          role: options.role,
          overdueSeconds: Math.round(stall.overdueMs / 1000),
        });
      }
      options.onStalled();
    },
  });
}
