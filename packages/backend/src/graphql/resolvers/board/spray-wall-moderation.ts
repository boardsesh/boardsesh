import { GraphQLError } from 'graphql';
import { and, asc, eq, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { SPRAY_WALL_PHOTO_RETENTION_DAYS } from '@boardsesh/board-config';
import * as dbSchema from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { applyRateLimit, requireAuthenticated, validateInput } from '../shared/helpers';
import { requireAdmin } from '../social/roles';
import { ReportSprayWallInputSchema, SetSprayWallHiddenInputSchema, UUIDSchema } from '../../../validation/schemas';
import { deleteFromS3, isS3Configured, listS3Objects } from '../../../storage/s3';
import {
  purgeSprayWallFeedItems,
  refreshPublicWallPhoto,
  SPRAY_WALL_CODES,
  viewerCanSeeSprayWall,
} from './spray-walls';

/**
 * Moderation and retention for spray walls (SW-17, epic #5346).
 *
 * ## Why this is not the climb-proposal machinery
 *
 * `docs/climb-moderation.md` describes a weighted approval threshold over a
 * proposed CHANGE to a climb: several climbers vote, their roles weight the
 * votes, and the outcome is a catalogue edit. That is the right shape when the
 * community knows better than any one person whether a climb's holds are wrong.
 *
 * A wall photograph is a different question. It is somebody's home, the thing
 * being asked is a safety one, and it has exactly one right answer — so there is
 * nothing to vote on. What it needs is a queue somebody reads and one switch,
 * which is what `spray_wall_reports` and `spray_walls.hidden_at` are.
 *
 * ## What hidden means
 *
 * Exactly what private means, for everybody but the owner: the wall leaves gym
 * lists and the boards picker, its uuid and share link stop resolving, and its
 * climbs drop out of every read that carries the spray visibility predicate. The
 * OWNER keeps seeing it, with a notice, because a wall that vanished without a
 * word would look like data loss and because the climbs on it are their work.
 *
 * Hiding is reversible and destroys nothing. Deleting is the owner's own
 * decision, and it is what starts the retention clock below.
 *
 * ## What the purge does
 *
 * {@link purgeDeletedSprayWallPhotos} is the scheduler's half: it deletes the
 * private-bucket objects under `spray-walls/<wallUuid>/` (and any public `media`
 * copy) for walls soft-deleted more than {@link SPRAY_WALL_PHOTO_RETENTION_DAYS}
 * days ago. The ROWS stay: the catalogue rows and every climb ever set on the
 * wall are load-bearing for other people's ticks, and a wall's history is
 * append-only. Only the photographs go.
 */

/** Per-minute ceiling on reports. Low: a climber reports a wall once, ever. */
const REPORT_RATE_LIMIT = 5;
/** Per-minute ceiling on the admin switch, which is only ever pressed by hand. */
const MODERATION_RATE_LIMIT = 30;

/** Wire values of `SprayWallReportReason`, lowercased into the pgEnum. */
const REPORT_REASON_BY_WIRE_NAME = {
  INAPPROPRIATE: 'inappropriate',
  NOT_A_WALL: 'not_a_wall',
  PERSONAL_INFO: 'personal_info',
  OTHER: 'other',
} as const satisfies Record<string, dbSchema.SprayWallReportReason>;

export type SprayWallReportReasonWireName = keyof typeof REPORT_REASON_BY_WIRE_NAME;

type WallRow = typeof dbSchema.sprayWalls.$inferSelect;
type BoardRow = typeof dbSchema.userBoards.$inferSelect;

function notFoundError(): GraphQLError {
  return new GraphQLError('Spray wall not found', { extensions: { code: SPRAY_WALL_CODES.notFound } });
}

/**
 * A live wall by uuid, for moderation.
 *
 * Deliberately does NOT apply the hidden gate: an admin has to be able to act on
 * a wall they have already hidden, and `reportSprayWall` applies the viewer rule
 * itself before it gets here.
 */
async function loadWallForModeration(uuid: string): Promise<{ wall: WallRow; board: BoardRow } | undefined> {
  const [row] = await db
    .select({ wall: dbSchema.sprayWalls, board: dbSchema.userBoards })
    .from(dbSchema.sprayWalls)
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .where(
      and(
        eq(dbSchema.sprayWalls.boardUuid, uuid),
        isNull(dbSchema.sprayWalls.deletedAt),
        isNull(dbSchema.userBoards.deletedAt),
      ),
    )
    .limit(1);
  return row ?? undefined;
}

/**
 * Whether this viewer can see the wall well enough to report it.
 *
 * Delegates to `viewerCanSeeSprayWall` rather than restating the rule. The first
 * version of this file restated it and dropped the gym-member path in the
 * process, so a member of a gym who could see the gym's private wall got "not
 * found" when they tried to report it — which is precisely the person most likely
 * to notice something wrong with it. A visibility rule has one implementation per
 * key, and "can see it" is the uuid one.
 *
 * The uuid rule, not the by-layout one: a report is always made from a wall
 * somebody is looking at, and an unlisted wall someone was sent a link to is
 * exactly the case worth reporting. A wall a viewer cannot see answers "not
 * found", the same as a uuid that is not a wall at all — a report must never be
 * an oracle for which uuids exist.
 */
function viewerCanReport(wall: WallRow, board: BoardRow, userId: string): Promise<boolean> {
  return viewerCanSeeSprayWall(wall, board, userId);
}

export const sprayWallModerationMutations = {
  /**
   * Report a wall. Any signed-in climber who can see it, once per wall.
   *
   * A second report from the same climber is `ALREADY_REPORTED` and writes
   * nothing — the same answer they got the first time, so nothing about the
   * queue's state leaks back to a reporter. Nothing is hidden automatically: the
   * outcome of a report is an admin reading it.
   */
  reportSprayWall: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, REPORT_RATE_LIMIT, 'reportSprayWall');

    const validated = validateInput(ReportSprayWallInputSchema, input, 'input');
    const loaded = await loadWallForModeration(validated.wallUuid);
    if (!loaded || !(await viewerCanReport(loaded.wall, loaded.board, ctx.userId!))) throw notFoundError();

    const reason = REPORT_REASON_BY_WIRE_NAME[validated.reason];
    const inserted = await db
      .insert(dbSchema.sprayWallReports)
      .values({ wallId: loaded.wall.id, reporterId: ctx.userId!, reason })
      // The `where` is not optional here: `spray_wall_reports_wall_reporter_idx` is
      // PARTIAL (`reporter_id IS NOT NULL`), and Postgres refuses to infer a
      // partial index from a bare column list — `ON CONFLICT (wall_id,
      // reporter_id)` alone fails outright with "no unique or exclusion constraint
      // matching the ON CONFLICT specification". Drizzle renders this `where` into
      // the inference position, which is the one that matters. The index predicate
      // and this predicate move together, always.
      .onConflictDoNothing({
        target: [dbSchema.sprayWallReports.wallId, dbSchema.sprayWallReports.reporterId],
        where: sql`${dbSchema.sprayWallReports.reporterId} IS NOT NULL`,
      })
      .returning({ id: dbSchema.sprayWallReports.id });

    const status = inserted.length > 0 ? 'CREATED' : 'ALREADY_REPORTED';
    if (status === 'CREATED') {
      // The wall is named by layout id, never by uuid or name: this line is the
      // moderation trail, and it should not put a stranger's wall name in the logs.
      logger.info('Spray wall reported', { layoutId: loaded.wall.layoutId, reason });
    }
    return { status };
  },

  /**
   * Hide or unhide a wall. Community admins only (`spray`-scoped or global).
   *
   * Hiding also purges the wall's feed rows, for the same reason deleting it
   * does: feed items are served straight out of `feed_items` and would outlive
   * the gate otherwise. Unhiding does NOT put them back — a feed is a record of
   * what happened when, and re-announcing week-old climbs would be a lie. The
   * wall and its climbs come back everywhere else.
   */
  setSprayWallHidden: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx, 'spray');
    await applyRateLimit(ctx, MODERATION_RATE_LIMIT, 'setSprayWallHidden');

    const validated = validateInput(SetSprayWallHiddenInputSchema, input, 'input');
    const loaded = await loadWallForModeration(validated.uuid);
    if (!loaded) throw notFoundError();

    const now = new Date();
    await db.transaction(async (tx) => {
      // Hiding is idempotent on the WRITE, not on what was read before the
      // transaction opened: `loaded` is a snapshot, so two admins pressing the
      // switch together would both see `hidden_at IS NULL` and both stamp their
      // own clock, and the later one would silently move the timestamp an appeal
      // is measured from. The predicate is the guard — a second hide matches no
      // row and changes nothing. An UNhide has no such hazard: null is null.
      const hideGuard = validated.hidden
        ? and(eq(dbSchema.sprayWalls.id, loaded.wall.id), isNull(dbSchema.sprayWalls.hiddenAt))
        : eq(dbSchema.sprayWalls.id, loaded.wall.id);
      await tx
        .update(dbSchema.sprayWalls)
        .set({
          hiddenAt: validated.hidden ? now : null,
          hiddenBy: validated.hidden ? ctx.userId! : null,
          updatedAt: now,
        })
        .where(hideGuard);

      if (validated.hidden) await purgeSprayWallFeedItems(tx, loaded.wall.layoutId);

      // Acting on the wall answers every report waiting on it, whichever way the
      // admin went: an unhide is "looked at it, it is fine", and leaving those
      // rows pending would put the wall back in the queue forever.
      await tx
        .update(dbSchema.sprayWallReports)
        .set({ reviewedAt: now, reviewedBy: ctx.userId! })
        .where(and(eq(dbSchema.sprayWallReports.wallId, loaded.wall.id), isNull(dbSchema.sprayWallReports.reviewedAt)));
    });

    logger.info('Spray wall hidden flag set', {
      layoutId: loaded.wall.layoutId,
      hidden: validated.hidden,
      adminId: ctx.userId,
    });

    // An unhidden PUBLIC wall with no public photo copy gets one now. While a wall
    // is hidden, every path that copies its photo into the world-readable bucket
    // refuses (#5797) — but the owner can still publish it or make it public, so
    // it can come back public with nothing for the gym page, the share card or
    // `publicPhotoUrl` to show, and nothing else would ever copy it. Read fresh
    // after the commit rather than from `loaded`; `refreshPublicWallPhoto`
    // re-checks public / unhidden / still-this-version under the row lock, and
    // never throws.
    if (!validated.hidden) {
      const [unhidden] = await db
        .select({
          isPublic: dbSchema.userBoards.isPublic,
          publicPhotoKey: dbSchema.sprayWalls.publicPhotoKey,
          currentVersionId: dbSchema.sprayWalls.currentVersionId,
          photoKey: dbSchema.sprayWallVersions.photoKey,
        })
        .from(dbSchema.sprayWalls)
        .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
        .innerJoin(dbSchema.sprayWallVersions, eq(dbSchema.sprayWallVersions.id, dbSchema.sprayWalls.currentVersionId))
        .where(eq(dbSchema.sprayWalls.id, loaded.wall.id))
        .limit(1);
      if (unhidden?.isPublic && unhidden.publicPhotoKey == null && unhidden.currentVersionId != null) {
        await refreshPublicWallPhoto(loaded.wall.id, loaded.board.uuid, unhidden.photoKey, unhidden.currentVersionId);
      }
    }

    // Read back rather than echoing the write: under the guard above, a second
    // concurrent hide changes nothing, and reporting its own `now` would tell the
    // admin a timestamp the database does not hold.
    const [current] = await db
      .select({ hiddenAt: dbSchema.sprayWalls.hiddenAt })
      .from(dbSchema.sprayWalls)
      .where(eq(dbSchema.sprayWalls.id, loaded.wall.id))
      .limit(1);

    return {
      uuid: loaded.board.uuid,
      layoutId: loaded.wall.layoutId,
      hidden: current?.hiddenAt != null,
      hiddenAt: current?.hiddenAt ? current.hiddenAt.toISOString() : null,
    };
  },

  /**
   * Delete the photographs of walls soft-deleted more than
   * {@link SPRAY_WALL_PHOTO_RETENTION_DAYS} days ago. Cron-authenticated; the
   * scheduler's `purge-spray-wall-photos` job is the only caller.
   */
  purgeDeletedSprayWallPhotos: async (_: unknown, { limit }: { limit?: number | null }, ctx: ConnectionContext) => {
    if (ctx.transport !== 'http' || !ctx.isCronAuthenticated) {
      throw new GraphQLError('Cron authentication required', {
        extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
      });
    }
    return purgeDeletedSprayWallPhotos({ batchSize: limit ?? undefined });
  },
};

