import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { GraphQLError } from 'graphql';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, ne, notExists, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ConnectionContext, SprayDetectionCandidate, SprayDetectionResult } from '@boardsesh/shared-schema';
import { SPRAY_MAYBE_FLOOR } from '@boardsesh/shared-schema';
import { acquireOrRenewDaemonLease, aliveHoldsAtVersions, releaseDaemonLease } from '@boardsesh/db/queries';
import * as dbSchema from '@boardsesh/db/schema';
import { IDENTITY_HOMOGRAPHY, mapCanonicalHoldsToPhoto, type SprayPhotoHold } from '@boardsesh/spray-wall-geometry';
import { db } from '../../../db/client';
import { logger } from '../../../utils/logger';
import { applyRateLimit, validateInput } from '../shared/helpers';
import { requireAdmin } from '../social/roles';
import { SYSTEM_BOARD_OWNER_ID } from '../board-presence/shared';
import { deleteFromS3, getFromS3Strict, isS3Configured, listS3Objects, uploadToS3 } from '../../../storage/s3';
import {
  SetSprayTrainingReviewInputSchema,
  SprayTrainingQueueArgsSchema,
  SPRAY_HOLD_AUTO_REVIEW_WIRE_NAME,
  SPRAY_TRAINING_REJECT_REASON_BY_WIRE_NAME,
  type SprayTrainingRejectReasonWireName,
  type SprayTrainingReviewStatusWireName,
} from '../../../validation/schemas';
import { presignVersionPhoto } from './spray-walls';

/**
 * Spray wall training data (SW-20, #5471): the admin vetting queue and the
 * scheduler's export. `docs/spray-walls.md`, "Training data: consent, vetting,
 * export", is the narrative; this file is the rules.
 *
 * ## One predicate
 *
 * {@link trainingEligibleCondition} is the single definition of "this version
 * may be used as training data". The queue, the review mutation and the export
 * all filter through it, and the export re-reads it on every run, so switching
 * consent off, deleting or hiding the wall, or deleting the account takes a
 * version out of all three at once — an approval row on its own never exports
 * anything. Switching consent off is written to every wall in the reset family
 * (`updateSprayWall`), so the predicate stays a per-wall test.
 *
 * ## What the admin sees
 *
 * The photo, the holds projected into its pixels, and what the detector
 * suggested with each suggestion's fate. No owner name and no wall name: the
 * question is whether the labels are good, not whose wall it is.
 */

type SprayWallVersionRow = typeof dbSchema.sprayWallVersions.$inferSelect;
type SprayWallHoldRow = typeof dbSchema.sprayWallHolds.$inferSelect;
type SprayDetectionRow = typeof dbSchema.sprayWallDetections.$inferSelect;
type SprayTrainingReviewRow = typeof dbSchema.sprayWallTrainingReviews.$inferSelect;

/** Per-minute ceilings. The review one is high because the dialog is keyboard-driven. */
const QUEUE_RATE_LIMIT = 60;
const REVIEW_RATE_LIMIT = 120;
const DEFAULT_QUEUE_PAGE = 25;

export const SPRAY_TRAINING_CODES = {
  notEligible: 'SPRAY_TRAINING_NOT_ELIGIBLE',
} as const;

// ============================================
// Eligibility
// ============================================

/**
 * Whether a `spray_wall_versions` row may be used as training data. Needs
 * `spray_walls` and `user_boards` joined (see {@link eligibleVersionsFrom}).
 *
 *  - the owner left "Help train hold finding" on (`training_consent_at`);
 *  - the version is not a draft and still has a photo (the retention purge
 *    clears `photo_key`);
 *  - the wall and its board are not deleted, and the wall is not admin-hidden;
 *  - the wall is not a system-owned demo wall;
 *  - it is the newest non-draft version for its `(wall, photo_key)`. A hold
 *    edit publishes a new version that reuses the same photo, and two versions
 *    of one photo are one training image with two label sets: only the newest
 *    is the one the owner stands behind.
 *
 * Archiving is not a test here: an archived wall is still a real photo with
 * holds somebody marked, and archiving only means the wall was reset. It stays
 * eligible for as long as its own `training_consent_at` is set, and switching
 * consent off on ANY wall of its reset family (the live clone included) nulls
 * that stamp too, so the owner's "no" on the wall they still see reaches the
 * older photos of it.
 */
export function trainingEligibleCondition(): SQL {
  const newerVersion = alias(dbSchema.sprayWallVersions, 'newer_training_version');
  return and(
    isNotNull(dbSchema.sprayWalls.trainingConsentAt),
    ne(dbSchema.sprayWallVersions.status, 'draft'),
    isNotNull(dbSchema.sprayWallVersions.photoKey),
    isNull(dbSchema.sprayWalls.deletedAt),
    isNull(dbSchema.userBoards.deletedAt),
    isNull(dbSchema.sprayWalls.hiddenAt),
    ne(dbSchema.userBoards.ownerId, SYSTEM_BOARD_OWNER_ID),
    notExists(
      db
        .select({ one: sql`1` })
        .from(newerVersion)
        .where(
          and(
            eq(newerVersion.wallId, dbSchema.sprayWallVersions.wallId),
            eq(newerVersion.photoKey, dbSchema.sprayWallVersions.photoKey),
            ne(newerVersion.status, 'draft'),
            gt(newerVersion.versionNumber, dbSchema.sprayWallVersions.versionNumber),
          ),
        ),
    ),
  )!;
}

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The columns every caller reads off an eligible version. */
const eligibleVersionColumns = {
  version: dbSchema.sprayWallVersions,
  wallId: dbSchema.sprayWalls.id,
  wallUuid: dbSchema.sprayWalls.boardUuid,
  resetFromWallId: dbSchema.sprayWalls.resetFromWallId,
  trainingConsentAt: dbSchema.sprayWalls.trainingConsentAt,
  isPublic: dbSchema.userBoards.isPublic,
  isUnlisted: dbSchema.userBoards.isUnlisted,
  review: {
    status: dbSchema.sprayWallTrainingReviews.status,
    rejectReason: dbSchema.sprayWallTrainingReviews.rejectReason,
    notes: dbSchema.sprayWallTrainingReviews.notes,
    reviewedAt: dbSchema.sprayWallTrainingReviews.reviewedAt,
  },
};

