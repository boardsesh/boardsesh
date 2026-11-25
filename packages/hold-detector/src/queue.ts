import type { ConstructorOptions, WipData } from 'pg-boss';
import { WORKER_JOB_QUEUE_POOL_OPTIONS } from '@boardsesh/db/background-jobs';

/**
 * The detector's pg-boss client. It talks to the Railway primary through the
 * same TCP proxy as the background workers, so it takes their read deadline
 * (#6683). Without it, a fetch sent down a proxy leg that had silently gone
 * waited for an answer forever: from 2026-11-21 the detector stayed "healthy"
 * for four days while claiming no jobs, and every import expired after 24 h.
 */
export function detectorJobQueueOptions(connectionString: string): ConstructorOptions {
  return {
    connectionString,
    max: 3,
    connectionTimeoutMillis: 10_000,
    ...WORKER_JOB_QUEUE_POOL_OPTIONS,
    migrate: false,
    supervise: false,
    schedule: false,
  };
}

/**
 * How long the work loop may go without fetching, finishing a job or reporting
 * an error before the detector counts it as stuck. A healthy idle loop fetches
 * every 2 s. One job is bounded well inside this: a 20 s photo download, at most
 * 90 s of inference, and queue statements that give up after 30 s.
 */
export const WORK_LOOP_STALL_SECONDS = 300;

/**
 * Seconds since the detection worker last showed it is looping, or null when
 * pg-boss has not registered it yet. A failing fetch still counts as looping:
 * the database is down, and restarting the detector would not help.
 */
export function workLoopAgeSeconds(wip: readonly WipData[], queue: string, nowMs: number): number | null {
  const worker = wip.find((candidate) => candidate.name === queue);
  if (!worker) return null;
  const lastSignOfLife = Math.max(
    worker.createdOn,
    worker.lastFetchedOn ?? 0,
    worker.lastJobEndedOn ?? 0,
    worker.lastErrorOn ?? 0,
  );
  return Math.max(0, (nowMs - lastSignOfLife) / 1000);
}

/**
 * How long one health probe may wait before the detector counts its database
 * connections as hung. A probe's pg-boss reads give up after 30 s, but its
 * backlog read goes through the Drizzle pool, which has no read deadline: a
 * query sent down a dead proxy leg there would wait forever, and so would every
 * claim that landed on the same connection. A probe against a database that is
 * down but answering fails within about 141 s: two pg-boss reads at a 10 s
 * checkout plus a 30 s read deadline each, then the Drizzle read's one connect
 * retry (10 s budget), postgres-js's reconnect backoff (capped at 20 s) and its
 * 30 s connect timeout.
 */
export const PROBE_STALL_SECONDS = 180;

/** Whether a probe that started at `startedAtMs` has waited past the limit. */
export function probeHasHung(startedAtMs: number, nowMs: number): boolean {
  return nowMs - startedAtMs >= PROBE_STALL_SECONDS * 1000;
}
