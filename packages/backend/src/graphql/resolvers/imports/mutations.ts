import { v4 as uuidv4 } from 'uuid';
import { eq, and, ilike } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { requireAuthenticated, validateInput } from '../shared/helpers';
import { ImportTicksBatchInputSchema } from '../../../validation/schemas';
import { runInferredSessionBuilderBatched } from '../../../jobs/inferred-session-builder';

const BOULDER_GRADES = [
  { difficulty_id: 10, font_grade: '4a', v_grade: 'V0' },
  { difficulty_id: 11, font_grade: '4b', v_grade: 'V0' },
  { difficulty_id: 12, font_grade: '4c', v_grade: 'V0' },
  { difficulty_id: 13, font_grade: '5a', v_grade: 'V1' },
  { difficulty_id: 14, font_grade: '5b', v_grade: 'V1' },
  { difficulty_id: 15, font_grade: '5c', v_grade: 'V2' },
  { difficulty_id: 16, font_grade: '6a', v_grade: 'V3' },
  { difficulty_id: 17, font_grade: '6a+', v_grade: 'V3' },
  { difficulty_id: 18, font_grade: '6b', v_grade: 'V4' },
  { difficulty_id: 19, font_grade: '6b+', v_grade: 'V4' },
  { difficulty_id: 20, font_grade: '6c', v_grade: 'V5' },
  { difficulty_id: 21, font_grade: '6c+', v_grade: 'V5' },
  { difficulty_id: 22, font_grade: '7a', v_grade: 'V6' },
  { difficulty_id: 23, font_grade: '7a+', v_grade: 'V7' },
  { difficulty_id: 24, font_grade: '7b', v_grade: 'V8' },
  { difficulty_id: 25, font_grade: '7b+', v_grade: 'V8' },
  { difficulty_id: 26, font_grade: '7c', v_grade: 'V9' },
  { difficulty_id: 27, font_grade: '7c+', v_grade: 'V10' },
  { difficulty_id: 28, font_grade: '8a', v_grade: 'V11' },
  { difficulty_id: 29, font_grade: '8a+', v_grade: 'V12' },
  { difficulty_id: 30, font_grade: '8b', v_grade: 'V13' },
  { difficulty_id: 31, font_grade: '8b+', v_grade: 'V14' },
  { difficulty_id: 32, font_grade: '8c', v_grade: 'V15' },
  { difficulty_id: 33, font_grade: '8c+', v_grade: 'V16' },
];

function mapGradeToDifficulty(grade: string | null | undefined): number | null {
  if (!grade) return null;
  const normalized = grade.trim().toLowerCase();
  const parts = normalized.split('/');
  for (const part of parts) {
    const trimmed = part.trim();
    const vMatch = BOULDER_GRADES.find((g) => g.v_grade.toLowerCase() === trimmed);
    if (vMatch) return vMatch.difficulty_id;
    const fontMatch = BOULDER_GRADES.find((g) => g.font_grade === trimmed);
    if (fontMatch) return fontMatch.difficulty_id;
  }
  return null;
}

interface ValidatedRow {
  climbUuid?: string | null;
  climbName: string;
  angle: number;
  date: string;
  loggedGrade?: string | null;
  displayedGrade?: string | null;
  isBenchmark: boolean;
  tries: number;
  isMirror: boolean;
  isAscent: boolean;
  comment?: string | null;
}

export const importMutations = {
  importTicksBatch: async (
    _: unknown,
    { input }: { input: unknown },
    ctx: ConnectionContext,
  ): Promise<{
    imported: number;
    skipped: number;
    duplicates: number;
    errors: string[];
  }> => {
    requireAuthenticated(ctx);
    const validatedInput = validateInput(ImportTicksBatchInputSchema, input, 'input');
    const userId = ctx.userId!;
    const { boardType, rows, buildSessions } = validatedInput;
    const now = new Date().toISOString();

    let imported = 0;
    let skipped = 0;
    let duplicates = 0;
    const errors: string[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i] as ValidatedRow;
      const rowIndex = i + 1;

      try {
        // Resolve climb UUID
        let resolvedClimbUuid = row.climbUuid || null;

        if (!resolvedClimbUuid && row.climbName) {
          const matches = await db
            .select({ uuid: dbSchema.boardClimbs.uuid })
            .from(dbSchema.boardClimbs)
            .where(
              and(
                eq(dbSchema.boardClimbs.boardType, boardType),
                ilike(dbSchema.boardClimbs.name, row.climbName),
              ),
            )
            .limit(1);

          if (matches.length > 0) {
            resolvedClimbUuid = matches[0].uuid;
          }
        }

        if (!resolvedClimbUuid) {
          skipped++;
          errors.push(`Row ${rowIndex}: Could not find climb '${row.climbName}'`);
          continue;
        }

        // Parse date
        const climbedAt = new Date(row.date);
        if (isNaN(climbedAt.getTime())) {
          skipped++;
          errors.push(`Row ${rowIndex}: Invalid date '${row.date}'`);
          continue;
        }
        const climbedAtStr = climbedAt.toISOString();

        // Deduplicate
        const existing = await db
          .select({ id: dbSchema.boardseshTicks.id })
          .from(dbSchema.boardseshTicks)
          .where(
            and(
              eq(dbSchema.boardseshTicks.userId, userId),
              eq(dbSchema.boardseshTicks.climbUuid, resolvedClimbUuid),
              eq(dbSchema.boardseshTicks.angle, row.angle),
              eq(dbSchema.boardseshTicks.climbedAt, climbedAtStr),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          duplicates++;
          continue;
        }

        // Determine status
        let status: 'flash' | 'send' | 'attempt';
        if (!row.isAscent) {
          status = 'attempt';
        } else if (row.tries <= 1) {
          status = 'flash';
        } else {
          status = 'send';
        }

        // Insert tick
        await db.insert(dbSchema.boardseshTicks).values({
          uuid: uuidv4(),
          userId,
          boardType,
          climbUuid: resolvedClimbUuid,
          angle: row.angle,
          isMirror: row.isMirror,
          status,
          attemptCount: Math.max(row.tries, 1),
          quality: null,
          difficulty: mapGradeToDifficulty(row.loggedGrade || row.displayedGrade),
          isBenchmark: row.isBenchmark,
          comment: row.comment || '',
          climbedAt: climbedAtStr,
          createdAt: now,
          updatedAt: now,
          auroraType: null,
          auroraId: null,
          auroraSyncedAt: null,
          auroraSyncError: null,
        });

        imported++;
      } catch (rowError) {
        skipped++;
        errors.push(
          `Row ${rowIndex}: ${rowError instanceof Error ? rowError.message : 'Unknown error'}`,
        );
      }
    }

    // Build inferred sessions on the last batch
    if (buildSessions && imported > 0) {
      try {
        await runInferredSessionBuilderBatched({ userId });
      } catch (err) {
        console.error(`[importTicksBatch] Failed to build inferred sessions for user ${userId}:`, err);
      }
    }

    return { imported, skipped, duplicates, errors };
  },
};
