/**
 * Re-request recognition for spray-wall imports that expired during a hold
 * detector outage. Dry run by default; `--apply` writes.
 *
 * While the detector claims nothing, every detection waits out its 24-hour
 * pending lifetime and the backend's reconcile marks it `failed` with
 * `QUEUE_EXPIRED`. The climber then has to find Retry to get proposed holds.
 * This queues each such import again through the request path the API uses
 * (`requestSprayDetection`), for the original requester, so the completion
 * notification reaches them.
 *
 * In a backend shell, from /app/packages/backend (the image has no `vp`):
 *
 *   node --import tsx src/scripts/revive-expired-spray-detections.ts --since 2026-11-21T07:00:00Z
 *   node --import tsx src/scripts/revive-expired-spray-detections.ts --since 2026-11-21T07:00:00Z --apply
 *
 * `--until` (exclusive) bounds the window from above. Uses the service's
 * DATABASE_URL: the writable primary. Every eligibility rule is checked again
 * inside the write transaction, under the locks the API takes, and a revived
 * row is no longer the latest for its draft, so a second `--apply` revives
 * nothing. Output carries truncated ids only, and a failure prints the error's
 * class and code, never its message.
 *
 * Runbook: docs/product/spray-recognition-rollout.md, "Reviving imports that
 * expired during a detector outage".
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { and, asc, desc, eq, gte, isNull, lt, or } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { closePool, getConnectionConfig } from '@boardsesh/db/client';
import { sprayWallDetections, sprayWallHolds, sprayWallVersions, sprayWalls, userBoards } from '@boardsesh/db/schema';
import { db } from '../db/client';
import type { DbTransaction } from '../db/after-commit';
import { canEditBoard } from '../graphql/resolvers/social/boards';
import { assertQueuePrimary, createJobQueueClient } from '../services/job-queue-client';
import {
  lockSprayDetectionRequest,
  requestSprayDetection,
  type SprayDetectionRow,
} from '../services/spray-detection-request';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';

const LOG_PREFIX = '[revive-expired-spray-detections]';

export type RevivalOptions = {
  since: Date;
  /** Exclusive upper bound on the expired detection's `created_at`; null for no bound. */
  until: Date | null;
  apply: boolean;
};

export type RevivalSkipReason =
  | 'requester-gone'
  | 'wall-deleted'
  | 'wall-archived'
  | 'board-deleted'
  | 'not-draft'
  | 'photo-changed'
  | 'superseded'
  | 'manual-edits'
  | 'no-edit-access';

export type RevivalDecision = {
  expiredId: string;
  wallUuid: string;
  requestedBy: string | null;
  createdAt: Date;
  decision: 'revive' | `skip:${RevivalSkipReason}`;
  /** The new detection's id; set only when `--apply` revived the import. */
  revivedId: string | null;
};

/** A bad command line. Its message is ours and safe to print, unlike any other failure's. */
export class RevivalArgumentError extends Error {
  override name = 'RevivalArgumentError';
}

const ISO_TIMESTAMP_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

function parseTimestamp(flag: string, argument: string | undefined): Date | null {
  if (argument === undefined) return null;
  const parsed = new Date(argument);
  // A zone is required: a bare local time would mean a different window on
  // every operator's machine.
  if (!ISO_TIMESTAMP_WITH_ZONE.test(argument) || Number.isNaN(parsed.getTime())) {
    throw new RevivalArgumentError(`${flag} must be an ISO timestamp with a zone, such as 2026-11-21T07:00:00Z`);
  }
  return parsed;
}

export function parseArgs(argv: readonly string[]): RevivalOptions {
  const timestamps = new Map<string, string>();
  let apply = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--apply') {
      if (apply) throw new RevivalArgumentError('Duplicate option: --apply');
      apply = true;
    } else if (flag === '--since' || flag === '--until') {
      if (timestamps.has(flag)) throw new RevivalArgumentError(`Duplicate option: ${flag}`);
      const argument = argv[++index];
      if (!argument || argument.startsWith('--')) throw new RevivalArgumentError(`${flag} requires an ISO timestamp`);
      timestamps.set(flag, argument);
    } else {
      throw new RevivalArgumentError(`Unknown option: ${flag}`);
    }
  }
  const since = parseTimestamp('--since', timestamps.get('--since'));
  if (!since) throw new RevivalArgumentError('--since is required');
  const until = parseTimestamp('--until', timestamps.get('--until'));
  if (until && until.getTime() <= since.getTime()) throw new RevivalArgumentError('--until must be after --since');
  return { since, until, apply };
}

