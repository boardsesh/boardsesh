import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SprayEditorPresent } from '../../../components/outline-editor/spray-hold-editor-reducer';
const preferences = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../preference-store', () => ({
  getPreference: async (key: string) => preferences.get(key) ?? null,
  setPreference: async (key: string, stored: unknown) => {
    preferences.set(key, stored);
  },
  removePreference: async (key: string) => {
    preferences.delete(key);
  },
}));
import {
  clearSprayHoldDraft,
  loadSprayHoldDraft,
  saveSprayHoldDraft,
  sprayHoldDraftKey,
  type SprayHoldEditorDraft,
} from '../spray-hold-draft-store';
const identity = { userId: 'setter', wallUuid: 'wall', versionId: '17' };
const present: SprayEditorPresent = {
  holds: {
    [-1]: {
      id: -1,
      cx: 22,
      cy: 33,
      r: 9,
      outline: null,
      source: 'AUTO',
      confidence: 0.8,
      review: 'rejected',
      dirty: true,
      origin: { detectionId: 'scan-3', candidateIndex: 7 },
      autoReview: 'CONFIRMED',
    },
  },
  removedIds: [56],
  selectedId: -1,
  nextLocalId: -2,
};
const draft: SprayHoldEditorDraft = { ...identity, schemaVersion: 1, baseline: 'geometry', present };
beforeEach(() => preferences.clear());

describe('account-scoped hold recovery records', () => {
  it('round trips removals, local identity, rejected finds and detector provenance', async () => {
    await saveSprayHoldDraft(draft);
    expect(await loadSprayHoldDraft(identity)).toEqual(draft);
  });
  it('keeps a full wall plus switched-off holds without treating recovery as a publish', async () => {
    const holds: SprayEditorPresent['holds'] = Object.fromEntries(
      Array.from({ length: 1500 }, (_, index) => {
        const holdId = index + 1;
        return [holdId, { ...present.holds[-1], id: holdId, review: 'accepted', dirty: false }];
      }),
    );
    const recoveryWithGhost = {
      ...draft,
      present: {
        ...present,
        holds: { ...holds, 1: { ...holds[1], review: 'rejected' as const, dirty: true }, [-1]: present.holds[-1] },
        removedIds: [1],
      },
    };
    await saveSprayHoldDraft(recoveryWithGhost);
    expect(await loadSprayHoldDraft(identity)).toEqual(recoveryWithGhost);
  });

  it('isolates accounts, walls and immutable version ids', async () => {
    await saveSprayHoldDraft(draft);
    expect(await loadSprayHoldDraft({ ...identity, userId: 'another-setter' })).toBeNull();
    expect(await loadSprayHoldDraft({ ...identity, wallUuid: 'another-wall' })).toBeNull();
    expect(await loadSprayHoldDraft({ ...identity, versionId: '18' })).toBeNull();
  });
  it('does not erase a malformed record or report it as missing', async () => {
    preferences.set(sprayHoldDraftKey(identity), { ...draft, present: { ...present, nextLocalId: 0 } });
    await expect(loadSprayHoldDraft(identity)).rejects.toThrow('Invalid hold recovery');
    expect(preferences.has(sprayHoldDraftKey(identity))).toBe(true);
  });
  it('rejects a mismatched owner payload under a valid key', async () => {
    preferences.set(sprayHoldDraftKey(identity), { ...draft, userId: 'other-user' });
    await expect(loadSprayHoldDraft(identity)).rejects.toThrow();
  });
  it('clears only the requested account and exact draft', async () => {
    await saveSprayHoldDraft(draft);
    const sibling = { ...draft, versionId: '18' };
    await saveSprayHoldDraft(sibling);
    await clearSprayHoldDraft(identity);
    expect(await loadSprayHoldDraft(identity)).toBeNull();
    expect(await loadSprayHoldDraft(sibling)).toEqual(sibling);
  });
  it('refuses to claim invalid geometry was saved', async () => {
    const invalid = { ...draft, present: { ...present, holds: { [-1]: { ...present.holds[-1], r: Number.NaN } } } };
    await expect(saveSprayHoldDraft(invalid)).rejects.toThrow();
    expect(preferences.size).toBe(0);
  });
});
