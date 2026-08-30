import type { BoardName, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { accumulateFramesToMaps } from '@boardsesh/board-constants/hold-states';

/** Window after first publish during which a non-draft climb can still be edited. */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The minimal record of a saved climb the editor tracks so subsequent saves
 * can update the same row (vs. creating a new one) and so the edit lock can be
 * computed. Mirrors the web form's `SavedClimbState`.
 */
export type SavedClimbSnapshot = {
  uuid: string;
  /** Stable controller-side route identity for explicit Quantum activation. */
  controllerRouteUuid?: string | null;
  boardType: string;
  createdAt: string | null;
  /** ISO timestamp of first publish; null while the climb is a draft. */
  publishedAt: string | null;
  isDraft: boolean;
};

/**
 * Can the tracked row be updated in place rather than creating a new one?
 * Mirrors web `create-climb-form.tsx` `canUpdate`: same board, and either still
 * a draft (editable indefinitely) or published within the 24h edit window.
 */
export function computeCanUpdate(
  saved: SavedClimbSnapshot | null,
  boardType: string,
  now: number = Date.now(),
): boolean {
  if (!saved) return false;
  if (saved.boardType !== boardType) return false;
  if (saved.isDraft) return true;
  if (!saved.publishedAt) return false;
  const publishedMs = Date.parse(saved.publishedAt);
  return Number.isFinite(publishedMs) && now - publishedMs <= EDIT_WINDOW_MS;
}

/**
 * Is the tracked row published and past the 24h window (no further edits)?
 * Mirrors web `editLocked`. Drafts are never locked.
 */
export function computeEditLocked(saved: SavedClimbSnapshot | null, now: number = Date.now()): boolean {
  if (!saved || saved.isDraft || !saved.publishedAt) return false;
  const publishedMs = Date.parse(saved.publishedAt);
  return Number.isFinite(publishedMs) && now - publishedMs > EDIT_WINDOW_MS;
}

/**
 * Decode a (possibly multi-frame) fork/draft/edit frames string into the
 * editor's per-frame sequence, preserving frame separation — unlike the old
 * flatten-to-one-map seeding this replaced, a multi-frame route/circuit no
 * longer collapses into a single frame when you fork or edit it.
 *
 * Falls back to a single empty frame for an empty string, matching a
 * brand-new climb's starting state.
 */
export function buildInitialFrames(frames: string, board: BoardName): LitUpHoldsMap[] {
  if (!frames) return [{}];
  const maps = accumulateFramesToMaps(frames, board);
  return maps.length > 0 ? maps : [{}];
}
