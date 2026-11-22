import { getPreference, removePreference, removePreferencesMatching, setPreference } from './preference-store';
import type { UserStorageOwner } from './user-storage-owner';
import { getCurrentUserStorageOwner, userScopedStorageKey } from './user-storage-owner.web';
import { sprayAuthoringToken, sprayIdentityToken } from './spray/spray-wall-registry';

/** Which authoring mode wrote this slot. Diagnostic only — the key decides. */
export type CreateClimbDraftOrigin = 'new' | 'edit' | 'fork';

// Mirrors the native shape field for field. `framesJson` round-tripped here all
// along (the validator ignores unknown keys) but was missing from the type.
export type CreateClimbDraft = {
  pendingClimbUuid?: string;
  /** JSON.stringify of the editor's active-frame LitUpHoldsMap. */
  holdsJson: string;
  /** JSON.stringify(LitUpHoldsMap[]) — the full frame sequence. */
  framesJson?: string;
  name: string;
  description: string;
  /** "No matching" toggle. Optional for drafts created before this field. */
  noMatch?: boolean;
  isDraft: boolean;
  /** "No kickboard" toggle. Optional for drafts created before this field. */
  noKickboard?: boolean;
  /** "Campus" toggle. Optional for drafts created before this field. */
  campus?: boolean;
  /** "Any feet" toggle. Optional for drafts created before this field. */
  anyFeet?: boolean;
  /** Route mode. See the native fork for why inferring it from frame count isn't enough. */
  routeMode?: boolean;
  /** Authored per-frame pace in ms — the published climb's `frames_pace`. See the native fork. */
  framesPaceMs?: number;
  /** JSON.stringify of the attached `SavedClimbSnapshot`. See the native fork. */
  savedClimbJson?: string;
  /** Payload signature at the last successful server save. See the native fork. */
  savedPayloadSignature?: string;
  origin?: CreateClimbDraftOrigin;
  updatedAtMs?: number;
};

const KEY_PREFIX = 'boardsesh_create_climb_draft:';
// Only aliases for the currently authorized wall/version are eligible to migrate.
const legacyDraftKeys = new Map<string, string>();

export function createClimbDraftKey(config: {
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
}): string {
  const spray = sprayAuthoringToken(config.boardName, config.layoutId);
  const boardKey = `${config.boardName}:${config.layoutId}:${config.sizeId}${spray}:${config.setIds}:${config.angle}`;
  if (config.boardName === 'spray' && spray !== '-sw0') {
    const legacyToken = sprayIdentityToken(config.boardName, config.layoutId);
    legacyDraftKeys.set(
      boardKey,
      `${config.boardName}:${config.layoutId}:${config.sizeId}${legacyToken}:${config.setIds}:${config.angle}`,
    );
  }
  return boardKey;
}

/** See the native fork. */
export function clearSupersededSprayDrafts(_layoutId: number, _currentVersionToken: string): Promise<void> {
  return Promise.resolve();
}

/** See the native fork — one deterministic slot per authoring mode. */
export function createClimbEditDraftKey(boardType: string, uuid: string): string {
  return `edit:${boardType}:${uuid}`;
}

export function createClimbForkDraftKey(boardKey: string): string {
  const forkKey = `fork:${boardKey}`;
  const legacyKey = legacyDraftKeys.get(boardKey);
  if (legacyKey) legacyDraftKeys.set(forkKey, `fork:${legacyKey}`);
  return forkKey;
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
  const capturedOwner = owner === undefined ? getCurrentUserStorageOwner() : owner;
  const scopedKey = userScopedStorageKey(storageKey(boardKey), capturedOwner);
  const legacyKey = legacyDraftKeys.get(boardKey);
  if (!scopedKey) return null;
  const stored = await getPreference<unknown>(scopedKey);
  if (isCreateClimbDraft(stored)) return stored;
  const scopedLegacyKey = legacyKey ? userScopedStorageKey(storageKey(legacyKey), capturedOwner) : null;
  if (!scopedLegacyKey) return null;
  const legacyDraft = await getPreference<unknown>(scopedLegacyKey);
  if (!isCreateClimbDraft(legacyDraft)) return null;
  try {
    await setPreference(scopedKey, legacyDraft);
  } catch {
    // The legacy copy is already durable. Restore it even if migration cannot
    // write yet, so the creator never treats a recovered editor as empty.
  }
  return legacyDraft;
}

export function saveDraft(boardKey: string, draft: CreateClimbDraft, owner?: UserStorageOwner | null): Promise<void> {
  const scopedKey = userScopedStorageKey(storageKey(boardKey), owner);
  return scopedKey ? setPreference(scopedKey, draft) : Promise.resolve();
}

export async function clearDraft(boardKey: string, owner?: UserStorageOwner | null): Promise<void> {
  const capturedOwner = owner === undefined ? getCurrentUserStorageOwner() : owner;
  const scopedKey = userScopedStorageKey(storageKey(boardKey), capturedOwner);
  if (!scopedKey) return;
  const legacyKey = legacyDraftKeys.get(boardKey);
  await removePreference(scopedKey);
  const scopedLegacyKey = legacyKey ? userScopedStorageKey(storageKey(legacyKey), capturedOwner) : null;
  if (scopedLegacyKey) await removePreference(scopedLegacyKey);
}

/** Drops every create-climb draft owned by one authenticated browser session. */
export function clearAllCreateClimbDrafts(owner?: UserStorageOwner | null): Promise<void> {
  const ownerSuffix = userScopedStorageKey('', owner);
  if (!ownerSuffix) return Promise.resolve();
  return removePreferencesMatching((key) => key.startsWith(KEY_PREFIX) && key.endsWith(ownerSuffix));
}