/** The eligible versions, with the joins the predicate needs, narrowed by `extra`. */
function eligibleVersionsFrom(executor: Executor, extra?: SQL) {
  return executor
    .select(eligibleVersionColumns)
    .from(dbSchema.sprayWallVersions)
    .innerJoin(dbSchema.sprayWalls, eq(dbSchema.sprayWalls.id, dbSchema.sprayWallVersions.wallId))
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .leftJoin(
      dbSchema.sprayWallTrainingReviews,
      eq(dbSchema.sprayWallTrainingReviews.versionId, dbSchema.sprayWallVersions.id),
    )
    .where(and(trainingEligibleCondition(), extra));
}

type EligibleVersion = Awaited<ReturnType<typeof eligibleVersionsFrom>>[number];

/** The SQL that narrows the eligible set to one review status. */
function reviewStatusCondition(status: SprayTrainingReviewStatusWireName): SQL {
  if (status === 'UNREVIEWED') return isNull(dbSchema.sprayWallTrainingReviews.versionId);
  return eq(dbSchema.sprayWallTrainingReviews.status, status === 'APPROVED' ? 'approved' : 'rejected');
}

// ============================================
// Projection, candidates and fates
// ============================================

type CandidateFate = 'KEPT' | 'EDITED' | 'DELETED' | 'NOT_SHOWN' | 'UNKNOWN';

type ProjectedHold = SprayPhotoHold & { autoReview: SprayWallHoldRow['autoReview'] };

type FatedCandidate = SprayDetectionCandidate & { index: number; fate: CandidateFate };

type VersionLabels = {
  holds: ProjectedHold[];
  /** Holds whose canonical position does not land on the photo. */
  unmappableHoldCount: number;
  aliveHolds: SprayWallHoldRow[];
  detection: SprayDetectionRow | null;
  candidates: FatedCandidate[];
};

function detectionCandidates(detection: SprayDetectionRow | null): SprayDetectionCandidate[] {
  const result: SprayDetectionResult | null | undefined = detection?.result;
  return Array.isArray(result?.candidates) ? result.candidates : [];
}

/**
 * Every done detection run for these photos, keyed by `wall_id:photo_key`.
 * Keyed by PHOTO rather than version because a hold-edit version reuses its
 * predecessor's photo and never runs the detector itself.
 */
async function loadDoneDetections(
  executor: Executor,
  versions: readonly SprayWallVersionRow[],
): Promise<Map<string, SprayDetectionRow[]>> {
  const byPhoto = new Map<string, SprayDetectionRow[]>();
  const photoKeys = [...new Set(versions.flatMap((version) => (version.photoKey ? [version.photoKey] : [])))];
  if (photoKeys.length === 0) return byPhoto;
  const rows = await executor
    .select()
    .from(dbSchema.sprayWallDetections)
    .where(
      and(inArray(dbSchema.sprayWallDetections.photoKey, photoKeys), eq(dbSchema.sprayWallDetections.status, 'done')),
    )
    .orderBy(desc(dbSchema.sprayWallDetections.createdAt));
  for (const row of rows) {
    const key = `${row.wallId}:${row.photoKey}`;
    const list = byPhoto.get(key) ?? [];
    list.push(row);
    byPhoto.set(key, list);
  }
  return byPhoto;
}

/**
 * The detection run the version's labels are judged against: the one its holds
 * point back at most, or the newest finished run when none do. Preferring the
 * referenced run keeps a later retry of the detector from turning every kept
 * suggestion into a "deleted" one.
 */
function pickDetection(
  runs: readonly SprayDetectionRow[],
  holds: readonly SprayWallHoldRow[],
): SprayDetectionRow | null {
  if (runs.length === 0) return null;
  const references = new Map<string, number>();
  for (const hold of holds) {
    if (hold.originDetectionId != null) {
      references.set(hold.originDetectionId, (references.get(hold.originDetectionId) ?? 0) + 1);
    }
  }
  let picked = runs[0];
  let pickedReferences = references.get(picked.id) ?? 0;
  for (const run of runs) {
    const runReferences = references.get(run.id) ?? 0;
    if (runReferences > pickedReferences) {
      picked = run;
      pickedReferences = runReferences;
    }
  }
  return picked;
}

/**
 * What happened to each suggestion of `detection`, given the version's alive holds.
 *
 * In order: a hold pointing back at the candidate makes it KEPT, or EDITED when
 * that hold was reshaped (a climber can switch on a candidate under the floor,
 * so the hold is checked first). With no such hold, a candidate under the maybe
 * floor is NOT_SHOWN: the editor never drew it, so nothing the climber did says
 * anything about it. With no hold on the version pointing at this run at all (an
 * app that predates provenance saved them), kept and deleted cannot be told
 * apart: UNKNOWN. Only then is a shown candidate with no hold DELETED.
 */
function candidateFates(
  detection: SprayDetectionRow | null,
  holds: readonly Pick<SprayWallHoldRow, 'originDetectionId' | 'originCandidateIndex' | 'autoReview'>[],
): FatedCandidate[] {
  if (!detection) return [];
  const holdByCandidate = new Map<number, (typeof holds)[number]>();
  for (const hold of holds) {
    if (hold.originDetectionId === detection.id && hold.originCandidateIndex != null) {
      const existing = holdByCandidate.get(hold.originCandidateIndex);
      // Two holds from one candidate (a split): edited if either was.
      if (!existing || hold.autoReview === 'edited') holdByCandidate.set(hold.originCandidateIndex, hold);
    }
  }
  const hasProvenance = holdByCandidate.size > 0;

  return detectionCandidates(detection).map((candidate, index) => {
    const hold = holdByCandidate.get(index);
    let fate: CandidateFate;
    if (hold) fate = hold.autoReview === 'edited' ? 'EDITED' : 'KEPT';
    else if (candidate.confidence < SPRAY_MAYBE_FLOOR) fate = 'NOT_SHOWN';
    else if (!hasProvenance) fate = 'UNKNOWN';
    else fate = 'DELETED';
    return { ...candidate, outline: candidate.outline ?? null, index, fate };
  });
}

