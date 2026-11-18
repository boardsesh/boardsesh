import { inArray } from 'drizzle-orm';
import { boardSessions } from '@boardsesh/db/schema/app';
import { BOARD_TYPES, CreateWorkoutSchema, workoutBlockSupport } from '@boardsesh/public-api';
import { db } from '../../db/client';
import { captureBackendEvent } from '../analytics/posthog';
import { logger } from '../../utils/logger';
import type { AppWorkoutRow } from './workouts';

/** Personless completion counts, only after the session transaction commits. */
export async function reportCompletedAppWorkouts(
  workouts: readonly AppWorkoutRow[],
  completion: 'completed' | 'auto_closed',
): Promise<void> {
  if (!workouts.length) return;
  try {
    const sessionIds = [...new Set(workouts.flatMap((workout) => (workout.sessionId ? [workout.sessionId] : [])))];
    const sessions = sessionIds.length
      ? await db
          .select({ id: boardSessions.id, boardPath: boardSessions.boardPath })
          .from(boardSessions)
          .where(inArray(boardSessions.id, sessionIds))
      : [];
    const boardBySession = new Map(
      sessions.map((session) => [
        session.id,
        BOARD_TYPES.find((boardType) => boardType === session.boardPath?.split('/')[0]) ?? null,
      ]),
    );
    for (const workout of workouts) {
      const spec = CreateWorkoutSchema.safeParse(workout.spec);
      if (!spec.success) continue;
      captureBackendEvent('App Workout Completed', {
        systemDistinctId: 'system:partner-workout-completion',
        properties: {
          clientId: workout.clientId,
          board_name: workout.sessionId ? (boardBySession.get(workout.sessionId) ?? null) : null,
          blockTypes: spec.data.blocks.map((block) => block.type).join(','),
          nativeBlockCount: spec.data.blocks.filter((block) => workoutBlockSupport(block) === 'native').length,
          freeformBlockCount: spec.data.blocks.filter((block) => workoutBlockSupport(block) === 'freeform').length,
          completion: completion === 'completed' ? 'ended' : 'auto_closed',
        },
      });
    }
  } catch {
    logger.warn('[PartnerWorkouts] Completion measurement unavailable');
  }
}
