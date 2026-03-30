import { eq, and } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { BoardNameSchema } from '../../../validation/schemas';

const VALID_HOLD_TYPES = ['jug', 'sloper', 'pinch', 'crimp', 'pocket'] as const;

function isValidHoldType(value: unknown): boolean {
  return typeof value === 'string' && (VALID_HOLD_TYPES as readonly string[]).includes(value);
}

function isValidRating(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5;
}

function isValidPullDirection(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 360;
}

export interface HoldClassification {
  id: string;
  userId: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  holdId: number;
  holdType: string | null;
  handRating: number | null;
  footRating: number | null;
  pullDirection: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface HoldClassificationsInput {
  boardType: string;
  layoutId: number;
  sizeId: number;
}

export interface SaveHoldClassificationInput {
  boardType: string;
  layoutId: number;
  sizeId: number;
  holdId: number;
  holdType?: string | null;
  handRating?: number | null;
  footRating?: number | null;
  pullDirection?: number | null;
}

export const holdClassificationsQuery = {
  holdClassifications: async (
    _: unknown,
    { input }: { input: HoldClassificationsInput },
    ctx: ConnectionContext,
  ): Promise<HoldClassification[]> => {
    requireAuthenticated(ctx);
    validateInput(BoardNameSchema, input.boardType, 'boardType');

    const classifications = await db
      .select()
      .from(dbSchema.userHoldClassifications)
      .where(
        and(
          eq(dbSchema.userHoldClassifications.userId, ctx.userId!),
          eq(dbSchema.userHoldClassifications.boardType, input.boardType),
          eq(dbSchema.userHoldClassifications.layoutId, input.layoutId),
          eq(dbSchema.userHoldClassifications.sizeId, input.sizeId),
        ),
      );

    return classifications.map(c => ({
      id: c.id.toString(),
      userId: c.userId,
      boardType: c.boardType,
      layoutId: c.layoutId,
      sizeId: c.sizeId,
      holdId: c.holdId,
      holdType: c.holdType,
      handRating: c.handRating,
      footRating: c.footRating,
      pullDirection: c.pullDirection,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }));
  },
};

export const holdClassificationsMutation = {
  saveHoldClassification: async (
    _: unknown,
    { input }: { input: SaveHoldClassificationInput },
    ctx: ConnectionContext,
  ): Promise<HoldClassification> => {
    requireAuthenticated(ctx);
    validateInput(BoardNameSchema, input.boardType, 'boardType');

    // Validate optional fields
    if (input.holdType !== null && input.holdType !== undefined && !isValidHoldType(input.holdType)) {
      throw new Error(`holdType must be one of: ${VALID_HOLD_TYPES.join(', ')}`);
    }
    if (input.handRating !== null && input.handRating !== undefined && !isValidRating(input.handRating)) {
      throw new Error('handRating must be an integer between 1 and 5');
    }
    if (input.footRating !== null && input.footRating !== undefined && !isValidRating(input.footRating)) {
      throw new Error('footRating must be an integer between 1 and 5');
    }
    if (input.pullDirection !== null && input.pullDirection !== undefined && !isValidPullDirection(input.pullDirection)) {
      throw new Error('pullDirection must be an integer between 0 and 360');
    }

    const userId = ctx.userId!;
    const now = new Date().toISOString();
    const validatedHoldType = (input.holdType ?? null) as 'jug' | 'sloper' | 'pinch' | 'crimp' | 'pocket' | null;
    const validatedHandRating = input.handRating ?? null;
    const validatedFootRating = input.footRating ?? null;
    const validatedPullDirection = input.pullDirection ?? null;

    // Atomic upsert using unique index on (userId, boardType, layoutId, sizeId, holdId)
    const result = await db
      .insert(dbSchema.userHoldClassifications)
      .values({
        userId,
        boardType: input.boardType,
        layoutId: input.layoutId,
        sizeId: input.sizeId,
        holdId: input.holdId,
        holdType: validatedHoldType,
        handRating: validatedHandRating,
        footRating: validatedFootRating,
        pullDirection: validatedPullDirection,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          dbSchema.userHoldClassifications.userId,
          dbSchema.userHoldClassifications.boardType,
          dbSchema.userHoldClassifications.layoutId,
          dbSchema.userHoldClassifications.sizeId,
          dbSchema.userHoldClassifications.holdId,
        ],
        set: {
          holdType: validatedHoldType,
          handRating: validatedHandRating,
          footRating: validatedFootRating,
          pullDirection: validatedPullDirection,
          updatedAt: now,
        },
      })
      .returning();

    return {
      id: result[0].id.toString(),
      userId,
      boardType: input.boardType,
      layoutId: input.layoutId,
      sizeId: input.sizeId,
      holdId: input.holdId,
      holdType: validatedHoldType,
      handRating: validatedHandRating,
      footRating: validatedFootRating,
      pullDirection: validatedPullDirection,
      createdAt: result[0].createdAt,
      updatedAt: now,
    };
  },
};
