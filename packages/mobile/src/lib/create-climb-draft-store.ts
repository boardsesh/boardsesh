// Local autosave for the in-progress create-climb form, keyed per board
// config so switching boards (or angle) restores the right working draft. This
// is NOT the server-side draft list (that lives in board_climb_stats and is
// read via SEARCH_CLIMBS `onlyDrafts`); this is a single client-only snapshot
// of whatever the user is currently painting, so a backgrounded app or an
// accidental navigation doesn't lose their work-in-progress.
//
// Backed by AsyncStorage (non-secret UI state) via the shared preference store.

import { getPreference, setPreference, removePreference } from './preference-store';

export type CreateClimbDraft = {
  /** JSON.stringify of the editor's LitUpHoldsMap. */
  holdsJson: string;
  name: string;
  description: string;
  isDraft: boolean;
};

const KEY_PREFIX = 'boardsesh_create_climb_draft:';

/**
 * Stable per-board key of the form
 * `${boardName}:${layoutId}:${sizeId}:${setIds}:${angle}` so two configs that
 * differ in any of those restore independent working drafts. `setIds` matters
 * because Kilter/Tension share a layout/size/angle across "original" vs
 * "commercial" (bolt-on) hold sets — leaving it out lets a draft from one set
 * restore hold IDs that don't exist in the current set.
 */
export function createClimbDraftKey(config: {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
}): string {
  return `${config.boardName}:${config.layoutId}:${config.sizeId}:${config.setIds}:${config.angle}`;
}

function storageKey(boardKey: string): string {
  return `${KEY_PREFIX}${boardKey}`;
}

function isCreateClimbDraft(value: unknown): value is CreateClimbDraft {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<CreateClimbDraft>;
  return (
    typeof candidate.holdsJson === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.description === 'string' &&
    typeof candidate.isDraft === 'boolean'
  );
}

/** Returns the saved working draft for this board, or null if none/invalid. */
export async function loadDraft(boardKey: string): Promise<CreateClimbDraft | null> {
  const stored = await getPreference<unknown>(storageKey(boardKey));
  return isCreateClimbDraft(stored) ? stored : null;
}

/** Persists the current working draft for this board (overwrites any prior). */
export async function saveDraft(boardKey: string, draft: CreateClimbDraft): Promise<void> {
  await setPreference(storageKey(boardKey), draft);
}

/** Drops the working draft for this board (after save, clear, or empty form). */
export async function clearDraft(boardKey: string): Promise<void> {
  await removePreference(storageKey(boardKey));
}