async function findExpiredDetections({ since, until }: Pick<RevivalOptions, 'since' | 'until'>) {
  return db
    .select({ detection: sprayWallDetections, wallUuid: sprayWalls.boardUuid })
    .from(sprayWallDetections)
    .innerJoin(sprayWalls, eq(sprayWalls.id, sprayWallDetections.wallId))
    .where(
      and(
        eq(sprayWallDetections.status, 'failed'),
        eq(sprayWallDetections.error, 'QUEUE_EXPIRED'),
        gte(sprayWallDetections.createdAt, since),
        until ? lt(sprayWallDetections.createdAt, until) : undefined,
      ),
    )
    .orderBy(asc(sprayWallDetections.createdAt), asc(sprayWallDetections.id));
}

/**
 * Why this expired import must not be queued again, or null when it may be.
 * Takes the request locks first, so nothing it read can change before the
 * same transaction queues the new detection.
 */
async function revivalBlocker(
  transaction: DbTransaction,
  expired: SprayDetectionRow,
  requestedBy: string,
): Promise<RevivalSkipReason | null> {
  await lockSprayDetectionRequest(transaction, { requestedBy, wallId: expired.wallId });
  const [source] = await transaction
    .select({ wall: sprayWalls, board: userBoards, version: sprayWallVersions })
    .from(sprayWalls)
    .leftJoin(userBoards, eq(userBoards.uuid, sprayWalls.boardUuid))
    .leftJoin(
      sprayWallVersions,
      and(eq(sprayWallVersions.id, expired.versionId), eq(sprayWallVersions.wallId, sprayWalls.id)),
    )
    .where(eq(sprayWalls.id, expired.wallId))
    .limit(1);
  if (!source || source.wall.deletedAt) return 'wall-deleted';
  if (source.wall.archivedAt) return 'wall-archived';
  if (!source.board || source.board.deletedAt) return 'board-deleted';
  const { version, board } = source;
  if (!version || version.status !== 'draft') return 'not-draft';
  if (
    version.photoKey !== expired.photoKey ||
    version.photoWidth !== expired.photoWidth ||
    version.photoHeight !== expired.photoHeight
  ) {
    return 'photo-changed';
  }
  const [latest] = await transaction
    .select({ id: sprayWallDetections.id })
    .from(sprayWallDetections)
    .where(and(eq(sprayWallDetections.versionId, version.id), eq(sprayWallDetections.photoKey, expired.photoKey)))
    .orderBy(desc(sprayWallDetections.createdAt), desc(sprayWallDetections.id))
    .limit(1);
  if (latest?.id !== expired.id) return 'superseded';
  // The climber edited holds by hand while waiting: placed one on this draft,
  // or took one off. A late proposal would sit on top of their work, so leave
  // this draft alone.
  const [editedHold] = await transaction
    .select({ holdId: sprayWallHolds.holdId })
    .from(sprayWallHolds)
    .where(
      or(
        and(eq(sprayWallHolds.installedVersionId, version.id), isNull(sprayWallHolds.removedVersionId)),
        eq(sprayWallHolds.removedVersionId, version.id),
      ),
    )
    .limit(1);
  if (editedHold) return 'manual-edits';
  // The same rule `loadEditableWall` applies to the API request.
  if (!(await canEditBoard(requestedBy, board, transaction))) return 'no-edit-access';
  return null;
}

