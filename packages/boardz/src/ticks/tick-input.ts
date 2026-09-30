import type { Climb, SaveTickInput, TickStatus } from '@boardsesh/shared-schema';
import { clampAttempts, deriveAscentType } from '@boardsesh/play-view';
import type { ActiveBoard } from '../board/active-board';

export type TickDetails = {
  status: TickStatus;
  attempts: number;
  /** 1-5 stars; null when the climber didn't rate it. */
  quality: number | null;
  /** The climber's grade opinion as a difficulty id; null keeps the consensus grade. */
  difficulty: number | null;
  comment: string;
};

/**
 * The SaveTick input for a climb logged on the active board, filled the way
 * Boardsesh's own apps fill it (see mobile's use-quick-tick-form), so ticks from
 * Boardz look the same in the logbook.
 */
export function buildTickInput(
  board: ActiveBoard,
  climb: Pick<Climb, 'uuid' | 'benchmark_difficulty'>,
  details: TickDetails,
  now: Date,
): SaveTickInput {
  return {
    boardType: board.boardName,
    climbUuid: climb.uuid,
    angle: board.angle,
    isMirror: false,
    status: details.status,
    attemptCount: clampAttempts(details.attempts, details.status),
    quality: details.quality !== null && details.quality > 0 ? details.quality : null,
    difficulty: details.difficulty,
    isBenchmark: climb.benchmark_difficulty != null,
    comment: details.comment.trim(),
    climbedAt: now.toISOString(),
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: board.setIds.join(','),
    // Attach the tick to the climber's saved wall, when the board came from their account.
    ...(board.boardUuid ? { boardUuid: board.boardUuid } : {}),
  };
}

/** A first-go send is a flash only when the climber has never logged this climb at this angle. */
export function sendStatus(hasHistory: boolean, attempts: number): 'flash' | 'send' {
  return deriveAscentType(hasHistory, attempts);
}