/**
 * Alive holds of one version in its photo pixels, with what could not be
 * projected. A singular homography projects nothing, so every hold counts as
 * unmappable; a hold past the projection's horizon or under a pixel is dropped
 * on its own. Either way the version cannot be exported: an image with real
 * holds missing from its labels teaches the model they are background.
 */
function projectHolds(version: SprayWallVersionRow, holds: readonly SprayWallHoldRow[]) {
  const homography = version.homography ?? [...IDENTITY_HOMOGRAPHY];
  const mapped =
    mapCanonicalHoldsToPhoto(
      homography,
      holds.map((hold) => ({
        id: hold.holdId,
        cx: hold.cx,
        cy: hold.cy,
        r: hold.r,
        outline: hold.outline,
        source: hold.source === 'auto' ? ('AUTO' as const) : ('MANUAL' as const),
        confidence: hold.confidence,
      })),
    ) ?? [];
  const autoReviewById = new Map(holds.map((hold) => [hold.holdId, hold.autoReview]));
  const projected: ProjectedHold[] = mapped.map((hold) => ({
    ...hold,
    autoReview: autoReviewById.get(hold.id) ?? null,
  }));
  return { holds: projected, unmappableHoldCount: holds.length - projected.length };
}

/** Holds, candidates and fates for a batch of versions, in a fixed number of queries. */
async function loadVersionLabels(
  executor: Executor,
  versions: readonly SprayWallVersionRow[],
): Promise<Map<number, VersionLabels>> {
  const detectionsByPhoto = await loadDoneDetections(executor, versions);
  // `aliveHolds`'s own range rule, batched: one statement per 200 versions.
  const aliveByVersion = await aliveHoldsAtVersions(
    executor,
    versions.map((version) => Number(version.id)),
  );
  const labels = new Map<number, VersionLabels>();
  for (const version of versions) {
    const alive = aliveByVersion.get(Number(version.id)) ?? [];
    const detection = pickDetection(detectionsByPhoto.get(`${version.wallId}:${version.photoKey}`) ?? [], alive);
    labels.set(Number(version.id), {
      ...projectHolds(version, alive),
      aliveHolds: alive,
      detection,
      candidates: candidateFates(detection, alive),
    });
  }
  return labels;
}

function labelStats(labels: VersionLabels) {
  const autoHolds = labels.aliveHolds.filter((hold) => hold.source === 'auto');
  const fateCount = (fate: CandidateFate) => labels.candidates.filter((candidate) => candidate.fate === fate).length;
  return {
    holdCount: labels.aliveHolds.length,
    manualHoldCount: labels.aliveHolds.length - autoHolds.length,
    autoHoldCount: autoHolds.length,
    acceptedHoldCount: autoHolds.filter((hold) => hold.autoReview === 'accepted').length,
    confirmedHoldCount: autoHolds.filter((hold) => hold.autoReview === 'confirmed').length,
    editedHoldCount: autoHolds.filter((hold) => hold.autoReview === 'edited').length,
    candidateCount: labels.candidates.length,
    keptCandidateCount: fateCount('KEPT'),
    editedCandidateCount: fateCount('EDITED'),
    deletedCandidateCount: fateCount('DELETED'),
    notShownCandidateCount: fateCount('NOT_SHOWN'),
  };
}

// ============================================
// Wire shapes
// ============================================

const REJECT_REASON_WIRE_NAME = Object.fromEntries(
  Object.entries(SPRAY_TRAINING_REJECT_REASON_BY_WIRE_NAME).map(([wireName, stored]) => [stored, wireName]),
) as Record<dbSchema.SprayTrainingRejectReason, SprayTrainingRejectReasonWireName>;

function reviewWire(review: Pick<SprayTrainingReviewRow, 'status' | 'rejectReason' | 'notes' | 'reviewedAt'> | null) {
  if (!review?.status) return { status: 'UNREVIEWED' as const, reason: null, notes: null, reviewedAt: null };
  return {
    status: review.status === 'approved' ? ('APPROVED' as const) : ('REJECTED' as const),
    reason: review.rejectReason == null ? null : REJECT_REASON_WIRE_NAME[review.rejectReason],
    notes: review.notes ?? null,
    reviewedAt: review.reviewedAt ? review.reviewedAt.toISOString() : null,
  };
}

function visibilityWire(row: Pick<EligibleVersion, 'isPublic' | 'isUnlisted'>) {
  if (row.isPublic) return 'PUBLIC' as const;
  if (row.isUnlisted) return 'UNLISTED' as const;
  return 'PRIVATE' as const;
}

function holdWire(hold: ProjectedHold) {
  return {
    id: hold.id,
    cx: hold.cx,
    cy: hold.cy,
    r: hold.r,
    outline: hold.outline ?? null,
    source: hold.source ?? 'MANUAL',
    autoReview: hold.autoReview == null ? null : SPRAY_HOLD_AUTO_REVIEW_WIRE_NAME[hold.autoReview],
    confidence: hold.confidence ?? null,
  };
}

async function queueItem(row: EligibleVersion, labels: VersionLabels) {
  let photo: Awaited<ReturnType<typeof presignVersionPhoto>> = null;
  try {
    photo = await presignVersionPhoto(row.version);
  } catch (error) {
    logger.warn('Failed to presign a spray training photo', { versionId: row.version.id }, error);
  }
  return {
    versionId: String(row.version.id),
    wallUuid: row.wallUuid,
    versionNumber: row.version.versionNumber,
    visibility: visibilityWire(row),
    createdAt: row.version.createdAt.toISOString(),
    publishedAt: row.version.publishedAt?.toISOString() ?? null,
    photo,
    photoWidth: row.version.photoWidth,
    photoHeight: row.version.photoHeight,
    holds: labels.holds.map(holdWire),
    unmappableHoldCount: labels.unmappableHoldCount,
    candidates: labels.candidates.map((candidate) => ({
      index: candidate.index,
      cx: candidate.cx,
      cy: candidate.cy,
      r: candidate.r,
      confidence: candidate.confidence,
      outline: candidate.outline ?? null,
      fate: candidate.fate,
    })),
    detectionModelVersion: labels.detection?.modelVersion ?? null,
    stats: labelStats(labels),
    review: reviewWire(row.review),
  };
}

