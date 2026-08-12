import crypto from 'crypto';
import { GraphQLError } from 'graphql';
import { and, eq, sql } from 'drizzle-orm';
import {
  type ConnectionContext,
  type SaveClimbResult,
  type UpdateClimbResult,
  SUPPORTED_BOARDS,
  CLIMB_CHARACTERISTICS,
  isNoMatchClimb,
  withCharacteristic,
  withNoMatch,
  getMoonBoardMethod,
} from '@boardsesh/shared-schema';
import { holdIdToCoordinate } from '@boardsesh/board-config';
import type { BoardName } from '@boardsesh/board-constants';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { UNIFIED_TABLES, isValidBoardName } from '../../../db/queries/util/table-select';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';
import { publishSocialEvent } from '../../../events';
import { notifyClimbRevalidated } from '../../../lib/web-revalidate';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import { requireAdminOrLeader } from '../social/roles';
import {
  buildMoonBoardClimbHoldRows,
  buildMoonBoardHoldSignature,
  buildMoonBoardDuplicateError,
  encodeMoonBoardHoldsToFrames,
  findMoonBoardDuplicateMatch,
  normalizeMoonBoardHolds,
} from './moonboard-duplicates';
import {
  CLIMB_DUPLICATE_ERROR_CODE,
  buildDuplicateClimbErrorMessage,
  buildHoldSignature,
  acquireDuplicateGateLock,
  findExactDuplicateMatch,
  parseFramesToHoldEntries,
} from './climb-similarity';
import {
  BoardNameSchema,
  ExternalUUIDSchema,
  SaveClimbInputSchema,
  SaveMoonBoardClimbInputSchema,
  UpdateClimbInputSchema,
  UpdateMoonBoardClimbInputSchema,
} from '../../../validation/schemas';

type SaveClimbArgs = { input: unknown };
type DeleteDraftClimbArgs = { uuid: unknown; boardType: unknown };

