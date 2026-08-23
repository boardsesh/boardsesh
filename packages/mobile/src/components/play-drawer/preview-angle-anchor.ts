/**
 * Keeping a pinned browse preview alive across an angle change.
 *
 * A climb's grade, quality and send count are angle-specific, and a queue item
 * carries them baked in for the angle it was fetched at. The COMMITTED climb has
 * a self-healing path for that: `useQueueRegrade` notices `climb.angle !== angle`
 * and patches the queue item in place from a fresh `GET_CLIMB`. A pinned drawer
 * preview has no such path — it lives in component state, not in the queue — so
 * the drawer used to drop it on every angle change and fall back to the queue
 * head.
 *
 * That was fine when a preview was a momentary thing. Under the shared-session
 * browse latch it is where the climber LIVES: reaching for the angle pill
 * mid-browse would have thrown away the climb they were looking at, the
 * suggestion track they were walking, and the latch itself. So the drawer now
 * re-anchors instead — same climb, same latch, grade re-resolved at the new
 * angle — using the same patch shape `useQueueRegrade` dispatches, so the two
 * paths can't disagree about what "the grade at this angle" means.
 */

import type { ClimbQueueItem, ClimbRegradePatch } from '@boardsesh/queue';
import type { Climb } from '@boardsesh/shared-schema';

/**
 * Whether the pinned preview is showing a grade from a different angle than the
 * board is set to. An item with no angle on its climb is left alone: there is
 * nothing to compare, and re-fetching on a guess would be a request per render.
 */
export function previewNeedsAngleReanchor(item: ClimbQueueItem | null, angle: number): boolean {
  const climbAngle = item?.climb?.angle;
  return climbAngle != null && climbAngle !== angle;
}

/**
 * The angle-specific fields to copy off a climb fetched at the live angle —
 * exactly `ClimbRegradePatch`, the shape `useQueueRegrade` builds for the
 * committed path.
 */
function toRegradePatch(climb: Climb, angle: number): ClimbRegradePatch {
  return {
    angle,
    difficulty: climb.difficulty,
    quality_average: climb.quality_average,
    ascensionist_count: climb.ascensionist_count,
    benchmark_difficulty: climb.benchmark_difficulty ?? null,
    difficulty_error: climb.difficulty_error,
    // Explicit nulls so an angle with no boardsesh grade row clears the stale
    // value from the climb's previous angle.
    boardseshDifficulty: climb.boardseshDifficulty ?? null,
    boardseshConfidence: climb.boardseshConfidence ?? null,
  };
}

/**
 * Re-anchor a pinned preview at `angle` from a freshly fetched climb.
 *
 * Returns the SAME item reference whenever there is nothing to do — no item, a
 * fetch for a different climb (a stale response landing after the climber swiped
 * on), or an item already at this angle. That identity guarantee is what lets
 * the caller feed this straight into a `setState` updater without churning the
 * preview on every render.
 *
 * The queue item's own uuid is preserved: it is the drawer's navigation anchor,
 * and minting a fresh one would break prev/next and the remaining count.
 */
export function reanchorPreviewAtAngle(
  item: ClimbQueueItem | null,
  angle: number,
  climbAtAngle: Climb | null | undefined,
): ClimbQueueItem | null {
  if (!item || !climbAtAngle) return item;
  if (item.climb?.uuid !== climbAtAngle.uuid) return item;
  if (!previewNeedsAngleReanchor(item, angle)) return item;
  return { ...item, climb: { ...item.climb, ...toRegradePatch(climbAtAngle, angle) } };
}