// ============================================
// Queue and review
// ============================================

async function queueTotals(executor: Executor) {
  const rows = await executor
    .select({ status: dbSchema.sprayWallTrainingReviews.status, total: count() })
    .from(dbSchema.sprayWallVersions)
    .innerJoin(dbSchema.sprayWalls, eq(dbSchema.sprayWalls.id, dbSchema.sprayWallVersions.wallId))
    .innerJoin(dbSchema.userBoards, eq(dbSchema.userBoards.uuid, dbSchema.sprayWalls.boardUuid))
    .leftJoin(
      dbSchema.sprayWallTrainingReviews,
      eq(dbSchema.sprayWallTrainingReviews.versionId, dbSchema.sprayWallVersions.id),
    )
    .where(trainingEligibleCondition())
    .groupBy(dbSchema.sprayWallTrainingReviews.status);
  const totals = { unreviewed: 0, approved: 0, rejected: 0 };
  for (const row of rows) {
    if (row.status === 'approved') totals.approved = Number(row.total);
    else if (row.status === 'rejected') totals.rejected = Number(row.total);
    else totals.unreviewed = Number(row.total);
  }
  return totals;
}

export const sprayTrainingQueries = {
  /**
   * One page of the vetting queue. Unreviewed versions oldest first, so the
   * queue drains in arrival order; reviewed ones newest verdict first.
   */
  sprayTrainingQueue: async (_: unknown, args: unknown, ctx: ConnectionContext) => {
    await requireAdmin(ctx, 'spray');
    await applyRateLimit(ctx, QUEUE_RATE_LIMIT, 'sprayTrainingQueue');
    const { status, limit, offset } = validateInput(SprayTrainingQueueArgsSchema, args, 'args');
    const pageSize = limit ?? DEFAULT_QUEUE_PAGE;

    const query = eligibleVersionsFrom(db, reviewStatusCondition(status));
    const rows = await (
      status === 'UNREVIEWED'
        ? query.orderBy(asc(dbSchema.sprayWallVersions.id))
        : query.orderBy(desc(dbSchema.sprayWallTrainingReviews.reviewedAt), desc(dbSchema.sprayWallVersions.id))
    )
      .limit(pageSize + 1)
      .offset(offset ?? 0);

    const page = rows.slice(0, pageSize);
    const labels = await loadVersionLabels(
      db,
      page.map((row) => row.version),
    );
    const items = await Promise.all(page.map((row) => queueItem(row, labels.get(Number(row.version.id))!)));

    return { items, hasMore: rows.length > pageSize, totals: await queueTotals(db) };
  },
};

export const sprayTrainingMutations = {
  /**
   * Approve, reject or clear one version's verdict. Re-checks eligibility, so a
   * wall whose owner switched consent off between the page load and the key
   * press is refused rather than quietly approved.
   */
  setSprayTrainingReview: async (_: unknown, { input }: { input: unknown }, ctx: ConnectionContext) => {
    await requireAdmin(ctx, 'spray');
    await applyRateLimit(ctx, REVIEW_RATE_LIMIT, 'setSprayTrainingReview');
    const validated = validateInput(SetSprayTrainingReviewInputSchema, input, 'input');
    const adminId = ctx.userId!;

    const review = await db.transaction(async (tx) => {
      const [eligible] = await eligibleVersionsFrom(tx, eq(dbSchema.sprayWallVersions.id, validated.versionId)).limit(
        1,
      );
      if (!eligible) {
        throw new GraphQLError('This wall version is not available as training data', {
          extensions: { code: SPRAY_TRAINING_CODES.notEligible },
        });
      }

      if (validated.status === 'UNREVIEWED') {
        await tx
          .delete(dbSchema.sprayWallTrainingReviews)
          .where(eq(dbSchema.sprayWallTrainingReviews.versionId, validated.versionId));
        return null;
      }

      const values = {
        status: validated.status === 'APPROVED' ? ('approved' as const) : ('rejected' as const),
        rejectReason: validated.reason == null ? null : SPRAY_TRAINING_REJECT_REASON_BY_WIRE_NAME[validated.reason],
        notes: validated.notes ? validated.notes : null,
        reviewedBy: adminId,
        reviewedAt: new Date(),
      };
      const [written] = await tx
        .insert(dbSchema.sprayWallTrainingReviews)
        .values({ versionId: validated.versionId, ...values })
        .onConflictDoUpdate({ target: dbSchema.sprayWallTrainingReviews.versionId, set: values })
        .returning();
      return written;
    });

    logger.info('Spray training review set', { versionId: validated.versionId, status: validated.status, adminId });
    return { versionId: String(validated.versionId), review: reviewWire(review) };
  },

  /**
   * Retire stale training exports and write a new one. Cron-authenticated; the
   * scheduler's `export-spray-training` job is the only caller.
   */
  exportSprayTrainingDataset: async (_: unknown, __: unknown, ctx: ConnectionContext) => {
    if (ctx.transport !== 'http' || !ctx.isCronAuthenticated) {
      throw new GraphQLError('Cron authentication required', {
        extensions: { code: 'UNAUTHENTICATED', http: { status: 401 } },
      });
    }
    return exportSprayTrainingDataset();
  },
};

// ============================================
// Export
// ============================================

/** Every export lives under this prefix in the PRIVATE bucket. */
export const SPRAY_TRAINING_EXPORT_PREFIX = 'spray-training/exports/';
export const SPRAY_TRAINING_EXPORT_SCHEMA_VERSION = 1;
/** How many complete exports are kept. The ML fetch reads the newest. */
export const SPRAY_TRAINING_EXPORTS_KEPT = 2;
/** The `sync_daemon_leases` row that keeps two export runs apart. */
export const SPRAY_TRAINING_EXPORT_LEASE = 'spray-training-export';
/**
 * A run stops writing after this long. Nothing else stops it: the resolver does
 * not watch its HTTP request, and the scheduler's request ends long before this
 * (docs/scheduler.md, "Spray wall training export", lists what ends it and
 * when), so a slow run outlives its caller and is reported as a failed job
 * while it is still writing. This bound is what keeps such a run inside the
 * lease's TTL below.
 */
