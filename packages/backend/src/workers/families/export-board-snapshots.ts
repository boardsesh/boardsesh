import { and, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { backgroundJobRuns } from '@boardsesh/db/schema';
import { DEFAULT_CATALOG_KEY_PREFIX, runCatalogExportWithOptions } from '../../scripts/export-board-catalog';
import {
  DEFAULT_SNAPSHOT_KEY_PREFIX,
  LIVE_SNAPSHOT_KEY_PREFIX,
  runExportWithOptions,
  snapshotPublicBaseUrl,
  type SnapshotExportDependencies,
  type SnapshotExportLogger,
} from '../../scripts/export-board-snapshots';
import { isS3Configured } from '../../storage/s3';
import { logger } from '../../utils/logger';
import { BackgroundJobError, type BackgroundJobContext, type BackgroundJobFamilyModule } from './types';

/** The live scan's rebuild threshold: one full 500-row GraphQL sync page, as in the workflow. */
export const LIVE_SCAN_REFRESH_THRESHOLD = 500;

/**
 * A live scan that starts more than 14 minutes after it was enqueued is skipped.
 * It waited behind a nightly (or a long scan), and the next scan is due within
 * 15 minutes anyway, so running it late only duplicates that one.
 */
export const LIVE_SCAN_MAX_AGE_SECONDS = 840;

/** The pg-boss heartbeat window (see `heartbeatSeconds` below). */
const HEARTBEAT_SECONDS = 120;

/**
 * How fresh another run's heartbeat must be for it to count as running: three
 * heartbeat windows. One window would let a transient stall (a slow touch, a
 * blocked event loop) make a healthy run look dead and let a second export
 * through; a worker that really died still stops blocking after six minutes.
 */
export const ACTIVE_RUN_WINDOW_SECONDS = 3 * HEARTBEAT_SECONDS;

const payload = z
  .object({
    mode: z.enum(['nightly', 'live-scan']),
    board: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .optional(),
    layout: z.number().int().min(0).max(2_147_483_647).optional(),
    /** Rebuild only layouts with at least this many rows past the live manifest's watermarks. */
    refreshThreshold: z.number().int().positive().max(1_000_000).optional(),
    /** Nightly only: skip the identity (`v1`) pass, like the workflow's `gzip_only` input. */
    gzipOnly: z.boolean().optional(),
  })
  .strict()
  .refine((request) => request.layout === undefined || request.board !== undefined, {
    message: 'layout needs a board',
    path: ['layout'],
  })
  .refine((request) => request.mode === 'nightly' || request.gzipOnly === undefined, {
    message: 'gzipOnly applies to the nightly only',
    path: ['gzipOnly'],
  });

type ExportRequest = z.infer<typeof payload>;

/**
 * The fleet reads manifest URLs directly. Without SNAPSHOT_PUBLIC_BASE_URL the
 * exporter falls back to the store's path-style URL, which Tigris answers with
 * 403 for anonymous reads, so a run without it would publish a manifest no
 * client can follow. No retry fixes a missing variable.
 */
function requireSnapshotStorage(): void {
  if (!isS3Configured('snapshots')) {
    throw new BackgroundJobError('SNAPSHOT_STORAGE_UNCONFIGURED', { retryable: false });
  }
  if (snapshotPublicBaseUrl() === '') {
    throw new BackgroundJobError('SNAPSHOT_PUBLIC_BASE_URL_UNSET', { retryable: false });
  }
}

/**
 * Whether this login reads every session's activity (`pg_read_all_stats`,
 * granted when the batch login is provisioned). The batch login is not the
 * writers' login, so without it the deletion replay observer cannot see a
 * single writer transaction: the live gzip pass would fail closed on every
 * layout. Refuse the run up front with a code that names the missing grant.
 */
async function readsAllSessions(context: BackgroundJobContext): Promise<boolean> {
  const [row] = await context.database.execute<{ reads_all_stats: boolean }>(
    sql`SELECT pg_has_role('pg_read_all_stats', 'USAGE') AS reads_all_stats`,
  );
  return row?.reads_all_stats === true;
}

/**
 * This run's age since enqueue (by the database clock) and which attempt this
 * is (0 for the first). Null when the row is missing.
 */
async function runAge(context: BackgroundJobContext): Promise<{ ageSeconds: number; attemptNumber: number } | null> {
  const [run] = await context.database
    .select({
      ageSeconds: sql<string>`extract(epoch from clock_timestamp() - ${backgroundJobRuns.createdAt})`,
      attemptNumber: backgroundJobRuns.attemptNumber,
    })
    .from(backgroundJobRuns)
    .where(eq(backgroundJobRuns.id, context.runId));
  return run ? { ageSeconds: Number(run.ageSeconds), attemptNumber: run.attemptNumber } : null;
}

/**
 * Whether another export-board-snapshots run is running now. The two modes have
 * separate dedup keys, and one batch replica at WORKER_CONCURRENCY=1 already
 * runs them one at a time; this catches a second replica or an overlapping
 * deploy. A row only counts while its heartbeat is inside
 * ACTIVE_RUN_WINDOW_SECONDS, so a worker that died mid-run stops blocking.
 */
async function anotherRunActive(context: BackgroundJobContext): Promise<boolean> {
  const rows = await context.database
    .select({ id: backgroundJobRuns.id })
    .from(backgroundJobRuns)
    .where(
      and(
        eq(backgroundJobRuns.family, 'export-board-snapshots'),
        eq(backgroundJobRuns.status, 'running'),
        ne(backgroundJobRuns.id, context.runId),
        sql`coalesce(${backgroundJobRuns.heartbeatAt}, ${backgroundJobRuns.startedAt}) > clock_timestamp() - make_interval(secs => ${ACTIVE_RUN_WINDOW_SECONDS})`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Nightly and live board snapshot publication (docs/board-snapshots.md). Reads
 * the primary through the exporter's own `createPool()`, which on the worker is
 * the same two-connection pool as `context.database`, under the batch login.
 * Nothing here writes Postgres: the only fenced statement is the `SELECT 1`
 * before each manifest upload, so an attempt that has lost its run throws
 * there instead of publishing. Every S3 request runs outside the fence.
 */
export const exportBoardSnapshotsFamily: BackgroundJobFamilyModule<ExportRequest> = {
  name: 'export-board-snapshots',
  roles: ['batch'],
  options: {
    // The workflow's 45-minute budget. Its runs took 1 to 14 minutes end to
    // end on GitHub Actions in Sep 2026, setup included; the nightly is the
    // long one.
    expireInSeconds: 2700,
    retryLimit: 1,
    retryDelay: 300,
    retryBackoff: true,
    retryDelayMax: 300,
    // The absolute cap for a run across every attempt. Heartbeats renew the
    // lease, never this deadline, so it must outlive a run whose attempts are
    // kept alive by heartbeat renewals on slow infrastructure (a stalled S3
    // upload, a slow homelab uplink), plus time queued and the retry delay,
    // not just two 45-minute leases. 20 h matches the other batch families
    // and still ends a wedged nightly before the next one is due. The live
    // scan does not rely on it: it skips itself after
    // LIVE_SCAN_MAX_AGE_SECONDS (the ledger deadline is per family, not per
    // payload).
    deadlineSeconds: 72_000,
    // The fence holds the run lock only for a SELECT 1, so the window is sized
    // for the event loop instead: the synchronous SQLite inserts and reading
    // the largest artifact (kilter, about 271 MB raw) back into memory block
    // the heartbeat timer for seconds at a time (the gzip itself runs on the
    // libuv pool), and the touch then queues for one of the pool's two
    // connections while the other holds the export transaction. 120 s covers
    // that with a wide margin, and a dead worker is still noticed within two
    // minutes rather than at the 45-minute lease.
    heartbeatSeconds: HEARTBEAT_SECONDS,
  },
  payload,
  // One key per mode. A shared key would let a queued scan drop the nightly
  // (the only pass that refreshes identity and the catalogue, rebuilds
  // sub-threshold layouts and prunes) and take the key's one retry slot.
  singletonKey: ({ mode }) => mode,
  schedules: [
    { key: 'nightly', cron: '15 7 * * *', fanOut: async () => [{ payload: { mode: 'nightly' } }] },
    { key: 'live-scan', cron: '7,22,37,52 * * * *', fanOut: async () => [{ payload: { mode: 'live-scan' } }] },
  ],
  async execute(context, request) {
    const log: SnapshotExportLogger = logger.child({ family: context.family, runId: context.runId });
    requireSnapshotStorage();
    // pg_read_all_stats is a manual provisioning step (docs/board-snapshots.md),
    // so say on every run whether this login has it: a first deploy without
    // the grant then shows in the log, not only as the failure below.
    const readsAllStats = await readsAllSessions(context);
    log.info('[export-snapshots] replay observer grant', { mode: request.mode, readsAllStats });
    if (!readsAllStats) {
      throw new BackgroundJobError('SNAPSHOT_OBSERVER_UNPRIVILEGED', { retryable: false });
    }

    if (request.mode === 'live-scan') {
      const age = await runAge(context);
      if (age && age.ageSeconds > LIVE_SCAN_MAX_AGE_SECONDS) {
        // A first attempt that waited in the queue is superseded by the next
        // scan and succeeds quietly. A retry that old follows a failed attempt:
        // succeeding would make a scan that keeps failing read green, so it
        // fails the run instead.
        if (age.attemptNumber > 0) throw new BackgroundJobError('LIVE_SCAN_STALE', { retryable: false });
        log.info('[export-snapshots] live scan skipped: it waited too long to start', {
          code: 'LIVE_SCAN_STALE',
          ageSeconds: Math.round(age.ageSeconds),
          maxAgeSeconds: LIVE_SCAN_MAX_AGE_SECONDS,
        });
        return;
      }
    }

    if (await anotherRunActive(context)) {
      // Two exporters on one prefix each merge an older manifest, and the later
      // write drops the other's entries. A scan yields (the next one is at most
      // 15 minutes away); the nightly retries after retryDelay.
      if (request.mode === 'nightly') throw new BackgroundJobError('SNAPSHOT_RUN_ACTIVE');
      log.info('[export-snapshots] live scan skipped: another snapshot run is running', {
        code: 'SNAPSHOT_RUN_ACTIVE',
      });
      return;
    }

    // Once the fence has refused an attempt, every later pass would do its
    // whole export and then be refused too, so stop instead.
    let attemptLost = false;
    const dependencies: SnapshotExportDependencies = {
      signal: context.signal,
      log,
      requireAllRolesVisible: true,
      async beforeManifestPublish() {
        try {
          await context.transaction(async (transaction) => {
            await transaction.execute(sql`SELECT 1`);
          });
        } catch (error) {
          attemptLost = true;
          throw error;
        }
      },
    };
    const filters = { boardFilter: request.board, layoutFilter: request.layout };

    if (request.mode === 'live-scan') {
      await runExportWithOptions(
        {
          dryRun: false,
          gzip: true,
          keyPrefix: LIVE_SNAPSHOT_KEY_PREFIX,
          refreshThreshold: request.refreshThreshold ?? LIVE_SCAN_REFRESH_THRESHOLD,
          source: 'primary',
          fence: false,
          heartbeat: false,
          ...filters,
        },
        dependencies,
      );
      return;
    }

    // The nightly: the workflow's three steps in its order. The identity and
    // live gzip prefixes are independent manifests, so a failed identity pass
    // no longer blocks the pass the fleet reads; the run still fails after
    // both, and its retry repeats them. The catalogue runs last and its failure
    // is only logged, as its consumer is the dev-db image, never the fleet.
    // Operator filters narrow it the way a workflow_dispatch does: a threshold
    // skips the identity and catalogue passes, a board or layout the catalogue.
    const runIdentity = !request.gzipOnly && request.refreshThreshold === undefined;
    const runCatalog =
      request.refreshThreshold === undefined && request.board === undefined && request.layout === undefined;
    const failedPasses: string[] = [];
    const runPass = async (pass: string, fatal: boolean, run: () => Promise<void>): Promise<void> => {
      try {
        await run();
      } catch (error) {
        if (context.signal.aborted || attemptLost) throw error;
        log.error(`[export-snapshots] ${pass} pass failed${fatal ? '' : '; the run continues'}`, {
          pass,
          error: error instanceof Error ? error.message : String(error),
        });
        if (fatal) failedPasses.push(pass);
      }
    };

    if (runIdentity) {
      await runPass('identity', true, () =>
        runExportWithOptions(
          {
            dryRun: false,
            gzip: false,
            keyPrefix: DEFAULT_SNAPSHOT_KEY_PREFIX,
            source: 'primary',
            fence: false,
            heartbeat: false,
            ...filters,
          },
          dependencies,
        ),
      );
    }
    await runPass('gzip', true, () =>
      runExportWithOptions(
        {
          dryRun: false,
          gzip: true,
          keyPrefix: LIVE_SNAPSHOT_KEY_PREFIX,
          refreshThreshold: request.refreshThreshold,
          source: 'primary',
          fence: false,
          heartbeat: false,
          ...filters,
        },
        dependencies,
      ),
    );
    if (runCatalog) {
      await runPass('catalogue', false, () =>
        runCatalogExportWithOptions({ dryRun: false, keyPrefix: DEFAULT_CATALOG_KEY_PREFIX }, dependencies),
      );
    }
    if (failedPasses.length > 0) throw new BackgroundJobError('SNAPSHOT_PASS_FAILED');
  },
};
