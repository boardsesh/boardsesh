import { MAX_HOLDS_PER_WALL } from '@boardsesh/board-config';
import { getPreference, removePreference, setPreference } from '../preference-store';
import type { SprayEditorPresent } from '../../components/outline-editor/spray-hold-editor-reducer';

export class SprayHoldDraftRecoveryError extends Error {
  readonly code = 'INVALID_SPRAY_HOLD_RECOVERY';
}

export type SprayHoldDraftIdentity = { userId: string; wallUuid: string; versionId: string };
export type SprayHoldEditorDraft = SprayHoldDraftIdentity & {
  schemaVersion: 1;
  baseline: string;
  present: SprayEditorPresent;
};

export function sprayHoldDraftKey(identity: SprayHoldDraftIdentity): string {
  return `boardsesh_spray_hold_draft:v1:${encodeURIComponent(identity.userId)}:${encodeURIComponent(identity.wallUuid)}:${encodeURIComponent(identity.versionId)}`;
}

function isFiniteNumber(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isFinite(candidate);
}

export function isSprayHoldEditorDraft(candidate: unknown): candidate is SprayHoldEditorDraft {
  if (!candidate || typeof candidate !== 'object') return false;
  const draft = candidate as Partial<SprayHoldEditorDraft>;
  if (
    draft.schemaVersion !== 1 ||
    typeof draft.userId !== 'string' ||
    typeof draft.wallUuid !== 'string' ||
    typeof draft.versionId !== 'string' ||
    typeof draft.baseline !== 'string'
  )
    return false;
  const present = draft.present;
  if (
    !present ||
    !present.holds ||
    typeof present.holds !== 'object' ||
    Array.isArray(present.holds) ||
    !Array.isArray(present.removedIds) ||
    present.removedIds.length > MAX_HOLDS_PER_WALL ||
    !present.removedIds.every((holdId) => Number.isSafeInteger(holdId) && holdId > 0) ||
    !Number.isSafeInteger(present.nextLocalId) ||
    present.nextLocalId >= 0 ||
    (present.selectedId !== null && !Number.isSafeInteger(present.selectedId))
  )
    return false;
  const holds = Object.values(present.holds);
  if (present.selectedId !== null && present.holds[present.selectedId] === undefined) return false;
  if (holds.some((hold) => hold && hold.id < 0 && present.nextLocalId >= hold.id)) return false;
  return holds.every(
    (hold) =>
      hold &&
      Number.isSafeInteger(hold.id) &&
      present.holds[hold.id] === hold &&
      hold.id !== 0 &&
      isFiniteNumber(hold.cx) &&
      isFiniteNumber(hold.cy) &&
      isFiniteNumber(hold.r) &&
      hold.r > 0 &&
      typeof hold.dirty === 'boolean' &&
      (hold.source === 'MANUAL' || hold.source === 'AUTO') &&
      ['accepted', 'rejected', 'pending'].includes(hold.review) &&
      (hold.outline == null || (Array.isArray(hold.outline) && hold.outline.every(isFiniteNumber))),
  );
}

export async function loadSprayHoldDraft(identity: SprayHoldDraftIdentity): Promise<SprayHoldEditorDraft | null> {
  let draft: unknown;
  try {
    draft = await getPreference<unknown>(sprayHoldDraftKey(identity), { strictParsing: true });
  } catch (error) {
    if (error instanceof SyntaxError) throw new SprayHoldDraftRecoveryError('Invalid hold recovery record');
    throw error;
  }
  if (draft === null) return null;
  if (
    !isSprayHoldEditorDraft(draft) ||
    draft.userId !== identity.userId ||
    draft.wallUuid !== identity.wallUuid ||
    draft.versionId !== identity.versionId
  )
    throw new SprayHoldDraftRecoveryError('Invalid hold recovery record');
  return draft;
}

export function saveSprayHoldDraft(draft: SprayHoldEditorDraft): Promise<void> {
  if (!isSprayHoldEditorDraft(draft)) return Promise.reject(new Error('Invalid hold recovery record'));
  return setPreference(sprayHoldDraftKey(draft), draft);
}

export function clearSprayHoldDraft(identity: SprayHoldDraftIdentity): Promise<void> {
  return removePreference(sprayHoldDraftKey(identity));
}

/** Only our acknowledged removals advance this baseline; unrelated server changes still conflict. */
export function baselineAfterSprayHoldRemovals(baseline: string, removedIds: readonly number[]): string {
  const parsed: unknown = JSON.parse(baseline);
  if (!parsed || typeof parsed !== 'object' || !('holds' in parsed) || !Array.isArray(parsed.holds)) {
    throw new Error('Invalid server hold baseline');
  }
  const removed = new Set(removedIds);
  return JSON.stringify({
    ...parsed,
    holds: parsed.holds.filter(
      (hold: unknown) =>
        !(hold && typeof hold === 'object' && 'id' in hold && typeof hold.id === 'number' && removed.has(hold.id)),
    ),
  });
}