export const SPRAY_TRAINING_EXPORT_DEADLINE_MS = 12 * 60 * 1000;
/**
 * The lease outlives the deadline by eight minutes, so a run that crashed
 * without releasing it frees the slot long before the next tick six hours
 * later, and a live run can never lose it while it is still allowed to write.
 */
export const SPRAY_TRAINING_EXPORT_LEASE_TTL_MS = 20 * 60 * 1000;
/** Points in the polygon a circle-only hold is exported as. */
const CIRCLE_POLYGON_POINTS = 24;
const EXPORT_CACHE_CONTROL = 'private, no-store';

export type SprayTrainingSplit = 'train' | 'valid' | 'eval';

/** Why a run wrote nothing. LOCKED is the one the scheduler treats as a failure. */
export type SprayTrainingExportSkipReason = 'LOCKED' | 'UNCHANGED' | 'NOTHING_TO_EXPORT';

export type SprayTrainingExportResult = {
  exportId: string | null;
  imagesWritten: number;
  exportsRetired: number;
  skipped: boolean;
  skippedReason: SprayTrainingExportSkipReason | null;
  /** Approved, eligible versions left out of this run's export (see the manifest's `skippedVersions`). */
  versionsSkipped: number;
  durationMs: number;
};

const sha256Hex = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** A 16-hex reference that names a wall in a manifest without its uuid. */
export const trainingRef = (kind: string, value: string) => sha256Hex(`spray-${kind}-ref:${value}`).slice(0, 16);

/**
 * The frozen split for a wall, from the uuid of the ROOT of its reset chain.
 *
 * Keyed by the root so every reset clone of one physical wall lands in the
 * same split: a reset is the same wall photographed again, and a wall in both
 * `train` and `eval` would score the model on a photo it effectively learned.
 * A hash, not a stored column, so the split can never drift between runs and
 * no wall uuid ever has to be committed anywhere to pin it.
 */
export function trainingSplitForRoot(rootWallUuid: string): SprayTrainingSplit {
  const bucket = createHash('sha256').update(`spray-split:${rootWallUuid}`).digest().readUInt32BE(0) % 100;
  if (bucket < 15) return 'eval';
  if (bucket < 25) return 'valid';
  return 'train';
}

/** Follow `reset_from_wall_id` to the root of every chain, batched per generation. */
async function rootWallUuids(executor: Executor, wallIds: readonly number[]): Promise<Map<number, string>> {
  const known = new Map<number, { uuid: string; parentId: number | null }>();
  let pending = [...new Set(wallIds)];
  // No depth cap. A walk cut short would name a wall part-way up as the root,
  // and a wall whose root changes with the length of its chain can change
  // split, which is the one thing the split must never do. Each pass asks only
  // for walls `known` lacks, so the walk ends when the chains do, and it ends
  // on a cycle too (only a hand-edited row could make one).
  while (pending.length > 0) {
    const rows = await executor
      .select({
        id: dbSchema.sprayWalls.id,
        uuid: dbSchema.sprayWalls.boardUuid,
        parentId: dbSchema.sprayWalls.resetFromWallId,
      })
      .from(dbSchema.sprayWalls)
      .where(inArray(dbSchema.sprayWalls.id, pending));
    for (const row of rows) known.set(Number(row.id), { uuid: row.uuid, parentId: row.parentId });
    pending = [
      ...new Set(rows.flatMap((row) => (row.parentId != null && !known.has(row.parentId) ? [row.parentId] : []))),
    ];
  }

  const roots = new Map<number, string>();
  for (const wallId of wallIds) {
    let current = known.get(wallId);
    const seen = new Set<number>();
    let currentId = wallId;
    while (current?.parentId != null && known.has(current.parentId) && !seen.has(currentId)) {
      seen.add(currentId);
      currentId = current.parentId;
      current = known.get(currentId);
    }
    if (current) roots.set(wallId, current.uuid);
  }
  return roots;
}

type CocoAnnotation = {
  id: number;
  image_id: number;
  category_id: 1;
  bbox: [number, number, number, number];
  area: number;
  segmentation: number[][];
  iscrowd: 0;
  /** `mask_from_circle` is present (and `true`) only for a circle-only hold. */
  attributes: { source: 'manual' | 'auto'; auto_review: string | null; mask_from_circle?: true };
};

const round2 = (value: number) => Math.round(value * 100) / 100;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));

/**
 * One hold as a COCO polygon in absolute photo pixels.
 *
 * The outline ring is in units of the hold's radius about its centre; a hold
 * with no outline becomes a 24-point circle, tagged `mask_from_circle` so the
 * trainer can weigh it. The shipped model is a segmentation model and the
 * trainer refuses a hold with no polygon, so every hold gets one. Points are
 * clamped to the frame: a hold straddling the photo edge is still a label for
 * the part that is in it.
 */
function holdPolygon(
  hold: Pick<SprayPhotoHold, 'cx' | 'cy' | 'r' | 'outline'>,
  width: number,
  height: number,
): { points: number[]; fromCircle: boolean } {
  const ring: number[] = [];
  const fromCircle = !hold.outline || hold.outline.length < 6;
  if (fromCircle) {
    for (let step = 0; step < CIRCLE_POLYGON_POINTS; step++) {
      const angle = (2 * Math.PI * step) / CIRCLE_POLYGON_POINTS;
      ring.push(hold.cx + Math.cos(angle) * hold.r, hold.cy + Math.sin(angle) * hold.r);
    }
  } else {
    const outline = hold.outline!;
    for (let index = 0; index + 1 < outline.length; index += 2) {
      ring.push(hold.cx + outline[index] * hold.r, hold.cy + outline[index + 1] * hold.r);
    }
  }
  const points = ring.map((value, index) => round2(clamp(value, 0, index % 2 === 0 ? width : height)));
  return { points, fromCircle };
}

function polygonArea(points: readonly number[]): number {
  let doubled = 0;
  for (let index = 0; index < points.length; index += 2) {
    const next = (index + 2) % points.length;
    doubled += points[index] * points[next + 1] - points[next] * points[index + 1];
  }
  return Math.abs(doubled) / 2;
}

