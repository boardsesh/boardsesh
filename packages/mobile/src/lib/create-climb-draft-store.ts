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

/** Which authoring mode wrote this slot. Diagnostic only — the key decides. */
export type CreateClimbDraftOrigin = 'new' | 'edit' | 'fork';

export type CreateClimbDraft = {
  /**
   * JSON.stringify of the editor's active-frame LitUpHoldsMap. Kept for
   * backward compatibility — `framesJson` below is the full route and takes
   * priority when present.
   */
  holdsJson: string;
  /** JSON.stringify(LitUpHoldsMap[]) — the full frame sequence. */
  framesJson?: string;
  name: string;
  description: string;
  /**
   * "No matching" toggle. Explicit since the rule stopped being inferable from
   * the description on every board: the leading `No match` line is an Aurora wire
   * convention, and on the code-driven boards a description that starts with
   * those words is just prose. Optional so a slot written before this field
   * still restores — from the description sniff, which is all it ever had.
   */
  noMatch?: boolean;
  isDraft: boolean;
  /** "No kickboard" toggle — feet allowed, kickboard off-limits. Optional so old
   *  persisted drafts without it still pass the type guard and default to false. */
  noKickboard?: boolean;
  /** "Campus" toggle — no feet at all. Optional for the same back-compat reason. */
  campus?: boolean;
  /** "Any feet" toggle — feet may use any hold, not only the marked ones. The
   *  opposite of `campus`, and mutually exclusive with it. Optional for the same
   *  back-compat reason: a slot written before this rule existed restores with the
   *  board's default (feet on the marked holds). */
  anyFeet?: boolean;
  /**
   * JSON.stringify of the `SavedClimbSnapshot` this working copy is attached to,
   * once it has been saved to the server at least once. Restoring it re-links a
   * cold-started session to its row, so the next Save UPDATES that climb instead
   * of creating a duplicate. Absent for a never-saved WIP.
   */
  savedClimbJson?: string;
  /**
   * Payload signature at the last successful server save. Restoring it lets the
   * editor distinguish the account copy from newer phone-only edits.
   */
  savedPayloadSignature?: string;
  /** Which authoring mode wrote this payload. Diagnostic; not read on restore. */
  origin?: CreateClimbDraftOrigin;
  /** Wall-clock of the last content change. Diagnostic; not rendered (no `updated_at` on Climb to be honest against). */
  updatedAtMs?: number;
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

/**
 * Slot for editing one existing climb. Identity is in the KEY, so an edit
 * session can autosave without ever colliding with the board-config-keyed
 * new-climb slot — which is what forced autosave off in edit mode before.
 * Deterministic, so reopening the same climb finds it with no stored pointer.
 */
export function createClimbEditDraftKey(boardType: string, uuid: string): string {
  return `edit:${boardType}:${uuid}`;
}

/**
 * Slot for a remix/fork session, one per board config. Separate from the
 * new-climb slot so opening a fork can't clobber a real new-climb WIP, and
 * restorable from a plain creator mount after the app is killed.
 */
export function createClimbForkDraftKey(boardKey: string): string {
  return `fork:${boardKey}`;
}

/**
 * Whether this platform can actually persist a draft right now. Always true on
 * native; the browser fork returns false for a signed-out visitor, whose writes
 * are silently dropped. The status line reads this so it never claims a draft is
 * "saved on this phone" when nothing was written.
 */
export function isDraftStorageAvailable(_owner?: UserStorageOwner | null): boolean {
  return true;
}

function storageKey(boardKey: string): string {
  return `${KEY_PREFIX}${boardKey}`;
}

// Requires only the four fields the ORIGINAL payload shape carried, so every
// draft already sitting on a device keeps validating and restoring. Every field
// added since is optional — do not tighten this without a migration.
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
export async function loadDraft(boardKey: string, _owner?: UserStorageOwner | null): Promise<CreateClimbDraft | null> {
  const stored = await getPreference<unknown>(storageKey(boardKey));
  return isCreateClimbDraft(stored) ? stored : null;
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
