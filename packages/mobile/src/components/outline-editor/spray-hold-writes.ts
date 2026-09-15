/**
 * Editor state → the two mutations that store it.
 *
 * The whole write path is this one pure function, so "what would Save send?" is
 * a question a test can ask without a GraphQL client, a board, or a gesture.
 * Three things are decided here and nowhere else:
 *
 *  - which holds go on the wire at all (dirty, and ruled on — a pending
 *    candidate is drawn but never written);
 *  - what frame they go in (canonical, via the version's homography);
 *  - whether each one keeps its silhouette (the backend's own ring contract,
 *    imported rather than restated — see `ring-contract.ts`).
 *
 * Order matters at the call site, not here: removals are stamped before upserts,
 * so a merge's victim is off the wall before its survivor's new geometry lands.
 * The plan carries both halves and the caller sends them in that order.
 */

import { MAX_HOLDS_PER_WALL } from '@boardsesh/board-config';
import { mapPhotoHoldToCanonical } from '../../lib/spray/spray-hold-canonical';
import { ringForTheWire } from './ring-contract';
import { allHolds, type SprayEditorHoldSource, type SprayEditorState } from './spray-hold-editor-reducer';

/** One hold as `SprayWallHoldInput` wants it. `id` absent = allocate a new catalogue id. */
export type SprayHoldWireInput = {
  id?: number;
  cx: number;
  cy: number;
  r: number;
  outline: number[] | null;
  source: SprayEditorHoldSource;
  confidence?: number | null;
};

export type SprayHoldWritePlan = {
  /** For `upsertSprayWallHolds`. Empty means there is nothing to upsert. */
  upsert: readonly SprayHoldWireInput[];
  /** For `removeSprayWallHolds`. Server ids only. */
  removeIds: readonly number[];
  /**
   * Holds the homography sends nowhere, dropped rather than written at a
   * plausible-looking wrong coordinate. A screen surfaces the count; the wall
   * itself is still saveable, which is the point of dropping one hold instead of
   * failing the batch.
   */
  unmappableIds: readonly number[];
  /** Holds written as plain circles because their ring could not be stored. */
  outlinesDropped: number;
  /**
   * The wall would end up over its hold cap.
   *
   * Measured the way the SERVER measures it — the holds alive after this save,
   * not the size of this batch. `upsertSprayWallHolds` re-checks the wall's
   * total afterwards (`spray-walls.ts`), so a near-full wall is refused by a
   * five-hold batch that no per-batch bound would ever catch, and the climber
   * would get a raw server error instead of a sentence telling them to drop a
   * few.
   */
  overCap: boolean;
};

const EMPTY_PLAN: SprayHoldWritePlan = {
  upsert: [],
  removeIds: [],
  unmappableIds: [],
  outlinesDropped: 0,
  overCap: false,
};

/**
 * What Save would send for this state, at this version's homography.
 *
 * `homography` is the DRAFT version's stored photo→canonical matrix. A version
 * whose anchors were never solved carries the identity, which is exactly right:
 * the canonical frame is then the photo frame and this is a no-op map.
 */
export function buildSprayHoldWritePlan(state: SprayEditorState, homography: readonly number[]): SprayHoldWritePlan {
  const upsert: SprayHoldWireInput[] = [];
  const unmappableIds: number[] = [];
  let outlinesDropped = 0;
  // Every hold that would be on the wall once this save lands: the removals have
  // already left `state.holds`, and a pending candidate is not on the wall.
  let aliveAfterSave = 0;

  for (const hold of allHolds(state)) {
    // A candidate awaiting a verdict is not work in progress — it is a proposal.
    // Saving must not turn it into a hold on somebody's wall.
    if (hold.review === 'pending') continue;
    aliveAfterSave += 1;
    if (!hold.dirty) continue;

    const canonical = mapPhotoHoldToCanonical(homography, hold);
    if (!canonical) {
      unmappableIds.push(hold.id);
      continue;
    }

    const outline = ringForTheWire(canonical.outline);
    if (canonical.outline != null && outline == null) outlinesDropped += 1;

    upsert.push({
      // A negative id is this session's own bookkeeping and means "new hold";
      // the server allocates the catalogue id.
      ...(hold.id > 0 ? { id: hold.id } : {}),
      cx: canonical.cx,
      cy: canonical.cy,
      r: canonical.r,
      outline,
      source: hold.source,
      // Only ever sent for a detector hold. A hand-drawn hold has no confidence
      // to report, and sending 1 would claim a measurement nobody made.
      ...(hold.source === 'AUTO' ? { confidence: hold.confidence } : {}),
    });
  }

  if (upsert.length === 0 && state.removedIds.length === 0) {
    return unmappableIds.length === 0 ? EMPTY_PLAN : { ...EMPTY_PLAN, unmappableIds };
  }

  return {
    upsert,
    removeIds: [...state.removedIds],
    unmappableIds,
    outlinesDropped,
    overCap: aliveAfterSave > MAX_HOLDS_PER_WALL || upsert.length > MAX_HOLDS_PER_WALL,
  };
}

/** Is there anything for Save to do? */
export function planHasWork(plan: SprayHoldWritePlan): boolean {
  return plan.upsert.length > 0 || plan.removeIds.length > 0;
}