function cocoAnnotation(
  hold: ProjectedHold,
  annotationId: number,
  imageId: number,
  width: number,
  height: number,
): CocoAnnotation | null {
  const { points, fromCircle } = holdPolygon(hold, width, height);
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 === 1);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const boxWidth = round2(Math.max(...xs) - minX);
  const boxHeight = round2(Math.max(...ys) - minY);
  // Entirely off the frame: clamping collapsed it to a line, and a zero-area
  // label teaches nothing.
  if (boxWidth <= 0 || boxHeight <= 0) return null;
  return {
    id: annotationId,
    image_id: imageId,
    category_id: 1,
    bbox: [minX, minY, boxWidth, boxHeight],
    area: round2(polygonArea(points)),
    segmentation: [points],
    iscrowd: 0,
    attributes: {
      source: hold.source === 'AUTO' ? 'auto' : 'manual',
      auto_review: hold.autoReview ?? null,
      ...(fromCircle ? { mask_from_circle: true as const } : {}),
    },
  };
}

/** One line per approved version: what has to match for two exports to be the same. */
function exportFingerprint(rows: readonly EligibleVersion[]): string {
  const lines = rows
    .map(
      (row) =>
        `${row.version.id}:${row.review?.reviewedAt?.toISOString() ?? ''}:${row.trainingConsentAt?.toISOString() ?? ''}`,
    )
    .sort();
  return sha256Hex(`schema:${SPRAY_TRAINING_EXPORT_SCHEMA_VERSION}\n${lines.join('\n')}`);
}

/** What the export reads back out of a stored `manifest.json`. */
type StoredManifest = { exportId: string; fingerprint: string; versionIds: number[] };

function parseManifest(raw: string): StoredManifest | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const images = record.images;
    if (typeof record.exportId !== 'string' || typeof record.fingerprint !== 'string' || !Array.isArray(images)) {
      return null;
    }
    const versionIds = images.map((image) =>
      typeof image === 'object' && image !== null ? Number((image as Record<string, unknown>).versionId) : NaN,
    );
    if (versionIds.some((versionId) => !Number.isInteger(versionId))) return null;
    return { exportId: record.exportId, fingerprint: record.fingerprint, versionIds };
  } catch {
    return null;
  }
}

