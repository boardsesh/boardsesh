import type { BoardName, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { convertLitUpHoldsStringToMap } from '@boardsesh/board-constants/hold-states';

/** Window after first publish during which a non-draft climb can still be edited. */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The minimal record of a saved climb the editor tracks so subsequent saves
 * can update the same row (vs. creating a new one) and so the edit lock can be
 * computed. Mirrors the web form's `SavedClimbState`.
 */
export type SavedClimbSnapshot = {
  uuid: string;
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
 * Flatten a (possibly multi-frame) fork/draft frames string into a single
 * Aurora holds map for seeding the editor. Later frames override earlier ones,
 * matching the web form's draft-load behaviour.
 */
export function buildInitialHoldsMap(frames: string, board: BoardName): LitUpHoldsMap {
  if (!frames) return {};
  const framesMap = convertLitUpHoldsStringToMap(frames, board);
  return Object.entries(framesMap)
    .sort(([a], [b]) => Number(a) - Number(b))
    .reduce((acc, [, frame]) => ({ ...acc, ...frame }), {} as LitUpHoldsMap);
}
