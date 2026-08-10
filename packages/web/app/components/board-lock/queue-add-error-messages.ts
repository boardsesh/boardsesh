import type { Climb, BoardDetails } from '@/app/lib/types';
import type { BoardCompatibilityResult } from '@/app/lib/board-compatibility';
import { formatBoardDisplayName } from '@/app/lib/string-utils';

type QueueAddFailure = Extract<BoardCompatibilityResult, { ok: false }>;

function climbBoardLabel(climb: Climb): string {
  if (climb.boardType) return formatBoardDisplayName(climb.boardType);
  return 'a different board';
}

function targetBoardLabel(target: BoardDetails): string {
  return formatBoardDisplayName(target.board_name);
}

function targetSizeLabel(target: BoardDetails): string {
  if (target.size_name) return target.size_name;
  return `${targetBoardLabel(target)} board`;
}

/**
 * Build the user-facing Snackbar message for a queue-add compatibility
 * failure. Shared by the board-route `QueueContext` validator hook and
 * the root-level `queue-bridge-context` adapter so the copy stays in
 * one place.
 */
export function queueAddErrorMessage(climb: Climb, target: BoardDetails, failure: QueueAddFailure): string {
  switch (failure.reason) {
    case 'board_name':
      return `That climb is set on ${climbBoardLabel(climb)}. Your queue is on ${targetBoardLabel(target)}.`;
    case 'layout':
      return `That climb is on a different ${targetBoardLabel(target)} layout.`;
    case 'holds_out_of_range':
      return `That climb uses holds your ${targetSizeLabel(target)} doesn't have.`;
  }
}
