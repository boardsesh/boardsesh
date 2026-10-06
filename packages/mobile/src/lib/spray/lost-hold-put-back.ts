// "Put this hold back on the wall" (#5493): the round trip from the climb
// editor into the hold editor and back.
//
// The climb editor cannot stay up underneath: its drawer is a native sheet, and
// a native sheet presents over every route pushed after it. So the trip is
// close the climb editor → open the hold editor → close it → open the climb
// editor again, and the working copy has to survive two unmounts. It cannot ride
// the autosave slot: a new climb's and a remix's slots are keyed by the wall
// VERSION, and publishing is exactly what moves the version (the loader then
// sweeps the old version's slots). So the copy travels here, in memory, with the
// route params that reopen the editor.
//
// One request at a time: the trip is modal, and a second one starting would
// mean the first was abandoned.

import { router } from 'expo-router';
import type { HoldPlacement } from '@boardsesh/create-climb-react';
import type { CreateClimbDraft } from '../create-climb-draft-store';
import { SHEET_SETTLE_MS } from '../../providers/sheet-presentation-provider';
import { getSprayWall } from './spray-wall-registry';
import { sprayHoldEditorHref } from './spray-routes';

/** A removed hold in the wall's canonical frame — where it was, as the server keeps it. */
export type PutBackLostHold = {
  id: number;
  cx: number;
  cy: number;
  r: number;
  outline: readonly number[] | null;
};

export type LostHoldPutBackRequest = {
  requestId: string;
  wallUuid: string;
  layoutId: number;
  lostHold: PutBackLostHold;
  /** Where the lost hold sat in the climb, and its role there. */
  placements: readonly HoldPlacement[];
  /** Live holds already linked to the lost one, so the new one can be told apart. */
  knownSuccessorIds: readonly number[];
  /** The params that reopen the climb editor on the same climb. */
  createParams: Readonly<Record<string, string>>;
  /** The climb editor's working copy when the climber left it. */
  draft: CreateClimbDraft;
  /** `published` once the hold editor published the wall. */
  status: 'pending' | 'published';
};

/** What the reopened climb editor gets back. */
export type LostHoldPutBackReturn = {
  draft: CreateClimbDraft;
  placements: readonly HoldPlacement[];
  /** The hold that went back on, or null when the trip was abandoned or it cannot be found. */
  newHoldId: number | null;
};

/** The route param the reopened climb editor reads. */
export const PUT_BACK_REQUEST_PARAM = 'putBackRequest';
/** The route param the hold editor reads. */
export const PUT_BACK_HOLD_EDITOR_PARAM = 'putBack';

let current: LostHoldPutBackRequest | null = null;
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `put-back-${Date.now().toString(36)}-${requestCounter}`;
}

/** The request the hold editor was opened for, or null (a stale or hand-typed link). */
export function getLostHoldPutBack(requestId: string | null | undefined): LostHoldPutBackRequest | null {
  return requestId && current?.requestId === requestId ? current : null;
}

/** The hold editor published the wall. */
export function markLostHoldPutBackPublished(requestId: string): void {
  if (current?.requestId === requestId) current = { ...current, status: 'published' };
}

/**
 * The newest live hold linked to the lost one that was not linked before the
 * trip — the one the owner just put back.
 */
export function findPutBackHoldId(
  request: Pick<LostHoldPutBackRequest, 'layoutId' | 'lostHold' | 'knownSuccessorIds'>,
): number | null {
  const wall = getSprayWall(request.layoutId);
  if (!wall) return null;
  const known = new Set(request.knownSuccessorIds);
  let newest: number | null = null;
  for (const hold of wall.holds) {
    if (hold.movedFromHoldId !== request.lostHold.id || known.has(hold.id)) continue;
    if (newest === null || hold.id > newest) newest = hold.id;
  }
  return newest;
}

/**
 * What the reopened climb editor should apply, or null. A read, not a take:
 * React may run a state initialiser twice, so the editor clears the request with
 * `finishLostHoldPutBack` once it has applied it, and a later remount (a board
 * change, a fast refresh) then finds nothing to apply twice.
 */
export function readLostHoldPutBackReturn(requestId: string | null | undefined): LostHoldPutBackReturn | null {
  const request = getLostHoldPutBack(requestId);
  if (!request) return null;
  return {
    draft: request.draft,
    placements: request.placements,
    newHoldId: request.status === 'published' ? findPutBackHoldId(request) : null,
  };
}

/** The climb editor has applied the return. */
export function finishLostHoldPutBack(requestId: string | null | undefined): void {
  if (requestId && current?.requestId === requestId) current = null;
}

/** Test seam: forget any request. */
export function resetLostHoldPutBack(): void {
  current = null;
}

/**
 * Leave the climb editor for the hold editor.
 *
 * `closeClimbEditor` pops the climb editor's route. The hold editor is pushed
 * once the editor's native sheet has had time to leave the screen; pushed any
 * sooner, the sheet would present over it.
 */
export function startLostHoldPutBack(
  request: Omit<LostHoldPutBackRequest, 'requestId' | 'status'>,
  closeClimbEditor: () => void,
): string {
  const requestId = nextRequestId();
  current = { ...request, requestId, status: 'pending' };
  closeClimbEditor();
  setTimeout(() => {
    if (current?.requestId !== requestId) return;
    router.push(
      `${sprayHoldEditorHref(request.wallUuid)}&${PUT_BACK_HOLD_EDITOR_PARAM}=${encodeURIComponent(requestId)}`,
    );
  }, SHEET_SETTLE_MS);
  return requestId;
}

/**
 * The hold editor is going away, published or not: reopen the climb editor on
 * the same climb, carrying the working copy. Called from the hold editor's
 * unmount, after its route has started to leave.
 */
export function returnToClimbEditor(requestId: string): void {
  const request = getLostHoldPutBack(requestId);
  if (!request) return;
  setTimeout(() => {
    if (current?.requestId !== requestId) return;
    router.push({
      pathname: '/(tabs)/climbs/create',
      params: { ...request.createParams, [PUT_BACK_REQUEST_PARAM]: requestId },
    });
  }, SHEET_SETTLE_MS);
}
