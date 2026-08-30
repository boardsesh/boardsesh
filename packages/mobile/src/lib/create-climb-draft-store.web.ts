import { getPreference, removePreference, removePreferencesMatching, setPreference } from './preference-store';
import type { UserStorageOwner } from './user-storage-owner';
import { userScopedStorageKey } from './user-storage-owner.web';

/** Which authoring mode wrote this slot. Diagnostic only — the key decides. */
export type CreateClimbDraftOrigin = 'new' | 'edit' | 'fork';

// Mirrors the native shape field for field. `framesJson` round-tripped here all
// along (the validator ignores unknown keys) but was missing from the type.
export type CreateClimbDraft = {
  /** JSON.stringify of the editor's active-frame LitUpHoldsMap. */
  holdsJson: string;
  /** JSON.stringify(LitUpHoldsMap[]) — the full frame sequence. */
  framesJson?: string;
  name: string;
  description: string;
  isDraft: boolean;
  /** JSON.stringify of the attached `SavedClimbSnapshot`. See the native fork. */
  savedClimbJson?: string;
  /** Payload signature at the last successful server save. See the native fork. */
  savedPayloadSignature?: string;
  origin?: CreateClimbDraftOrigin;
  updatedAtMs?: number;
};

const KEY_PREFIX = 'boardsesh_create_climb_draft:';

export function createClimbDraftKey(config: {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
}): string {
  return `${config.boardName}:${config.layoutId}:${config.sizeId}:${config.setIds}:${config.angle}`;
}

/** See the native fork — one deterministic slot per authoring mode. */
export function createClimbEditDraftKey(boardType: string, uuid: string): string {
  return `edit:${boardType}:${uuid}`;
}

export function createClimbForkDraftKey(boardKey: string): string {
  return `fork:${boardKey}`;
}

/**
 * False for a signed-out browser visitor: every write here is account-scoped and
 * `userScopedStorageKey` returns null with no owner, so nothing is stored at all.
 * The status line reads this instead of promising a draft that was never written.
 */
export function isDraftStorageAvailable(owner?: UserStorageOwner | null): boolean {
  return userScopedStorageKey('', owner) !== null;
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

export async function loadDraft(boardKey: string, owner?: UserStorageOwner | null): Promise<CreateClimbDraft | null> {
  const scopedKey = userScopedStorageKey(storageKey(boardKey), owner);
  if (!scopedKey) return null;
  const stored = await getPreference<unknown>(scopedKey);
  return isCreateClimbDraft(stored) ? stored : null;
}

export function saveDraft(boardKey: string, draft: CreateClimbDraft, owner?: UserStorageOwner | null): Promise<void> {
  const scopedKey = userScopedStorageKey(storageKey(boardKey), owner);
  return scopedKey ? setPreference(scopedKey, draft) : Promise.resolve();
}

export function clearDraft(boardKey: string, owner?: UserStorageOwner | null): Promise<void> {
  const scopedKey = userScopedStorageKey(storageKey(boardKey), owner);
  return scopedKey ? removePreference(scopedKey) : Promise.resolve();
}

/** Drops every create-climb draft owned by one authenticated browser session. */
export function clearAllCreateClimbDrafts(owner?: UserStorageOwner | null): Promise<void> {
  const ownerSuffix = userScopedStorageKey('', owner);
  if (!ownerSuffix) return Promise.resolve();
  return removePreferencesMatching((key) => key.startsWith(KEY_PREFIX) && key.endsWith(ownerSuffix));
}
