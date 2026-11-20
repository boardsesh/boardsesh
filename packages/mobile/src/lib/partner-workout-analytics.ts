import type { AppWorkout } from './pending-workout-store';

/** No titles, notes, workout IDs or climber IDs enter the handoff funnel. */
export function partnerWorkoutAnalytics(workout: AppWorkout, boardName: string | null) {
  const freeformBlockCount = workout.spec.blocks.filter((block) => block.type === 'limitBouldering').length;
  return {
    clientId: workout.clientId,
    blockTypes: workout.spec.blocks.map((block) => block.type).join(','),
    nativeBlockCount: workout.spec.blocks.length - freeformBlockCount,
    freeformBlockCount,
    board_name: boardName,
  };
}
