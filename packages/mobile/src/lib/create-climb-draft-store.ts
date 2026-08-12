// Local autosave for the in-progress create-climb form, keyed per board
// config so switching boards (or angle) restores the right working draft. This
// is NOT the server-side draft list (that lives in board_climb_stats and is
// read via SEARCH_CLIMBS `onlyDrafts`); this is a single client-only snapshot
// of whatever the user is currently painting, so a backgrounded app or an
// accidental navigation doesn't lose their work-in-progress.
//
// Backed by AsyncStorage (non-secret UI state) via the shared preference store.

import { getPreference, setPreference, removePreference, removePreferencesMatching } from './preference-store';
import type { UserStorageOwner } from './user-storage-owner';

export type MoonBoardDraftMetadata = {
  angle: 25 | 40;
  userGrade: string | null;
  method: 'method_footless' | 'method_footless_kickboard' | 'method_no_kickboard' | null;
  isBenchmark: boolean;
};

export type CreateClimbDraft = {
  /** JSON.stringify of the editor's LitUpHoldsMap. */
  holdsJson: string;
  name: string;
  description: string;
  isDraft: boolean;
  /** MoonBoard-only state. Optional so pre-existing WIP snapshots still load. */
  moonboard?: MoonBoardDraftMetadata;
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

function readMoonBoardMetadata(value: unknown): MoonBoardDraftMetadata | undefined {
  if (value == null || typeof value !== 'object') return undefined;
  const candidate = value as Partial<MoonBoardDraftMetadata>;
  const validMethod =
    candidate.method === null ||
    candidate.method === 'method_footless' ||
    candidate.method === 'method_footless_kickboard' ||
    candidate.method === 'method_no_kickboard';
  if (
    (candidate.angle !== 25 && candidate.angle !== 40) ||
    (candidate.userGrade !== null && typeof candidate.userGrade !== 'string') ||
    !validMethod ||
    typeof candidate.isBenchmark !== 'boolean'
  ) {
    return undefined;
  }
  return {
    angle: candidate.angle,
    userGrade: candidate.userGrade,
    method: candidate.method as MoonBoardDraftMetadata['method'],
    isBenchmark: candidate.isBenchmark,
  };
}

/** Returns the saved working draft for this board, or null if none/invalid. */
export async function loadDraft(boardKey: string, _owner?: UserStorageOwner | null): Promise<CreateClimbDraft | null> {
  const stored = await getPreference<unknown>(storageKey(boardKey));
  if (!isCreateClimbDraft(stored)) return null;
  return { ...stored, moonboard: readMoonBoardMetadata(stored.moonboard) };
}

/** Persists the current working draft for this board (overwrites any prior). */
export async function saveDraft(
  boardKey: string,
  draft: CreateClimbDraft,
  _owner?: UserStorageOwner | null,
): Promise<void> {
  await setPreference(storageKey(boardKey), draft);
}

/** Drops the working draft for this board (after save, clear, or empty form). */
export async function clearDraft(boardKey: string, _owner?: UserStorageOwner | null): Promise<void> {
  await removePreference(storageKey(boardKey));
}

/** Drops every locally saved create-climb draft for the departing account. */
export function clearAllCreateClimbDrafts(_owner?: UserStorageOwner | null): Promise<void> {
  return removePreferencesMatching((key) => key.startsWith(KEY_PREFIX));
}
