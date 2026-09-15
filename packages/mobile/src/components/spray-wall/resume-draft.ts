// Finding the wall somebody walked away from (epic #5346, SW-09).
//
// `createSprayWall` writes a real `user_boards` row before the photo is ever
// uploaded, because the upload handler authorises against a wall the caller
// owns. So an abandoned run does not leave nothing behind — it leaves a wall
// with no published version, which counts against the ten-wall cap and which the
// leave prompt explicitly promises the climber can pick up again.
//
// Two rules make that promise true, and both live here rather than in the screen
// so they can be tested without a network:
//
//  1. **One unfinished wall is resumed, never duplicated.** The next run of the
//     flow looks for a wall of the caller's own with no published version and
//     offers it back.
//  2. **Where it rejoins depends on how far it got.** A wall whose draft already
//     carries a photo rejoins at the hold editor; a bare wall rejoins at the
//     photo step, since its name, angle and visibility are already on the row.
//
// The alternative — always creating a fresh wall — is what makes ten abandoned
// attempts lock a climber out of their own feature.

import type { CreatedWall, CreatedWallDraft } from './add-wall-machine';

/** The slice of `SprayWall` this module reads. Structural, so the query shape can grow. */
export type ResumableWall = {
  uuid: string;
  layoutId: number;
  viewerCanEdit: boolean;
  /** The wall's board row — its name is what the resume prompt calls it. */
  board: { name: string };
  /** The published generation. Null until the first publish — which is what "unfinished" means. */
  currentVersion?: { id: string } | null;
};

/** The slice of `SprayWallVersion` needed to decide where a wall rejoins. */
export type ResumableVersion = {
  id: string;
  number: number;
  status: string;
  /** Present once a photo has been adopted onto the version. */
  photo?: { url?: string | null } | null;
};

/**
 * The wall an interrupted run left behind, or null.
 *
 * "Unfinished" is `currentVersion == null`: a wall that has published once is a
 * real board its owner climbs on, and a later reset is SW-13's flow rather than
 * this one. Only a wall the viewer may edit is offered — the list can carry
 * walls shared by a gym, and resuming somebody else's half-built wall is not a
 * thing this flow may do.
 *
 * The FIRST match wins rather than the newest. `mySprayWalls` is server-ordered,
 * and a climber with two abandoned walls has a bigger problem than which one
 * comes back; picking deterministically at least means the same one comes back
 * every time.
 */
export function findResumableWall(walls: readonly ResumableWall[]): ResumableWall | null {
  return walls.find((wall) => wall.viewerCanEdit && wall.currentVersion == null) ?? null;
}

/** The wall's one open draft, or null when nothing has been adopted onto it. */
export function findOpenDraft(versions: readonly ResumableVersion[]): ResumableVersion | null {
  return versions.find((version) => version.status.toLowerCase() === 'draft') ?? null;
}

export type ResumeTarget = { at: 'review'; draft: CreatedWallDraft } | { at: 'photo'; wall: CreatedWall };

/**
 * Where a resumed wall rejoins the flow.
 *
 * A draft with a photo has everything the hold editor needs, so it goes straight
 * there. A draft with no photo is indistinguishable from no draft at all for
 * this purpose — there is nothing to draw on — so it rejoins at the photo step,
 * where the upload will adopt one onto the draft that is already open.
 */
export function resumeTargetFor(wall: ResumableWall, versions: readonly ResumableVersion[]): ResumeTarget {
  const draft = findOpenDraft(versions);
  if (draft && draft.photo?.url) {
    return {
      at: 'review',
      draft: {
        wallUuid: wall.uuid,
        layoutId: wall.layoutId,
        viewerCanEdit: wall.viewerCanEdit,
        versionId: draft.id,
        versionNumber: draft.number,
      },
    };
  }
  return {
    at: 'photo',
    wall: { wallUuid: wall.uuid, layoutId: wall.layoutId, viewerCanEdit: wall.viewerCanEdit },
  };
}

/**
 * What "Start over" has to undo, in the order it has to undo it.
 *
 * A draft is discarded before the wall is deleted because the two are not
 * independent: the draft holds the wall's holds and its photo, and deleting a
 * wall out from under an open draft is not a path the API promises anything
 * about. Discarding first leaves a bare wall row, which `deleteSprayWall`
 * removes cleanly.
 *
 * Both are best-effort at the call site: a start-over that cannot reach the
 * server must still let the climber build their wall, and the worst case is one
 * stray row the SW-17 cleanup job sweeps.
 */
export function startOverPlan(
  wall: ResumableWall,
  versions: readonly ResumableVersion[],
): { discardVersionId: string | null; deleteWallUuid: string } {
  const draft = findOpenDraft(versions);
  return { discardVersionId: draft?.id ?? null, deleteWallUuid: wall.uuid };
}
