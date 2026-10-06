/**
 * Editor state → the two mutations that store it.
 *
 * The whole write path is this one pure function, so "what would Save send?" is
 * a question a test can ask without a GraphQL client, a board, or a gesture.
 * Three things are decided here and nowhere else:
 *
 *  - which holds go on the wire at all (dirty and ON — a maybe is drawn but
 *    never written, and a switched-off hold is removed, never upserted);
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
import {
  allHolds,
  sprayEditorReducer,
  type SprayEditorHoldSource,
  type SprayEditorState,
} from './spray-hold-editor-reducer';

/** One hold as `SprayWallHoldInput` wants it. `id` absent = allocate a new catalogue id. */
export type SprayHoldWireInput = {
  id?: number;
  cx: number;
  cy: number;
  r: number;
  outline: number[] | null;
  source: SprayEditorHoldSource;
  confidence?: number | null;
  /** The removed hold this one replaced, carried as the server sent it. */
  movedFromHoldId?: number;
};

export type SprayHoldWritePlan = {
  /** For `upsertSprayWallHolds`. Empty means there is nothing to upsert. */
  upsert: readonly SprayHoldWireInput[];
  /**
   * The EDITOR's own ids for the holds in `upsert`, local negatives included.
   *
   * A successful save clears `dirty` for exactly these and no others. The wire
   * inputs cannot answer that question: a new hold goes out with no `id` at all,
   * because the server allocates it.
   */
  writtenIds: readonly number[];
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
  writtenIds: [],
  removeIds: [],
  unmappableIds: [],
  outlinesDropped: 0,
  overCap: false,
};

/**
 * What a commit would send for this state, at this version's homography.
 *
 * `homography` is the DRAFT version's stored photo→canonical matrix. A version
 * whose anchors were never solved carries the identity, which is exactly right:
 * the canonical frame is then the photo frame and this is a no-op map.
 */
export function buildSprayHoldWritePlan(state: SprayEditorState, homography: readonly number[]): SprayHoldWritePlan {
  const upsert: SprayHoldWireInput[] = [];
  const writtenIds: number[] = [];
  const unmappableIds: number[] = [];
  let outlinesDropped = 0;
  // Every hold that would be on the wall once this save lands: removed holds
  // have left `state.holds`, and neither a pending find nor a switched-off hold
  // is on the wall.
  let aliveAfterSave = 0;
  const removeIds = [...state.removedIds];
  // Membership check for the loop below; a wall carries up to 1500 holds.
  const queuedRemovals = new Set(removeIds);

  for (const hold of allHolds(state)) {
    // A find awaiting a verdict is not work in progress — it is a proposal.
    // Saving must not turn it into a hold on somebody's wall.
    if (hold.review === 'pending') continue;
    if (hold.review === 'rejected') {
      // Switched off. A stored one comes off the draft — the toggle already
      // queued it, and this makes sure no path can leave one both OFF on screen
      // and alive on the wall. A local one simply never goes out.
      if (hold.id > 0 && !queuedRemovals.has(hold.id)) {
        queuedRemovals.add(hold.id);
        removeIds.push(hold.id);
      }
      continue;
    }

    // A hold the server already carries stays alive whatever happens to this
    // save, so it counts now. A hold this session drew counts only if it
    // actually goes out — otherwise a wall one under its cap plus one valid
    // addition plus one off-wall addition would be reported over the cap,
    // although the mutation would land exactly ON it.
    const alreadyOnTheWall = hold.id > 0;
    if (alreadyOnTheWall) aliveAfterSave += 1;

    if (!hold.dirty) {
      // A clean local hold is one a previous save wrote and the refetch has not
      // renamed yet. Its row exists.
      if (!alreadyOnTheWall) aliveAfterSave += 1;
      continue;
    }

    const canonical = mapPhotoHoldToCanonical(homography, hold);
    if (!canonical) {
      unmappableIds.push(hold.id);
      continue;
    }
    if (!alreadyOnTheWall) aliveAfterSave += 1;

    const outline = ringForTheWire(canonical.outline);
    if (canonical.outline != null && outline == null) outlinesDropped += 1;

    writtenIds.push(hold.id);
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
      // Sent whenever the hold has one. A hold this draft drew is updated in
      // place, and the server writes the field as sent — left out, a nudge would
      // wipe the link. Correcting an inherited hold makes a successor whose link
      // is the corrected hold, so the field is ignored there.
      ...(hold.movedFromHoldId != null ? { movedFromHoldId: hold.movedFromHoldId } : {}),
    });
  }

  if (upsert.length === 0 && removeIds.length === 0) {
    return unmappableIds.length === 0 ? EMPTY_PLAN : { ...EMPTY_PLAN, unmappableIds };
  }

  return {
    upsert,
    writtenIds,
    removeIds,
    unmappableIds,
    outlinesDropped,
    // One condition, not two: `upsert` is a subset of the alive holds, so
    // `upsert.length` can never exceed `aliveAfterSave` and a second test on it
    // is unreachable.
    overCap: aliveAfterSave > MAX_HOLDS_PER_WALL,
  };
}

/** Is there anything for a commit to write? */
export function planHasWork(plan: SprayHoldWritePlan): boolean {
  return plan.upsert.length > 0 || plan.removeIds.length > 0;
}

/**
 * Everything Publish needs from the editor, in one pure step: the confident
 * finds accepted, then the write plan for the result.
 *
 * Idempotent by construction. Accepting the defaults of a state whose defaults
 * are already accepted changes nothing (the reducer hands back the SAME object),
 * so running this twice on its own output yields the same plan. And once
 * `MARK_SAVED` has cleared the written holds' dirty flags, running it again
 * yields a plan with nothing to upsert — a second press can never add the same
 * hold twice. The screen still refuses a second press while one is in flight;
 * this is what makes the retry after a failure safe as well.
 */
export function prepareCommit(
  state: SprayEditorState,
  homography: readonly number[],
): { state: SprayEditorState; plan: SprayHoldWritePlan } {
  const accepted = sprayEditorReducer(state, { type: 'ACCEPT_DEFAULTS' });
  return { state: accepted, plan: buildSprayHoldWritePlan(accepted, homography) };
}