async function decide(
  expired: SprayDetectionRow,
  boss: Pick<PgBoss, 'send'> | null,
): Promise<Pick<RevivalDecision, 'decision' | 'revivedId'>> {
  const requestedBy = expired.requestedBy;
  if (!requestedBy) return { decision: 'skip:requester-gone', revivedId: null };
  return db.transaction(
    async (transaction): Promise<Pick<RevivalDecision, 'decision' | 'revivedId'>> => {
      const blocker = await revivalBlocker(transaction, expired, requestedBy);
      if (blocker) return { decision: `skip:${blocker}`, revivedId: null };
      if (!boss) return { decision: 'revive', revivedId: null };
      // No hourly limit on this path. The limit stops one client flooding the
      // detector; these are requests the climber already made once, and one
      // person can have more expired imports than the limit allows in an hour.
      const requested = await requestSprayDetection(transaction, boss, {
        wallId: expired.wallId,
        versionId: expired.versionId,
        requestedBy,
        retryOf: expired.id,
        enforceHourlyLimit: false,
      });
      switch (requested.kind) {
        case 'created':
          return { decision: 'revive', revivedId: requested.detection.id };
        case 'existing':
          return { decision: 'skip:superseded', revivedId: null };
        case 'invalid-draft':
          return { decision: 'skip:not-draft', revivedId: null };
        case 'rate-limited':
          throw new Error('Operator revival hit the hourly limit it should skip');
      }
    },
    // A dry run cannot write, whatever the code above does.
    boss ? undefined : { accessMode: 'read only' },
  );
}

/**
 * What a failure prints: the error's class and its Postgres or driver code.
 * Never the message: a Drizzle query error's message lists the bound
 * parameters, which here include the requester's id and the photo key.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof RevivalArgumentError) return error.message;
  const errorClass = error instanceof Error ? error.constructor.name || error.name : typeof error;
  const code = getPostgresErrorCode(error);
  // A code is an identifier such as `23503` or `ECONNREFUSED`; anything else is dropped.
  return code && /^[0-9A-Z_]{1,40}$/.test(code) ? `${errorClass} code=${code}` : errorClass;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

export function formatDecision(decision: RevivalDecision): string {
  return [
    `detection=${shortId(decision.expiredId)}`,
    `wall=${shortId(decision.wallUuid)}`,
    `requester=${decision.requestedBy ? shortId(decision.requestedBy) : '-'}`,
    `created=${decision.createdAt.toISOString()}`,
    decision.decision,
    ...(decision.revivedId ? [`new=${shortId(decision.revivedId)}`] : []),
  ].join(' ');
}

/**
 * Decide, and with a queue revive, every expired import in the window. One
 * transaction per import: a failure stops the run, and a rerun skips what
 * already went through.
 */
export async function reviveExpiredSprayDetections(
  options: Pick<RevivalOptions, 'since' | 'until'> & {
    /** Null is a dry run. */
    boss: Pick<PgBoss, 'send'> | null;
    report: (line: string) => void;
  },
): Promise<RevivalDecision[]> {
  const decisions: RevivalDecision[] = [];
  for (const { detection, wallUuid } of await findExpiredDetections(options)) {
    const outcome = await decide(detection, options.boss);
    const decision: RevivalDecision = {
      expiredId: detection.id,
      wallUuid,
      requestedBy: detection.requestedBy,
      createdAt: detection.createdAt,
      ...outcome,
    };
    decisions.push(decision);
    options.report(formatDecision(decision));
  }
  return decisions;
}

async function main(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv);
  const report = (line: string) => process.stdout.write(`${line}\n`);
  let boss: PgBoss | null = null;
  try {
    if (options.apply) {
      // `worker` only switches off scheduling and supervision: this process
      // sends jobs and leaves queue maintenance to the backend.
      boss = createJobQueueClient({
        connectionString: getConnectionConfig().connectionString,
        poolSize: 1,
        owner: 'worker',
      });
      await boss.start();
      await assertQueuePrimary(boss.getDb());
    }
    const decisions = await reviveExpiredSprayDetections({ since: options.since, until: options.until, boss, report });
    const revived = decisions.filter((decision) => decision.decision === 'revive').length;
    const window = `${options.since.toISOString()} to ${options.until?.toISOString() ?? 'now'}`;
    report(
      `${LOG_PREFIX} ${decisions.length} expired import(s) from ${window}: ` +
        `${revived} ${options.apply ? 'revived' : 'to revive'}, ${decisions.length - revived} skipped.`,
    );
    if (!options.apply) report(`${LOG_PREFIX} dry run: nothing was written. Re-run with --apply to queue them.`);
  } finally {
    await boss?.stop({ graceful: false, close: true });
  }
}

// Only when executed directly; the tests import the functions above.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2))
    .catch((error: unknown) => {
      logger.error(`${LOG_PREFIX} failed: ${describeFailure(error)}`);
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
