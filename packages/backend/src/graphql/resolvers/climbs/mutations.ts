import crypto from 'crypto';
import type { RequestDbInstance } from '@boardsesh/db/client';
import { and, eq, sql } from 'drizzle-orm';
import type { ConnectionContext, SaveClimbResult } from '@boardsesh/shared-schema';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import * as dbSchema from '@boardsesh/db/schema';
import { UNIFIED_TABLES, isValidBoardName } from '../../../db/queries/util/table-select';
import { populateDenormalizedColumns } from '@boardsesh/db/queries';
import { publishSocialEvent } from '../../../events';
import { requireAuthenticated, applyRateLimit, validateInput } from '../shared/helpers';
import {
  buildMoonBoardClimbHoldRows,
  buildMoonBoardDuplicateError,
  encodeMoonBoardHoldsToFrames,
  findMoonBoardDuplicateMatch,
} from './moonboard-duplicates';
import {
  SaveClimbInputSchema,
  SaveMoonBoardClimbInputSchema,
} from '../../../validation/schemas';

type SaveClimbArgs = { input: unknown };

function generateClimbUuid(): string {
  // Match Aurora-style uppercase UUID without dashes
  return crypto.randomUUID().replace(/-/g, '').toUpperCase();
}

async function getUserProfile(db: RequestDbInstance, userId: string) {
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

async function resolveDifficultyId(db: RequestDbInstance, boardType: string, grade?: string | null): Promise<number | null> {
  if (!grade) return null;
  const fontPart = grade.split('/')[0].trim().toLowerCase();

  const [row] = await db
    .select({ difficulty: dbSchema.boardDifficultyGrades.difficulty })
    .from(dbSchema.boardDifficultyGrades)
    .where(
      and(
        eq(dbSchema.boardDifficultyGrades.boardType, boardType),
        sql`LOWER(${dbSchema.boardDifficultyGrades.boulderName}) = ${fontPart}`
      )
    )
    .limit(1);

  return row?.difficulty ?? null;
}

export const climbMutations = {
  /**
   * Save a new climb for Aurora-style boards (kilter/tension) via GraphQL.
   * Persists to the unified board_climbs table and publishes a climb.created event.
   */
  saveClimb: async (
    _: unknown,
    { input }: SaveClimbArgs,
    ctx: ConnectionContext
  ): Promise<SaveClimbResult> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10);

    const validated = validateInput(SaveClimbInputSchema, input, 'input');
    const isListed = !validated.isDraft;

    if (!isValidBoardName(validated.boardType)) {
      throw new Error(`Invalid board type: ${validated.boardType}. Must be one of ${SUPPORTED_BOARDS.join(', ')}`);
    }

    const uuid = generateClimbUuid();
    const now = new Date().toISOString();
    const { displayName, name, avatarUrl } = await getUserProfile(db, ctx.userId!);
    const preferredSetter = displayName || name || null;

    await db.insert(UNIFIED_TABLES.climbs).values({
      boardType: validated.boardType,
      uuid,
      layoutId: validated.layoutId,
      userId: ctx.userId!,
      setterId: null,
      setterUsername: preferredSetter,
      name: validated.name,
      description: validated.description ?? '',
      angle: validated.angle,
      framesCount: validated.framesCount ?? 1,
      framesPace: validated.framesPace ?? 0,
      frames: validated.frames,
      isDraft: validated.isDraft,
      isListed,
      createdAt: now,
      synced: false,
      syncError: null,
    });

    // Populate denormalized required_set_ids and compatible_size_ids
    await populateDenormalizedColumns(db, validated.boardType, [uuid]);

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
        setterDisplayName: preferredSetter || '',
        setterAvatarUrl: avatarUrl || '',
      },
    });

    return { uuid, synced: false };
  },

  /**
   * Save a new MoonBoard climb via GraphQL.
   * Encodes holds to frames, optionally stores grade stats, and publishes climb.created.
   */
  saveMoonBoardClimb: async (
    _: unknown,
    { input }: SaveClimbArgs,
    ctx: ConnectionContext
  ): Promise<SaveClimbResult> => {
    const db = ctx.db as RequestDbInstance;
    requireAuthenticated(ctx);
    await applyRateLimit(ctx, 10);

    const validated = validateInput(SaveMoonBoardClimbInputSchema, input, 'input');
    const isDraft = validated.isDraft ?? false;
    const isListed = !isDraft;

    if (validated.boardType !== 'moonboard') {
      throw new Error('saveMoonBoardClimb is only supported for boardType=moonboard');
    }

    const uuid = generateClimbUuid();
    const now = new Date().toISOString();
    const { displayName, name, avatarUrl } = await getUserProfile(db, ctx.userId!);
    const preferredSetter = validated.setter || displayName || name || null;

    const duplicateMatch = await findMoonBoardDuplicateMatch(db, validated.layoutId, validated.angle, validated.holds);
    if (duplicateMatch) {
      throw new Error(buildMoonBoardDuplicateError(duplicateMatch.existingClimbName));
    }

    const frames = encodeMoonBoardHoldsToFrames(validated.holds);

    await db.insert(UNIFIED_TABLES.climbs).values({
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
      synced: false,
      syncError: null,
    });

    const holdRows = buildMoonBoardClimbHoldRows(uuid, validated.holds);
    if (holdRows.length > 0) {
      await db.insert(dbSchema.boardClimbHolds).values(holdRows).onConflictDoNothing();
    }

    // Optional grade stats
    const difficultyId = await resolveDifficultyId(db, validated.boardType, validated.userGrade);
    if (difficultyId !== null) {
      await db
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
        .onConflictDoUpdate({
          target: [
            dbSchema.boardClimbStats.boardType,
            dbSchema.boardClimbStats.climbUuid,
            dbSchema.boardClimbStats.angle,
          ],
          set: {
            displayDifficulty: difficultyId,
            benchmarkDifficulty: validated.isBenchmark ? difficultyId : null,
            difficultyAverage: difficultyId,
          },
        });
    }

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
        setterDisplayName: preferredSetter || '',
        setterAvatarUrl: avatarUrl || '',
        difficultyName: validated.userGrade || '',
      },
    });

    return { uuid, synced: false };
  },
};
