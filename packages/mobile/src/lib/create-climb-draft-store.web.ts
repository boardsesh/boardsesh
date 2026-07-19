import { getPreference, removePreference, removePreferencesMatching, setPreference } from './preference-store';
import type { UserStorageOwner } from './user-storage-owner';
import { userScopedStorageKey } from './user-storage-owner.web';

export type CreateClimbDraft = {
  /** JSON.stringify of the editor's LitUpHoldsMap. */
  holdsJson: string;
  name: string;
  description: string;
  isDraft: boolean;
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