function generateClimbUuid(): string {
  // Match Aurora-style uppercase UUID without dashes
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

async function getUserProfile(userId: string) {
  const [user] = await db
    .select({
      name: dbSchema.users.name,
      image: dbSchema.users.image,
      displayName: dbSchema.userProfiles.displayName,
      avatarUrl: dbSchema.userProfiles.avatarUrl,
    })
    .from(dbSchema.users)
    .leftJoin(dbSchema.userProfiles, eq(dbSchema.users.id, dbSchema.userProfiles.userId))
    .where(eq(dbSchema.users.id, userId))
    .limit(1);

  return {
    displayName: user?.displayName || user?.name || '',
    name: user?.name || '',
    avatarUrl: user?.avatarUrl || user?.image || undefined,
  };
}

async function resolveDifficultyId(boardType: string, grade?: string | null): Promise<number | null> {
  if (!grade) return null;
  const normalizedGrade = grade.trim().toLowerCase();
  const rawFontPart = normalizedGrade.split('/')[0].trim();
  const fontPart = rawFontPart === '5+' ? '5a' : rawFontPart;

  const [row] = await db
    .select({ difficulty: dbSchema.boardDifficultyGrades.difficulty })
    .from(dbSchema.boardDifficultyGrades)
    .where(
      and(
        eq(dbSchema.boardDifficultyGrades.boardType, boardType),
        sql`(
          LOWER(${dbSchema.boardDifficultyGrades.boulderName}) = ${normalizedGrade}
          OR LOWER(SPLIT_PART(${dbSchema.boardDifficultyGrades.boulderName}, '/', 1)) = ${fontPart}
        )`,
      ),
    )
    .orderBy(
      sql`CASE WHEN LOWER(${dbSchema.boardDifficultyGrades.boulderName}) = ${normalizedGrade} THEN 0 ELSE 1 END`,
      dbSchema.boardDifficultyGrades.difficulty,
    )
    .limit(1);

  return row?.difficulty ?? null;
}

export const climbMutations = {
  /**
   * Save a new climb for Aurora-style boards (kilter/tension) via GraphQL.
   * Persists to the unified board_climbs table and publishes a climb.created event.
   */
  saveClimb: async (_: unknown, { input }: SaveClimbArgs, ctx: ConnectionContext): Promise<SaveClimbResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'saveClimb');

    const validated = validateInput(SaveClimbInputSchema, input, 'input');
    const isListed = !validated.isDraft;

    if (!isValidBoardName(validated.boardType)) {
      throw new Error(
        `Invalid board type: ${String(validated.boardType)}. Must be one of ${SUPPORTED_BOARDS.join(', ')}`,
      );
    }

    const now = new Date().toISOString();
    const publishedAt = validated.isDraft ? null : now;
    const { displayName, name, avatarUrl } = await getUserProfile(ctx.userId!);
    const preferredSetter = displayName || name || null;

    const framesCount = validated.framesCount ?? 1;
    const holdEntries = parseFramesToHoldEntries(validated.boardType as BoardName, validated.frames);
    const uuid = generateClimbUuid();

    // Atomicity envelope: gate-check, insert, holds seed, and stats seed all
    // run inside one transaction so a half-completed publish can never leave
    // the row visible to search without its supporting holds/stats. The
    // advisory lock taken at the top of the transaction serializes concurrent
    // publishes of the same hold signature, eliminating the gate's TOCTOU
    // race (two callers reading "no match" simultaneously and both writing).
    // Lock is no-op for drafts / multi-frame climbs since the gate doesn't
    // fire there anyway.
    const shouldGate = !validated.isDraft && framesCount === 1;
    const gateSignature = shouldGate ? buildHoldSignature(holdEntries) : '';
    await db.transaction(async (tx) => {
      if (shouldGate) {
        await acquireDuplicateGateLock(tx, validated.boardType as BoardName, validated.layoutId, gateSignature);
        const existing = await findExactDuplicateMatch({
          boardType: validated.boardType as BoardName,
          layoutId: validated.layoutId,
          signature: gateSignature,
          executor: tx,
        });
        if (existing) {
          throw new GraphQLError(buildDuplicateClimbErrorMessage(existing.name), {
            extensions: {
              code: CLIMB_DUPLICATE_ERROR_CODE,
              existingClimbUuid: existing.uuid,
              existingClimbName: existing.name,
            },
          });
        }
      }

      await tx.insert(UNIFIED_TABLES.climbs).values({
        boardType: validated.boardType,
        uuid,
        layoutId: validated.layoutId,
        userId: ctx.userId!,
        setterId: null,
        setterUsername: preferredSetter,
        name: validated.name,
        description: validated.description ?? '',
        angle: validated.angle,
        framesCount,
        framesPace: validated.framesPace ?? 0,
        frames: validated.frames,
        isDraft: validated.isDraft,
        isListed,
        createdAt: now,
        publishedAt,
        synced: false,
        syncError: null,
      });

      // Aurora's sync-back round-trip eventually populates board_climb_holds for
      // these climbs (via aurora-board-import-helpers), but the latency is
      // open-ended. Seed the rows ourselves so the next call's duplicate gate
      // can see this climb immediately. Aurora's later re-import is idempotent
      // via onConflictDoNothing on the PK (board_type, climb_uuid, hold_id).
      if (holdEntries.length > 0) {
        await tx
          .insert(dbSchema.boardClimbHolds)
          .values(
            holdEntries.map((entry) => ({
              boardType: validated.boardType,
              climbUuid: uuid,
              holdId: entry.holdId,
              frameNumber: entry.frameNumber,
              holdState: entry.holdState,
            })),
          )
          .onConflictDoNothing();
      }

      // Populate denormalized required_set_ids and compatible_size_ids
      await populateDenormalizedColumns(tx, validated.boardType, [uuid]);

      // Stats rows used to come exclusively from the Aurora sync pipeline, so
      // Boardsesh-originated climbs had none. The hot search path INNER JOINs
      // board_climb_stats (search-climbs.ts:statsDrivenSearch), which hid these
      // climbs from search until someone synced them. Seed a row at the chosen
      // angle so the climb is discoverable immediately.
      //
      // Skip drafts: search uses LEFT JOIN for drafts and a stats row there would
      // expose the climb to the listed/INNER-JOIN path the moment is_listed flips,
      // before any other write occurs. Matches migration 0096 Step 1, which only
      // backfills rows where is_draft = FALSE, and updateClimb (below) which seeds
      // on draft → publish transition.
      if (!validated.isDraft) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: validated.boardType,
            climbUuid: uuid,
            angle: validated.angle,
            ascensionistCount: 0,
            faUsername: preferredSetter,
          })
          .onConflictDoNothing({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
          });
      }
    });

    if (!validated.isDraft) {
      await publishSocialEvent({
        type: 'climb.created',
        actorId: ctx.userId!,
        entityType: 'climb',
        entityId: uuid,
        timestamp: Date.now(),
        metadata: {
          boardType: validated.boardType,
          layoutId: String(validated.layoutId),
          climbName: validated.name,
          climbUuid: uuid,
          angle: String(validated.angle),
          frames: validated.frames,
          setterUsername: preferredSetter || '',
          setterDisplayName: preferredSetter || '',
          setterAvatarUrl: avatarUrl || '',
        },
      });
    }

    return { uuid, synced: false, createdAt: now, publishedAt };
  },

  /**
   * Save a new MoonBoard climb via GraphQL.
   * Encodes holds to frames, optionally stores grade stats, and publishes climb.created.
   */
  saveMoonBoardClimb: async (
    _: unknown,
    { input }: SaveClimbArgs,
    ctx: ConnectionContext,
  ): Promise<SaveClimbResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10, 'saveMoonBoardClimb');

    const validated = validateInput(SaveMoonBoardClimbInputSchema, input, 'input');
    const isDraft = validated.isDraft ?? false;
    const isListed = !isDraft;
    const normalizedHolds = normalizeMoonBoardHolds(validated.holds);

    if (validated.boardType !== 'moonboard') {
      throw new Error('saveMoonBoardClimb is only supported for boardType=moonboard');
    }

    if (
      !isDraft &&
      (!normalizedHolds.some((hold) => hold.holdState === 'STARTING') ||
        !normalizedHolds.some((hold) => hold.holdState === 'FINISH'))
    ) {
      throw new Error('Published MoonBoard climbs require at least one starting hold and one finishing hold');
    }
    // Benchmarks are a trusted, community-wide signal. Only admins and
    // community leaders can set one at creation or change its status later.
    // Gate before any work so a non-privileged request is rejected cleanly.
    if (validated.isBenchmark) {
      await requireAdminOrLeader(ctx, 'moonboard');
    }

    // MoonBoard "method" (footless / footless+kickboard / no-kickboard) is stored
    // as a structured characteristic; the default "feet follow hands" is no token.
    const characteristics = validated.method ? withCharacteristic(null, validated.method, true) : null;

    const uuid = generateClimbUuid();
    const now = new Date().toISOString();
    const publishedAt = isDraft ? null : now;
    const { displayName, name, avatarUrl } = await getUserProfile(ctx.userId!);
    const preferredSetter = validated.setter || displayName || name || null;

    const frames = encodeMoonBoardHoldsToFrames(validated.holds);
    const difficultyId = await resolveDifficultyId(validated.boardType, validated.userGrade);
    if (validated.isBenchmark && difficultyId === null) {
      throw new Error('A benchmark MoonBoard climb requires a valid grade');
    }
    const gateSignature = buildMoonBoardHoldSignature(normalizedHolds);

    await db.transaction(async (tx) => {
      if (!isDraft) {
        await acquireDuplicateGateLock(tx, 'moonboard', validated.layoutId, gateSignature);
        // This transaction-local lookup covers both normalized hold rows and
        // legacy climbs that only have a frames blob.
        const duplicateMatch = await findMoonBoardDuplicateMatch(
          validated.layoutId,
          validated.angle,
          validated.holds,
          undefined,
          tx,
        );
        if (duplicateMatch) {
          throw new GraphQLError(buildMoonBoardDuplicateError(duplicateMatch.existingClimbName), {
            extensions: {
              code: CLIMB_DUPLICATE_ERROR_CODE,
              existingClimbUuid: duplicateMatch.existingClimbUuid,
              existingClimbName: duplicateMatch.existingClimbName,
            },
          });
        }
      }

      await tx.insert(UNIFIED_TABLES.climbs).values({
        boardType: validated.boardType,
        uuid,
        layoutId: validated.layoutId,
        userId: ctx.userId!,
        setterId: null,
        setterUsername: preferredSetter,
        name: validated.name,
        description: validated.description ?? '',
        angle: validated.angle,
        framesCount: 1,
        framesPace: 0,
        frames,
        isDraft,
        isListed,
        createdAt: now,
        publishedAt,
        synced: false,
        syncError: null,
        characteristics,
      });

      const holdRows = buildMoonBoardClimbHoldRows(uuid, validated.holds);
      if (holdRows.length > 0) {
        await tx.insert(dbSchema.boardClimbHolds).values(holdRows).onConflictDoNothing();
      }
      await populateDenormalizedColumns(tx, 'moonboard', [uuid]);

      if (difficultyId !== null) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: validated.boardType,
            climbUuid: uuid,
            angle: validated.angle,
            displayDifficulty: difficultyId,
            benchmarkDifficulty: validated.isBenchmark ? difficultyId : null,
            ascensionistCount: 0,
            difficultyAverage: difficultyId,
            qualityAverage: null,
            faUsername: validated.setter || null,
            faAt: null,
          })
          .onConflictDoNothing({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
          });
      } else if (!isDraft) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: validated.boardType,
            climbUuid: uuid,
            angle: validated.angle,
            ascensionistCount: 0,
            faUsername: validated.setter || null,
          })
          .onConflictDoNothing({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
          });
      }
    });

    if (!isDraft) {
      await publishSocialEvent({
        type: 'climb.created',
        actorId: ctx.userId!,
        entityType: 'climb',
        entityId: uuid,
        timestamp: Date.now(),
        metadata: {
          boardType: validated.boardType,
          layoutId: String(validated.layoutId),
          climbName: validated.name,
          climbUuid: uuid,
          angle: String(validated.angle),
          frames,
          setterUsername: preferredSetter || '',
          setterDisplayName: preferredSetter || '',
          setterAvatarUrl: avatarUrl || '',
          difficultyName: validated.userGrade || '',
        },
      });
    }

    return { uuid, synced: false, createdAt: now, publishedAt };
  },

  updateMoonBoardClimb: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<UpdateClimbResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'updateMoonBoardClimb');
    const validated = validateInput(UpdateMoonBoardClimbInputSchema, input, 'input');

    // Benchmark membership is curated in both directions. Otherwise any setter
    // could remove the benchmark flag from a climb they originally created.
    if (validated.isBenchmark !== undefined) {
      await requireAdminOrLeader(ctx, 'moonboard');
    }

    const [existing] = await db
      .select({
        uuid: dbSchema.boardClimbs.uuid,
        userId: dbSchema.boardClimbs.userId,
        name: dbSchema.boardClimbs.name,
        description: dbSchema.boardClimbs.description,
        isDraft: dbSchema.boardClimbs.isDraft,
        publishedAt: dbSchema.boardClimbs.publishedAt,
        createdAt: dbSchema.boardClimbs.createdAt,
        angle: dbSchema.boardClimbs.angle,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        characteristics: dbSchema.boardClimbs.characteristics,
      })
      .from(dbSchema.boardClimbs)
      .where(and(eq(dbSchema.boardClimbs.uuid, validated.uuid), eq(dbSchema.boardClimbs.boardType, 'moonboard')))
      .limit(1);

    if (!existing) throw new Error('Climb not found');
    if (existing.userId !== ctx.userId) throw new Error('You can only update your own climbs');

    const currentlyDraft = existing.isDraft === true;
    if (!currentlyDraft) {
      if (!existing.publishedAt) throw new Error('This climb can no longer be edited');
      const publishedMs = Date.parse(existing.publishedAt);
      if (!Number.isFinite(publishedMs) || Date.now() - publishedMs > 24 * 60 * 60 * 1000) {
        throw new Error('The 24 hour edit window has expired');
      }
    }

    // Only drafts may transition state. False or legacy NULL rows are already
    // published and cannot be moved back to draft.
    const nextIsDraft = currentlyDraft ? validated.isDraft !== false : false;
    const transitioningToPublished = currentlyDraft && validated.isDraft === false;
    const nextPublishedAt = transitioningToPublished ? new Date().toISOString() : existing.publishedAt;
    const nextAngle = validated.angle ?? existing.angle;
    if (nextAngle === null) throw new Error('Cannot save MoonBoard climb without an angle');

    const existingHoldRows = await db
      .select({ holdId: dbSchema.boardClimbHolds.holdId, holdState: dbSchema.boardClimbHolds.holdState })
      .from(dbSchema.boardClimbHolds)
      .where(
        and(
          eq(dbSchema.boardClimbHolds.boardType, 'moonboard'),
          eq(dbSchema.boardClimbHolds.climbUuid, validated.uuid),
        ),
      );
    const currentHolds = { start: [] as string[], hand: [] as string[], finish: [] as string[] };
    for (const row of existingHoldRows) {
      const coordinate = holdIdToCoordinate(row.holdId);
      if (row.holdState === 'STARTING') currentHolds.start.push(coordinate);
      else if (row.holdState === 'HAND') currentHolds.hand.push(coordinate);
      else if (row.holdState === 'FINISH') currentHolds.finish.push(coordinate);
    }
    const nextHolds = validated.holds ?? currentHolds;
    if (!nextIsDraft && (nextHolds.start.length === 0 || nextHolds.finish.length === 0)) {
      throw new Error('Published MoonBoard climbs require at least one starting hold and one finishing hold');
    }

    const holdsChanged = validated.holds !== undefined;
    const angleChanged = validated.angle !== undefined && validated.angle !== existing.angle;
    const shouldGate = !nextIsDraft && (transitioningToPublished || holdsChanged || angleChanged);
    const gateSignature = shouldGate ? buildMoonBoardHoldSignature(normalizeMoonBoardHolds(nextHolds)) : '';

    const [existingStats] =
      existing.angle === null
        ? []
        : await db
            .select({
              displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
              benchmarkDifficulty: dbSchema.boardClimbStats.benchmarkDifficulty,
            })
            .from(dbSchema.boardClimbStats)
            .where(
              and(
                eq(dbSchema.boardClimbStats.boardType, 'moonboard'),
                eq(dbSchema.boardClimbStats.climbUuid, validated.uuid),
                eq(dbSchema.boardClimbStats.angle, existing.angle),
              ),
            )
            .limit(1);
    const nextDifficulty =
      validated.userGrade === undefined
        ? (existingStats?.displayDifficulty ?? null)
        : await resolveDifficultyId('moonboard', validated.userGrade);
    const nextIsBenchmark =
      validated.isBenchmark === undefined ? existingStats?.benchmarkDifficulty != null : validated.isBenchmark;
    if (nextIsBenchmark && nextDifficulty === null) {
      throw new Error('A benchmark MoonBoard climb requires a grade');
    }

    const nextFrames =
      validated.holds === undefined ? (existing.frames ?? '') : encodeMoonBoardHoldsToFrames(nextHolds);
    const nextMethod = validated.method === undefined ? getMoonBoardMethod(existing.characteristics) : validated.method;
    const nextCharacteristics = nextMethod ? withCharacteristic(null, nextMethod, true) : null;
    const nextSetter = validated.setter === undefined ? existing.setterUsername : validated.setter;

    await db.transaction(async (tx) => {
      // Serialize edits to this climb, then re-read every value used to derive
      // the write. The preflight reads above keep validation errors cheap, but
      // are not trusted once the transaction begins.
      await tx.execute(sql`
        SELECT 1 FROM ${dbSchema.boardClimbs}
        WHERE ${dbSchema.boardClimbs.boardType} = 'moonboard'
          AND ${dbSchema.boardClimbs.uuid} = ${validated.uuid}
        FOR UPDATE
      `);
      const [lockedExisting] = await tx
        .select({
          userId: dbSchema.boardClimbs.userId,
          name: dbSchema.boardClimbs.name,
          description: dbSchema.boardClimbs.description,
          isDraft: dbSchema.boardClimbs.isDraft,
          publishedAt: dbSchema.boardClimbs.publishedAt,
          angle: dbSchema.boardClimbs.angle,
          frames: dbSchema.boardClimbs.frames,
          setterUsername: dbSchema.boardClimbs.setterUsername,
          characteristics: dbSchema.boardClimbs.characteristics,
        })
        .from(dbSchema.boardClimbs)
        .where(and(eq(dbSchema.boardClimbs.uuid, validated.uuid), eq(dbSchema.boardClimbs.boardType, 'moonboard')))
        .limit(1);
      if (!lockedExisting) throw new Error('Climb not found');
      if (lockedExisting.userId !== ctx.userId) throw new Error('You can only update your own climbs');

      const lockedHoldRows = await tx
        .select({ holdId: dbSchema.boardClimbHolds.holdId, holdState: dbSchema.boardClimbHolds.holdState })
        .from(dbSchema.boardClimbHolds)
        .where(
          and(
            eq(dbSchema.boardClimbHolds.boardType, 'moonboard'),
            eq(dbSchema.boardClimbHolds.climbUuid, validated.uuid),
          ),
        );
      const [lockedStats] =
        lockedExisting.angle === null
          ? []
          : await tx
              .select({
                displayDifficulty: dbSchema.boardClimbStats.displayDifficulty,
                benchmarkDifficulty: dbSchema.boardClimbStats.benchmarkDifficulty,
              })
              .from(dbSchema.boardClimbStats)
              .where(
                and(
                  eq(dbSchema.boardClimbStats.boardType, 'moonboard'),
                  eq(dbSchema.boardClimbStats.climbUuid, validated.uuid),
                  eq(dbSchema.boardClimbStats.angle, lockedExisting.angle),
                ),
              )
              .limit(1);
      const preflightHoldSignature = buildMoonBoardHoldSignature(normalizeMoonBoardHolds(currentHolds));
      const lockedHoldSignature = lockedHoldRows
        .map((row) => `${row.holdId}:${row.holdState}`)
        .sort((first, second) => Number(first.split(':')[0]) - Number(second.split(':')[0]))
        .join(',');
      const preflightChanged =
        lockedExisting.name !== existing.name ||
        lockedExisting.description !== existing.description ||
        lockedExisting.isDraft !== existing.isDraft ||
        lockedExisting.publishedAt !== existing.publishedAt ||
        lockedExisting.angle !== existing.angle ||
        lockedExisting.frames !== existing.frames ||
        lockedExisting.setterUsername !== existing.setterUsername ||
        JSON.stringify(lockedExisting.characteristics) !== JSON.stringify(existing.characteristics) ||
        lockedHoldSignature !== preflightHoldSignature ||
        lockedStats?.displayDifficulty !== existingStats?.displayDifficulty ||
        lockedStats?.benchmarkDifficulty !== existingStats?.benchmarkDifficulty;
      if (preflightChanged) {
        throw new Error('This climb changed while it was being edited. Reload it and try again');
      }

      const lockedCurrentlyDraft = lockedExisting.isDraft === true;
      if (!lockedCurrentlyDraft) {
        const lockedPublishedMs = lockedExisting.publishedAt ? Date.parse(lockedExisting.publishedAt) : Number.NaN;
        if (!Number.isFinite(lockedPublishedMs) || Date.now() - lockedPublishedMs > 24 * 60 * 60 * 1000) {
          throw new Error('The 24 hour edit window has expired');
        }
      }

      if (shouldGate) {
        await acquireDuplicateGateLock(tx, 'moonboard', existing.layoutId, gateSignature);
        const duplicate = await findMoonBoardDuplicateMatch(
          existing.layoutId,
          nextAngle,
          nextHolds,
          validated.uuid,
          tx,
        );
        if (duplicate) {
          throw new GraphQLError(buildMoonBoardDuplicateError(duplicate.existingClimbName), {
            extensions: {
              code: CLIMB_DUPLICATE_ERROR_CODE,
              existingClimbUuid: duplicate.existingClimbUuid,
              existingClimbName: duplicate.existingClimbName,
            },
          });
        }
      }

      await tx
        .update(dbSchema.boardClimbs)
        .set({
          name: validated.name ?? existing.name,
          description: validated.description === undefined ? existing.description : (validated.description ?? ''),
          frames: nextFrames,
          angle: nextAngle,
          isDraft: nextIsDraft,
          isListed: !nextIsDraft,
          publishedAt: nextPublishedAt,
          characteristics: nextCharacteristics,
          setterUsername: nextSetter,
        })
        .where(and(eq(dbSchema.boardClimbs.uuid, validated.uuid), eq(dbSchema.boardClimbs.boardType, 'moonboard')));

      if (holdsChanged) {
        await tx
          .delete(dbSchema.boardClimbHolds)
          .where(
            and(
              eq(dbSchema.boardClimbHolds.boardType, 'moonboard'),
              eq(dbSchema.boardClimbHolds.climbUuid, validated.uuid),
            ),
          );
        const holdRows = buildMoonBoardClimbHoldRows(validated.uuid, nextHolds);
        if (holdRows.length > 0) await tx.insert(dbSchema.boardClimbHolds).values(holdRows);
        await populateDenormalizedColumns(tx, 'moonboard', [validated.uuid]);
      }

      // Mirror saveMoonBoardClimb's seeding rule: a draft with no grade gets no
      // stats row. Gating on `validated.userGrade !== undefined` would not do —
      // mobile always sends `userGrade`, `null` when the picker is empty, so
      // every draft autosave would seed a junk row (null difficulty, 0 ascents)
      // that then shows up in grade aggregates and the heatmap's AVG.
      const shouldWriteStats = !nextIsDraft || existingStats != null || nextDifficulty !== null || nextIsBenchmark;
      if (shouldWriteStats) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: 'moonboard',
            climbUuid: validated.uuid,
            angle: nextAngle,
            displayDifficulty: nextDifficulty,
            benchmarkDifficulty: nextIsBenchmark ? nextDifficulty : null,
            difficultyAverage: nextDifficulty,
            ascensionistCount: 0,
            faUsername: nextSetter,
          })
          .onConflictDoUpdate({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
            set: {
              displayDifficulty: nextDifficulty,
              benchmarkDifficulty: nextIsBenchmark ? nextDifficulty : null,
              difficultyAverage: nextDifficulty,
              faUsername: nextSetter,
            },
          });
      }

      if (angleChanged && existing.angle !== null) {
        const [oldAngleTick] = await tx
          .select({ id: dbSchema.boardseshTicks.uuid })
          .from(dbSchema.boardseshTicks)
          .where(
            and(
              eq(dbSchema.boardseshTicks.boardType, 'moonboard'),
              eq(dbSchema.boardseshTicks.climbUuid, validated.uuid),
              eq(dbSchema.boardseshTicks.angle, existing.angle),
            ),
          )
          .limit(1);
        if (!oldAngleTick) {
          await tx
            .delete(dbSchema.boardClimbStats)
            .where(
              and(
                eq(dbSchema.boardClimbStats.boardType, 'moonboard'),
                eq(dbSchema.boardClimbStats.climbUuid, validated.uuid),
                eq(dbSchema.boardClimbStats.angle, existing.angle),
              ),
            );
        }
      }
    });

    void notifyClimbRevalidated(validated.uuid);
    if (transitioningToPublished) {
      const { displayName, name, avatarUrl } = await getUserProfile(ctx.userId);
      await publishSocialEvent({
        type: 'climb.created',
        actorId: ctx.userId,
        entityType: 'climb',
        entityId: validated.uuid,
        timestamp: Date.now(),
        metadata: {
          boardType: 'moonboard',
          layoutId: String(existing.layoutId),
          climbName: validated.name ?? existing.name ?? '',
          climbUuid: validated.uuid,
          angle: String(nextAngle),
          frames: nextFrames,
          setterUsername: nextSetter ?? '',
          setterDisplayName: displayName || name || '',
          setterAvatarUrl: avatarUrl || '',
          difficultyName: validated.userGrade ?? '',
        },
      });
    }

    return {
      uuid: validated.uuid,
      createdAt: existing.createdAt,
      publishedAt: nextPublishedAt,
      isDraft: nextIsDraft,
    };
  },

  /**
   * Update an existing climb in-place. Enforces ownership and a 24h edit
   * window on published climbs. Drafts can be edited indefinitely.
   *
   * A climb can transition from draft → published via `isDraft: false` —
   * that sets `publishedAt` to now and starts the 24h clock. The reverse
   * transition is not allowed (can't un-publish).
   */
  updateClimb: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<UpdateClimbResult> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'updateClimb');

    const validated = validateInput(UpdateClimbInputSchema, input, 'input');

    if (!isValidBoardName(validated.boardType)) {
      throw new Error(
        `Invalid board type: ${String(validated.boardType)}. Must be one of ${SUPPORTED_BOARDS.join(', ')}`,
      );
    }

    // Load the existing row and verify ownership + edit window.
    const [existing] = await db
      .select({
        uuid: dbSchema.boardClimbs.uuid,
        userId: dbSchema.boardClimbs.userId,
        isDraft: dbSchema.boardClimbs.isDraft,
        publishedAt: dbSchema.boardClimbs.publishedAt,
        createdAt: dbSchema.boardClimbs.createdAt,
        angle: dbSchema.boardClimbs.angle,
        layoutId: dbSchema.boardClimbs.layoutId,
        frames: dbSchema.boardClimbs.frames,
        framesCount: dbSchema.boardClimbs.framesCount,
        setterUsername: dbSchema.boardClimbs.setterUsername,
        characteristics: dbSchema.boardClimbs.characteristics,
      })
      .from(dbSchema.boardClimbs)
      .where(
        and(eq(dbSchema.boardClimbs.uuid, validated.uuid), eq(dbSchema.boardClimbs.boardType, validated.boardType)),
      )
      .limit(1);

    if (!existing) {
      throw new Error('Climb not found');
    }

    if (existing.userId !== ctx.userId!) {
      throw new Error('You can only update your own climbs');
    }

    const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
    const currentlyDraft = existing.isDraft === true;

    if (!currentlyDraft) {
      // Non-draft: only editable within 24h of the first publish.
      if (!existing.publishedAt) {
        throw new Error('This climb can no longer be edited');
      }
      const publishedMs = Date.parse(existing.publishedAt);
      if (!Number.isFinite(publishedMs) || Date.now() - publishedMs > EDIT_WINDOW_MS) {
        throw new Error('The 24 hour edit window has expired');
      }
    }

    // Decide the next draft/publish state. We only honor a transition from
    // draft → published; a publish → draft attempt is silently ignored.
    let nextIsDraft: boolean;
    if (validated.isDraft === undefined) {
      nextIsDraft = existing.isDraft ?? false;
    } else if (currentlyDraft && validated.isDraft === false) {
      nextIsDraft = false;
    } else {
      nextIsDraft = existing.isDraft ?? false;
    }

    const transitioningToPublished = currentlyDraft && validated.isDraft === false;
    const now = new Date().toISOString();
    const nextPublishedAt = transitioningToPublished ? now : existing.publishedAt;

    // Decide whether this update needs to seed a board_climb_stats row at the
    // climb's resolved angle, and validate the angle up front. Doing this
    // BEFORE the board_climbs UPDATE means a malformed-publish attempt fails
    // cleanly — without it, we'd flip isDraft=false / publishedAt=now and
    // then throw, leaving a published climb with no stats row (exactly the
    // broken state this PR is fixing).
    const resolvedAngle = validated.angle ?? existing.angle;
    const angleChanged = validated.angle !== undefined && validated.angle !== existing.angle;
    const shouldSeedStats = !nextIsDraft && (transitioningToPublished || angleChanged);
    if (shouldSeedStats && resolvedAngle === null) {
      // board_climbs.angle is nullable in the schema but board_climb_stats.angle
      // is NOT NULL. angleChanged can't reach this — validated.angle would be
      // set; this only fires on publish of a draft created without an angle.
      throw new Error('Cannot publish climb without an angle');
    }

    // Atomicity envelope: the gate check, the UPDATE on board_climbs, the
    // denorm column refresh, the holds DELETE+INSERT, and the stats seed all
    // run inside one transaction. Without this a partial failure mid-sequence
    // could leave the row published with stale board_climb_holds (a real
    // data-integrity bug — the search hot path joins against the holds table
    // for filtering, so out-of-sync rows surface as silently-wrong results).
    //
    // The advisory lock taken before the gate read serializes concurrent
    // publishes of the same hold signature so the gate's TOCTOU race
    // disappears: two simultaneous draft→publish attempts whose holds collide
    // now line up behind the lock, and whichever lands second sees the first
    // through the gate and throws cleanly. Multi-frame climbs and pure
    // metadata edits don't take the lock (the gate doesn't fire for them).
    const framesChanged = validated.frames !== undefined && validated.frames !== existing.frames;
    const nextFrames = validated.frames ?? existing.frames ?? '';
    const nextFramesCount = validated.framesCount ?? existing.framesCount ?? 1;
    const shouldGate = !nextIsDraft && (transitioningToPublished || framesChanged) && nextFramesCount === 1;
    const gateSignature = shouldGate
      ? buildHoldSignature(parseFramesToHoldEntries(validated.boardType as BoardName, nextFrames))
      : '';

    await db.transaction(async (tx) => {
      if (shouldGate) {
        await acquireDuplicateGateLock(tx, validated.boardType as BoardName, existing.layoutId, gateSignature);
        const existingMatch = await findExactDuplicateMatch({
          boardType: validated.boardType as BoardName,
          layoutId: existing.layoutId,
          signature: gateSignature,
          excludeUuid: validated.uuid,
          executor: tx,
        });
        if (existingMatch) {
          throw new GraphQLError(buildDuplicateClimbErrorMessage(existingMatch.name), {
            extensions: {
              code: CLIMB_DUPLICATE_ERROR_CODE,
              existingClimbUuid: existingMatch.uuid,
              existingClimbName: existingMatch.name,
            },
          });
        }
      }

      // Build the update set from provided fields only.
      const updateSet: Record<string, unknown> = {
        isDraft: nextIsDraft,
        isListed: !nextIsDraft,
        publishedAt: nextPublishedAt,
      };
      if (validated.name !== undefined) updateSet.name = validated.name;
      if (validated.description !== undefined) {
        // Derive no_match from the raw incoming description (may still carry the
        // Aurora "No match\n" prefix), then strip the prefix from the stored value
        // so characteristics is the sole source of truth going forward.
        const isNoMatchFromDesc = isNoMatchClimb(validated.description);
        updateSet.description = withNoMatch(validated.description, false);
        // Keep the no_match characteristic in sync, preserving any other tokens
        // (e.g. a MoonBoard method). no_match is an Aurora-family concept — never
        // derive it for MoonBoard, where a description starting with "no match" is
        // just user prose and would otherwise clobber the climb's method token.
        if (validated.boardType !== 'moonboard') {
          const nextCharacteristics = withCharacteristic(
            existing.characteristics,
            CLIMB_CHARACTERISTICS.NO_MATCH,
            isNoMatchFromDesc,
          );
          updateSet.characteristics = nextCharacteristics.length > 0 ? nextCharacteristics : null;
        }
      }
      if (validated.frames !== undefined) updateSet.frames = validated.frames;
      if (validated.angle !== undefined) updateSet.angle = validated.angle;
      if (validated.framesCount !== undefined) updateSet.framesCount = validated.framesCount;
      if (validated.framesPace !== undefined) updateSet.framesPace = validated.framesPace;

      await tx
        .update(dbSchema.boardClimbs)
        .set(updateSet)
        .where(
          and(eq(dbSchema.boardClimbs.uuid, validated.uuid), eq(dbSchema.boardClimbs.boardType, validated.boardType)),
        );

      // If frames changed we need to refresh the denormalized edge/set columns
      // so search filters still match, and resync board_climb_holds (which the
      // duplicate gate and similarity queries read from).
      if (validated.frames !== undefined) {
        await populateDenormalizedColumns(tx, validated.boardType, [validated.uuid]);

        if (framesChanged) {
          const refreshedHolds = parseFramesToHoldEntries(validated.boardType as BoardName, nextFrames);
          await tx
            .delete(dbSchema.boardClimbHolds)
            .where(
              and(
                eq(dbSchema.boardClimbHolds.boardType, validated.boardType),
                eq(dbSchema.boardClimbHolds.climbUuid, validated.uuid),
              ),
            );
          if (refreshedHolds.length > 0) {
            await tx
              .insert(dbSchema.boardClimbHolds)
              .values(
                refreshedHolds.map((entry) => ({
                  boardType: validated.boardType,
                  climbUuid: validated.uuid,
                  holdId: entry.holdId,
                  frameNumber: entry.frameNumber,
                  holdState: entry.holdState,
                })),
              )
              .onConflictDoNothing();
          }
        }
      }

      // The search hot path INNER JOINs board_climb_stats by (boardType, climbUuid, angle).
      // Make sure a row exists at the resolved angle whenever the climb is, or just became,
      // searchable. The old row at the previous angle is left in place — it's harmless
      // because search filters by exact angle, and removing it would race with concurrent ticks.
      // The combined check also re-narrows `resolvedAngle` to non-null for TS — we threw
      // above on (shouldSeedStats && null) so the second clause is the only path through.
      if (shouldSeedStats && resolvedAngle !== null) {
        await tx
          .insert(dbSchema.boardClimbStats)
          .values({
            boardType: validated.boardType,
            climbUuid: validated.uuid,
            angle: resolvedAngle,
            ascensionistCount: 0,
            faUsername: existing.setterUsername,
          })
          .onConflictDoNothing({
            target: [
              dbSchema.boardClimbStats.boardType,
              dbSchema.boardClimbStats.climbUuid,
              dbSchema.boardClimbStats.angle,
            ],
          });
      }
    });

    // Tell the web app to drop the cached climb-view render so the edit
    // shows up immediately instead of waiting for the 1h TTL.
    void notifyClimbRevalidated(validated.uuid);

    // On a draft → published transition, announce the new climb so follower
    // feeds pick it up, the same way saveClimb does.
    if (transitioningToPublished) {
      const { displayName, name, avatarUrl } = await getUserProfile(ctx.userId);
      const preferredSetter = displayName || name || null;
      await publishSocialEvent({
        type: 'climb.created',
        actorId: ctx.userId,
        entityType: 'climb',
        entityId: validated.uuid,
        timestamp: Date.now(),
        metadata: {
          boardType: validated.boardType,
          // existing.layoutId came from the SELECT extended in this PR for
          // the duplicate gate. Use it so follower feeds get the layout
          // context — the empty-string placeholder was a leftover from
          // before that column was selectable here.
          layoutId: existing.layoutId != null ? String(existing.layoutId) : '',
          climbName: validated.name ?? '',
          climbUuid: validated.uuid,
          angle: validated.angle !== undefined ? String(validated.angle) : '',
          frames: validated.frames ?? '',
          setterUsername: existing.setterUsername ?? preferredSetter ?? '',
          setterDisplayName: preferredSetter || '',
          setterAvatarUrl: avatarUrl || '',
        },
      });
    }

    return {
      uuid: validated.uuid,
      createdAt: existing.createdAt,
      publishedAt: nextPublishedAt,
      isDraft: nextIsDraft,
    };
  },

  /**
   * Delete an unpublished draft climb owned by the current user. This path is
   * intentionally narrower than account deletion: published climbs are never
   * removed here, even if the caller owns them.
   */
  deleteDraftClimb: async (
    _: unknown,
    { uuid, boardType }: DeleteDraftClimbArgs,
    ctx: ConnectionContext,
  ): Promise<boolean> => {
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 20, 'deleteDraftClimb');

    const validatedUuid = validateInput(ExternalUUIDSchema, uuid, 'uuid');
    const validatedBoardType = validateInput(BoardNameSchema, boardType, 'boardType');

    await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          uuid: dbSchema.boardClimbs.uuid,
          userId: dbSchema.boardClimbs.userId,
          isDraft: dbSchema.boardClimbs.isDraft,
        })
        .from(dbSchema.boardClimbs)
        .where(
          and(eq(dbSchema.boardClimbs.uuid, validatedUuid), eq(dbSchema.boardClimbs.boardType, validatedBoardType)),
        )
        .limit(1);

      if (!existing) {
        throw new Error('Climb not found');
      }

      if (existing.userId !== ctx.userId!) {
        throw new Error('You can only delete your own draft climbs');
      }

      if (existing.isDraft !== true) {
        throw new Error('Published climbs cannot be deleted here');
      }

      await tx
        .delete(dbSchema.boardClimbStats)
        .where(
          and(
            eq(dbSchema.boardClimbStats.boardType, validatedBoardType),
            eq(dbSchema.boardClimbStats.climbUuid, validatedUuid),
          ),
        );

      await tx
        .delete(dbSchema.boardClimbStatsHistory)
        .where(
          and(
            eq(dbSchema.boardClimbStatsHistory.boardType, validatedBoardType),
            eq(dbSchema.boardClimbStatsHistory.climbUuid, validatedUuid),
          ),
        );

      await tx
        .delete(dbSchema.boardBetaLinks)
        .where(
          and(
            eq(dbSchema.boardBetaLinks.boardType, validatedBoardType),
            eq(dbSchema.boardBetaLinks.climbUuid, validatedUuid),
          ),
        );

      const deletedRows = await tx
        .delete(dbSchema.boardClimbs)
        .where(
          and(
            eq(dbSchema.boardClimbs.uuid, validatedUuid),
            eq(dbSchema.boardClimbs.boardType, validatedBoardType),
            eq(dbSchema.boardClimbs.userId, ctx.userId!),
            eq(dbSchema.boardClimbs.isDraft, true),
          ),
        )
        .returning({ uuid: dbSchema.boardClimbs.uuid });

      if (deletedRows.length === 0) {
        throw new Error('Draft climb could not be deleted');
      }
    });

    // Bust the climb-view cache so any prerendered draft page 404s on next hit
    // instead of serving stale content from `unstable_cache`.
    void notifyClimbRevalidated(validatedUuid);

    return true;
  },
};