export type SprayWallPhotoPurgeResult = {
  /** Walls whose objects were cleared on this run. */
  wallsPurged: number;
  /** Objects deleted, across both buckets. */
  objectsDeleted: number;
  /**
   * Walls in this run's batch: past the retention window and not yet swept. A run
   * reporting `wallsConsidered: 0` had nothing to do; one where `wallsPurged` is
   * lower than this had storage failures, which are logged per wall.
   */
  wallsConsidered: number;
  durationMs: number;
};

/** How many walls one run clears. A batch so a backlog cannot pin the pool. */
const DEFAULT_PURGE_BATCH_SIZE = 200;

export type PurgeDeletedSprayWallPhotosOptions = {
  /** Injected so a test can drive the threshold instead of waiting 30 days. */
  now?: Date;
  batchSize?: number;
};

/**
 * The purge itself, separated from the resolver so a test can hand it a clock.
 *
 * Deliberately object-first and row-second: the objects are deleted, and only
 * then is `photo_key` cleared. A crash between the two leaves a version pointing
 * at an object that is gone, which reads as a wall with no photo — the same
 * thing the next run would have produced. The other order would leave a key
 * nulled and the object orphaned in the bucket forever, with nothing left that
 * names it.
 *
 * Nothing else about the wall is touched. The catalogue rows and every climb ever
 * set on it are what other people's ticks point at.
 */
