import type { BoardName, LitUpHoldsMap } from '@boardsesh/shared-schema';
import { accumulateFramesToMaps } from '@boardsesh/board-constants/hold-states';

/**
 * Window after first publish during which the setter can still edit a published
 * climb, on every board a spray wall included. The app is stricter than the
 * current server here: `updateClimb` still exempts spray climbs from the window
 * until #6183 ships, so for a spray climb this is the app's rule alone.
 */
export const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The minimal record of a saved climb the editor tracks so subsequent saves
 * can update the same row (vs. creating a new one) and so the edit lock can be
 * computed.
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
 * Same board, and either still a draft (editable indefinitely) or published
 * within the 24h window. The server enforces the same rule in `updateClimb`.
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
 * Drafts are never locked.
 */
export function computeEditLocked(saved: SavedClimbSnapshot | null, now: number = Date.now()): boolean {
  if (!saved || saved.isDraft || !saved.publishedAt) return false;
  const publishedMs = Date.parse(saved.publishedAt);
  return Number.isFinite(publishedMs) && now - publishedMs > EDIT_WINDOW_MS;
}

/** The fields of a climb the edit rule reads. A `Climb` satisfies it as is. */
export type EditableClimb = {
  uuid: string;
  /** Null for Aurora-synced climbs that predate Boardsesh accounts. */
  userId?: string | null;
  is_draft?: boolean | null;
  published_at?: string | null;
  created_at?: string | null;
};

export type CanEditClimbInput = {
  climb: EditableClimb | null | undefined;
  /** The board the climb is being looked at on. */
  boardType: string;
  /** Null when signed out. */
  currentUserId: string | null | undefined;
  now?: number;
};

/**
 * Should this viewer be offered Edit on this climb? The whole client rule, in
 * one place, so the action menus cannot drift. The same on every board, a spray
 * wall included:
 *
 * | The climb is | Who        | For how long                 |
 * | ------------ | ---------- | ---------------------------- |
 * | a draft      | its setter | always                       |
 * | published    | its setter | 24 hours after first publish |
 *
 * A hint, not a permission: `updateClimb` decides, and a viewer this gets wrong
 * meets the server's refusal in the editor.
 */
export function canEditClimb({ climb, boardType, currentUserId, now = Date.now() }: CanEditClimbInput): boolean {
  if (!climb || !currentUserId) return false;
  const isDraft = climb.is_draft ?? false;
  const isSetter = !!climb.userId && climb.userId === currentUserId;
  if (!isSetter) return false;

  return computeCanUpdate(
    {
      uuid: climb.uuid,
      boardType,
      createdAt: climb.created_at ?? null,
      publishedAt: climb.published_at ?? null,
      isDraft,
    },
    boardType,
    now,
  );
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