async function readObjectBuffer(key: string): Promise<Buffer | null> {
  const object = await getFromS3Strict('private', key);
  if (!object) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of object.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const manifestKeyOf = (exportId: string) => `${SPRAY_TRAINING_EXPORT_PREFIX}${exportId}/manifest.json`;

/**
 * Delete stored exports: the `manifest.json` of EVERY one first, then the rest
 * of their objects.
 *
 * An export exists for a reader exactly while its manifest does, and the ML
 * fetch mirrors the newest export that has one. Deleting one export whole
 * before looking at the next would, when a later delete throws, leave an older
 * stale export as the newest one with a manifest, which is the one the fetch
 * then downloads. With every manifest gone before any other object, a run that
 * dies in the second pass leaves none of these exports readable: only prefixes
 * with no manifest, which every reader ignores and the next run finishes
 * deleting.
 *
 * In the order given, which every caller passes newest first. If a manifest
 * delete itself throws, the exports that still have one are then the oldest of
 * the batch, so the newest readable export moves towards a valid one with each
 * delete that did succeed.
 */
async function deleteExports(exports: ReadonlyArray<{ exportId: string; keys: readonly string[] }>): Promise<void> {
  for (const { exportId, keys } of exports) {
    const manifestKey = manifestKeyOf(exportId);
    if (keys.includes(manifestKey)) await deleteFromS3('private', manifestKey);
  }
  for (const { exportId, keys } of exports) {
    const manifestKey = manifestKeyOf(exportId);
    for (const key of keys) {
      if (key !== manifestKey) await deleteFromS3('private', key);
    }
  }
}

/** The stored exports, grouped by id, newest first. */
async function listStoredExports(): Promise<Array<{ exportId: string; keys: string[] }>> {
  const objects = await listS3Objects('private', SPRAY_TRAINING_EXPORT_PREFIX);
  const byExport = new Map<string, string[]>();
  for (const object of objects) {
    const exportId = object.key.slice(SPRAY_TRAINING_EXPORT_PREFIX.length).split('/')[0];
    if (!exportId) continue;
    const keys = byExport.get(exportId) ?? [];
    keys.push(object.key);
    byExport.set(exportId, keys);
  }
  return [...byExport.entries()]
    .map(([exportId, keys]) => ({ exportId, keys }))
    .sort((first, second) => second.exportId.localeCompare(first.exportId));
}

export type ExportSprayTrainingDatasetOptions = {
  /** Injected so a test can mint distinct, ordered export ids. */
  now?: Date;
  /** How long the run may take before it stops writing. Injected by tests. */
  deadlineMs?: number;
};

/** Thrown when a run passes its deadline; the half-written export has no manifest. */
class ExportDeadlineError extends Error {}

/**
 * Retire, compare, write. Separated from the resolver so a test can drive it.
 *
 * ## Overlap
 *
 * One run at a time through a lease row in `sync_daemon_leases`
 * ({@link SPRAY_TRAINING_EXPORT_LEASE}), not an advisory lock held in a
 * transaction: the run spends minutes on object storage, and a transaction open
 * for that long would pin one of the backend's few pooled connections. The lease
 * holds no connection. A second run meeting a live lease answers
 * `skippedReason: LOCKED`, which the scheduler job reports as a failure, so a
 * stuck run cannot quietly break the 24-hour removal promise.
 *
 * The lease has no fencing token (see `sync_daemon_leases`). What keeps two
 * writers apart is that the run stops at {@link SPRAY_TRAINING_EXPORT_DEADLINE_MS},
 * well inside the lease's TTL, and that a run cut short leaves no manifest, which
 * every reader ignores and the next run deletes.
 *
 * ## Reads
 *
 * Short, separate queries, not one snapshot: the approved set is read once at
 * the start and drives both the retirement and the write. A consent switched
 * off while the run is writing is caught by the next run, six hours later,
 * which retires the export that included it. The promise is 24 hours, so two
 * failed runs in a row still land inside it.
 */
export async function exportSprayTrainingDataset({
  now = new Date(),
  deadlineMs = SPRAY_TRAINING_EXPORT_DEADLINE_MS,
}: ExportSprayTrainingDatasetOptions = {}): Promise<SprayTrainingExportResult> {
  const startedAt = Date.now();
  // A backend with no private bucket throws rather than reporting an empty
  // export: "nothing to export" and "nowhere to put it" must not look alike.
  if (!isS3Configured('private')) {
    throw new Error('the private bucket is not configured; nowhere to write a training export');
  }

  const holderId = randomUUID();
  const acquired = await acquireOrRenewDaemonLease(db, {
    daemonName: SPRAY_TRAINING_EXPORT_LEASE,
    holderId,
    hostname: hostname(),
    ttlMs: SPRAY_TRAINING_EXPORT_LEASE_TTL_MS,
  });
  if (!acquired) {
    const locked: SprayTrainingExportResult = {
      exportId: null,
      imagesWritten: 0,
      exportsRetired: 0,
      skipped: true,
      skippedReason: 'LOCKED',
      versionsSkipped: 0,
      durationMs: Date.now() - startedAt,
    };
    logger.warn('Spray training export skipped: another run holds the lease', { ...locked });
    return locked;
  }

  const deadline = startedAt + deadlineMs;
  const checkDeadline = () => {
    if (Date.now() > deadline) {
      throw new ExportDeadlineError(`spray training export passed its ${deadlineMs} ms deadline; no manifest written`);
    }
  };

  try {
    const result = await runExport(now, checkDeadline);
    const finished: SprayTrainingExportResult = { ...result, durationMs: Date.now() - startedAt };
    logger.info('Spray training export finished', { ...finished });
    return finished;
  } finally {
    await releaseDaemonLease(db, { daemonName: SPRAY_TRAINING_EXPORT_LEASE, holderId }).catch((error: unknown) => {
      // The TTL frees it anyway; a failed release only delays the next run if
      // this one somehow ran past it.
      logger.warn('Failed to release the spray training export lease', { holderId }, error);
    });
  }
}

async function runExport(now: Date, checkDeadline: () => void): Promise<Omit<SprayTrainingExportResult, 'durationMs'>> {
  const approved = await eligibleVersionsFrom(db, eq(dbSchema.sprayWallTrainingReviews.status, 'approved')).orderBy(
    asc(dbSchema.sprayWallVersions.id),
  );
  const approvedIds = new Set(approved.map((row) => Number(row.version.id)));

  // 1. Retire. An export holding ANY version that is no longer eligible and
  //    approved goes whole: a training run must never be able to fetch a photo
  //    whose owner switched consent off. Sorted into two lists first and deleted
  //    in one call, so every stale manifest is gone before any export's files
  //    are (see `deleteExports`).
  const stale: Array<{ exportId: string; keys: string[] }> = [];
  const kept: Array<StoredManifest & { keys: string[] }> = [];
  for (const stored of await listStoredExports()) {
    const manifestKey = manifestKeyOf(stored.exportId);
    const manifestBytes = stored.keys.includes(manifestKey) ? await readObjectBuffer(manifestKey) : null;
    const manifest = manifestBytes ? parseManifest(manifestBytes.toString('utf8')) : null;
    // No manifest is a run that died before its last write (the lock rules out
    // one still in flight); its files are an incomplete export nothing reads.
    if (!manifest || manifest.versionIds.some((versionId) => !approvedIds.has(versionId))) stale.push(stored);
    else kept.push({ ...manifest, keys: stored.keys });
  }
  await deleteExports(stale);
  let exportsRetired = stale.length;

  // 2. Skip when nothing changed since the newest export, or nothing is approved.
  const fingerprint = exportFingerprint(approved);
  if (approved.length === 0) {
    return {
      exportId: null,
      imagesWritten: 0,
      exportsRetired,
      skipped: true,
      skippedReason: 'NOTHING_TO_EXPORT',
      versionsSkipped: 0,
    };
  }
  if (kept[0]?.fingerprint === fingerprint) {
    return {
      exportId: null,
      imagesWritten: 0,
      exportsRetired,
      skipped: true,
      skippedReason: 'UNCHANGED',
      versionsSkipped: 0,
    };
  }

  // 3. Write.
  const exportId = now.toISOString().replace(/[:.]/g, '-');
  const prefix = `${SPRAY_TRAINING_EXPORT_PREFIX}${exportId}/`;
  // `{ relative path: sha256 }`, every file but the manifest itself. The ML
  // fetch (`ml/holds/data/user_walls.py`) verifies each one.
  const files: Record<string, string> = {};
  const writeFile = async (path: string, body: Buffer, contentType: string) => {
    await uploadToS3('private', body, `${prefix}${path}`, contentType, { cacheControl: EXPORT_CACHE_CONTROL });
    files[path] = sha256Hex(body);
  };

  const roots = await rootWallUuids(
    db,
    approved.map((row) => row.wallId),
  );
  const labels = await loadVersionLabels(
    db,
    approved.map((row) => row.version),
  );

  // Every split always gets an annotations file, even an empty one: the ML
  // fetch refuses an export missing any of the three. A root wall lands in
  // exactly one split by construction (`trainingSplitForRoot`).
  const coco: Record<SprayTrainingSplit, { images: Array<Record<string, unknown>>; annotations: CocoAnnotation[] }> = {
    train: { images: [], annotations: [] },
    valid: { images: [], annotations: [] },
    eval: { images: [], annotations: [] },
  };
  const splitMembers: Record<SprayTrainingSplit, number[]> = { train: [], valid: [], eval: [] };
  const fateCounts: Record<CandidateFate, number> = { KEPT: 0, EDITED: 0, DELETED: 0, NOT_SHOWN: 0, UNKNOWN: 0 };
  const modelVersions = new Set<string>();
  const manifestImages: Array<Record<string, unknown>> = [];
  const candidateEntries: Array<Record<string, unknown>> = [];
  const consentByWall = new Map<
    number,
    { wallRef: string; rootRef: string; consentAt: string; versionRefs: string[] }
  >();

  // Versions left out of this export, by why. Counted in the manifest so the
  // ML side can see the set is smaller than the approved one.
  const skippedVersions = { unmappableHolds: 0, noHolds: 0, unreadablePhoto: 0 };

  for (const row of approved) {
    checkDeadline();
    const versionId = Number(row.version.id);
    const versionLabels = labels.get(versionId)!;
    // A version with a hold that does not land on the photo would be exported
    // with that real hold unlabelled, teaching the model it is background; one
    // with no holds at all labels the whole wall as background. Neither goes in.
    // The queue shows the unmappable count, so a reviewer sees why.
    if (versionLabels.unmappableHoldCount > 0) {
      skippedVersions.unmappableHolds += 1;
      logger.warn('Spray training export skipped a version with unmappable holds', {
        versionId,
        unmappableHoldCount: versionLabels.unmappableHoldCount,
      });
      continue;
    }
    if (versionLabels.holds.length === 0) {
      skippedVersions.noHolds += 1;
      continue;
    }
    const rootUuid = roots.get(row.wallId) ?? row.wallUuid;
    const split = trainingSplitForRoot(rootUuid);
    const width = row.version.photoWidth ?? 0;
    const height = row.version.photoHeight ?? 0;
    const photo = width > 0 && height > 0 ? await readObjectBuffer(row.version.photoKey!) : null;
    if (!photo) {
      // A photo that is gone (or a row with no size) cannot be a training image.
      // Left out of the manifest, so the export stays self-consistent.
      logger.warn('Spray training export skipped a version with no readable photo', { versionId });
      skippedVersions.unreadablePhoto += 1;
      continue;
    }

    const imageFile = `${split}/v${versionId}.jpg`;
    // Already EXIF-free: the upload handler re-encodes every photo through sharp
    // (`handlers/spray-wall-photos.ts`), so these are the stored bytes as-is.
    await writeFile(imageFile, photo, 'image/jpeg');

    const splitCoco = coco[split];
    const imageId = splitCoco.images.length + 1;
    const rootRef = trainingRef('root', rootUuid);
    const versionRef = trainingRef('version', String(versionId));
    splitCoco.images.push({
      id: imageId,
      file_name: `v${versionId}.jpg`,
      width,
      height,
      boardsesh: { root_ref: rootRef, version_ref: versionRef },
    });
    for (const hold of versionLabels.holds) {
      const annotation = cocoAnnotation(hold, splitCoco.annotations.length + 1, imageId, width, height);
      if (annotation) splitCoco.annotations.push(annotation);
    }

    splitMembers[split].push(versionId);
    for (const candidate of versionLabels.candidates) fateCounts[candidate.fate] += 1;
    if (versionLabels.detection) modelVersions.add(versionLabels.detection.modelVersion);
    candidateEntries.push({
      versionId,
      file: imageFile,
      detectionModelVersion: versionLabels.detection?.modelVersion ?? null,
      candidates: versionLabels.candidates.map((candidate) => ({
        index: candidate.index,
        cx: candidate.cx,
        cy: candidate.cy,
        r: candidate.r,
        confidence: candidate.confidence,
        outline: candidate.outline ?? null,
        fate: candidate.fate,
      })),
    });
    manifestImages.push({
      versionId,
      versionRef,
      rootRef,
      file: imageFile,
      split,
      reviewedAt: row.review?.reviewedAt?.toISOString() ?? null,
      consentAt: row.trainingConsentAt?.toISOString() ?? null,
      holds: versionLabels.holds.length,
    });
    const consent = consentByWall.get(row.wallId) ?? {
      wallRef: trainingRef('wall', row.wallUuid),
      rootRef,
      consentAt: row.trainingConsentAt?.toISOString() ?? '',
      versionRefs: [],
    };
    consent.versionRefs.push(versionRef);
    consentByWall.set(row.wallId, consent);
  }

  const versionsSkipped = skippedVersions.unmappableHolds + skippedVersions.noHolds + skippedVersions.unreadablePhoto;
  if (manifestImages.length === 0) {
    // Nothing approved could be exported. No manifest; the files written so far
    // (none: a version is only written once it passed every check) need no cleanup.
    return {
      exportId: null,
      imagesWritten: 0,
      exportsRetired,
      skipped: true,
      skippedReason: 'NOTHING_TO_EXPORT',
      versionsSkipped,
    };
  }
  checkDeadline();

  for (const [split, payload] of Object.entries(coco)) {
    await writeFile(
      `${split}/_annotations.coco.json`,
      Buffer.from(
        JSON.stringify({
          info: { description: 'Boardsesh spray walls, owner-consented and admin-approved (SW-20)', exportId },
          licenses: [{ id: 1, name: 'Owner consent per wall; internal training only, never redistributed' }],
          categories: [{ id: 1, name: 'hold', supercategory: 'hold' }],
          images: payload.images,
          annotations: payload.annotations,
        }),
      ),
      'application/json',
    );
  }
  await writeFile('candidates.json', Buffer.from(JSON.stringify({ images: candidateEntries })), 'application/json');

  const annotationCounts = Object.fromEntries(
    Object.entries(coco).map(([split, payload]) => [split, payload.annotations.length]),
  );
  const manifest = {
    exportId,
    schemaVersion: SPRAY_TRAINING_EXPORT_SCHEMA_VERSION,
    createdAt: now.toISOString(),
    fingerprint,
    counts: {
      images: Object.fromEntries(Object.entries(splitMembers).map(([split, ids]) => [split, ids.length])),
      annotations: annotationCounts,
      candidateFates: fateCounts,
      skippedVersions,
    },
    modelVersions: [...modelVersions].sort(),
    consentSnapshot: [...consentByWall.values()],
    splits: splitMembers,
    images: manifestImages,
    files,
  };
  // LAST, and only inside the deadline: an export is complete exactly when its
  // manifest exists, and a run past its deadline may be racing a successor.
  checkDeadline();
  await uploadToS3('private', Buffer.from(JSON.stringify(manifest)), `${prefix}manifest.json`, 'application/json', {
    cacheControl: EXPORT_CACHE_CONTROL,
  });

  // Keep the newest few: this one plus the newest still-valid older ones.
  const surplus = kept.slice(SPRAY_TRAINING_EXPORTS_KEPT - 1);
  await deleteExports(surplus);
  exportsRetired += surplus.length;

  return {
    exportId,
    imagesWritten: manifestImages.length,
    exportsRetired,
    skipped: false,
    skippedReason: null,
    versionsSkipped,
  };
}