export async function purgeDeletedSprayWallPhotos({
  now = new Date(),
  batchSize = DEFAULT_PURGE_BATCH_SIZE,
}: PurgeDeletedSprayWallPhotosOptions = {}): Promise<SprayWallPhotoPurgeResult> {
  const startedAt = Date.now();
  const cutoff = new Date(now.getTime() - SPRAY_WALL_PHOTO_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  // `lt`, not `lte`: a wall deleted exactly at the cutoff is inside the window by
  // a hair, and a retention window should err towards keeping a photo one more
  // run rather than deleting it one run early.
  //
  // **`photos_purged_at IS NULL` is part of the candidate query, not a filter on
  // its results.** A purged wall's row is never deleted, so it stays past the
  // cutoff forever. Selecting the oldest `batchSize` deletions and THEN dropping
  // the ones already done means that once `batchSize` walls have been purged,
  // every run fills its whole batch with no-ops and no wall deleted afterwards is
  // ever reached — a permanent `wallsPurged: 0` that looks exactly like "nothing
  // to do". Pushed into the WHERE, the batch is always real work, and
  // `spray_walls_deleted_at_idx` is partial on exactly this pair.
  const work = await db
    .select({ id: dbSchema.sprayWalls.id, boardUuid: dbSchema.sprayWalls.boardUuid })
    .from(dbSchema.sprayWalls)
    .where(
      and(
        isNotNull(dbSchema.sprayWalls.deletedAt),
        lt(dbSchema.sprayWalls.deletedAt, cutoff),
        isNull(dbSchema.sprayWalls.photosPurgedAt),
      ),
    )
    .orderBy(asc(dbSchema.sprayWalls.deletedAt))
    .limit(batchSize);

  if (work.length === 0) {
    return { wallsPurged: 0, objectsDeleted: 0, wallsConsidered: 0, durationMs: Date.now() - startedAt };
  }

  let objectsDeleted = 0;
  let wallsPurged = 0;

  for (const candidate of work) {
    // The whole PREFIX, not the keys the version rows name. A wall can own objects
    // no version points at: a photo uploaded into the wizard and then abandoned
    // sits in the bucket unreferenced until `createSprayWallVersion` adopts it, and
    // if the climber backs out it never is. Those strays are exactly what a
    // retention sweep is for, and nothing in the database names them — which is
    // why the sweep lists storage and the rows are merely what it clears afterwards.
    const prefix = `spray-walls/${candidate.boardUuid}/`;
    try {
      objectsDeleted += await deletePrefixFromBothBuckets(prefix);
      // Objects first, rows second. A crash between them leaves a version pointing
      // at an object that is gone, which reads as a wall with no photo — the same
      // thing the next run would have produced. The other order would leave a key
      // nulled and the object orphaned in the bucket forever, with nothing left
      // that names it.
      await db
        .update(dbSchema.sprayWallVersions)
        .set({ photoKey: null, updatedAt: now })
        .where(eq(dbSchema.sprayWallVersions.wallId, candidate.id));
      await db
        .update(dbSchema.sprayWalls)
        .set({ photosPurgedAt: now, updatedAt: now })
        .where(eq(dbSchema.sprayWalls.id, candidate.id));
      wallsPurged += 1;
    } catch (error) {
      // One wall's storage failure must not stop the batch, and it must not stamp
      // `photos_purged_at`: nothing was cleared, so the next run takes the wall
      // again. A backend with no `private` bucket lands here for every wall, which
      // is the intended loud no-op.
      logger.warn('Spray wall photo purge failed for one wall', { wallId: Number(candidate.id) }, error);
    }
  }

  const result: SprayWallPhotoPurgeResult = {
    wallsPurged,
    objectsDeleted,
    wallsConsidered: work.length,
    durationMs: Date.now() - startedAt,
  };
  if (wallsPurged > 0) logger.info('Spray wall photos purged', { ...result });
  return result;
}

/**
 * Every object under `prefix`, in both buckets.
 *
 * `private` is where a wall photo lives. `media` is checked as well because it is
 * the world-readable bucket: a resize variant written there by an older path, or
 * by hand, is the one copy that would survive the private-bucket delete and stay
 * fetchable by anybody.
 *
 * **A backend with no `private` bucket THROWS rather than reporting zero
 * objects.** Returning 0 would let the caller clear `photo_key` on a run that
 * deleted nothing — and `photo_key` is the only thing that names the object, so
 * the photograph would be unreachable, unnamed and permanently in the bucket, and
 * the wall would never be a candidate again. A dev backend genuinely has no
 * bucket, which is exactly why this has to be a loud no-op instead of a quiet
 * success. `media` alone missing is fine: the private copy is the one that always
 * exists.
 */
async function deletePrefixFromBothBuckets(prefix: string): Promise<number> {
  if (!isS3Configured('private')) {
    throw new Error('the private bucket is not configured; refusing to clear a photo key nothing would name');
  }

  let deleted = 0;
  for (const bucket of ['private', 'media'] as const) {
    if (!isS3Configured(bucket)) continue;
    const objects = await listS3Objects(bucket, prefix);
    for (const object of objects) {
      await deleteFromS3(bucket, object.key);
      deleted += 1;
    }
  }
  return deleted;
}

/** The pending report queue, newest first. Admins only. */
export const sprayWallModerationQueries = {
  sprayWallReports: async (_: unknown, { uuid }: { uuid: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx, 'spray');
    await applyRateLimit(ctx, MODERATION_RATE_LIMIT, 'sprayWallReports');

    // A pending report on a wall the owner has since deleted is not work: no
    // surface shows the wall, and hiding it would change nothing. It stays in the
    // table as the record of why, and out of the queue.
    const conditions = [isNull(dbSchema.sprayWallReports.reviewedAt), isNull(dbSchema.sprayWalls.deletedAt)];
    if (uuid !== undefined && uuid !== null) {
      const validatedUuid = validateInput(UUIDSchema, uuid, 'uuid');
      conditions.push(eq(dbSchema.sprayWalls.boardUuid, validatedUuid));
    }

    const rows = await db
      .select({
        id: dbSchema.sprayWallReports.id,
        reason: dbSchema.sprayWallReports.reason,
        createdAt: dbSchema.sprayWallReports.createdAt,
        wallUuid: dbSchema.sprayWalls.boardUuid,
        layoutId: dbSchema.sprayWalls.layoutId,
        hiddenAt: dbSchema.sprayWalls.hiddenAt,
      })
      .from(dbSchema.sprayWallReports)
      .innerJoin(dbSchema.sprayWalls, eq(dbSchema.sprayWalls.id, dbSchema.sprayWallReports.wallId))
      .where(and(...conditions))
      .orderBy(sql`${dbSchema.sprayWallReports.createdAt} DESC`)
      .limit(200);

    return rows.map((row) => ({
      id: String(row.id),
      wallUuid: row.wallUuid,
      layoutId: row.layoutId,
      reason: reportReasonWireName(row.reason),
      hidden: row.hiddenAt != null,
      createdAt: row.createdAt.toISOString(),
    }));
  },
};

/** The pgEnum value back as its GraphQL name. */
function reportReasonWireName(reason: dbSchema.SprayWallReportReason): SprayWallReportReasonWireName {
  const entry = Object.entries(REPORT_REASON_BY_WIRE_NAME).find(([, value]) => value === reason);
  // Unreachable while the two lists agree; `other` is the honest fallback rather
  // than throwing on a row a future migration added.
  return (entry?.[0] as SprayWallReportReasonWireName) ?? 'OTHER';
}
