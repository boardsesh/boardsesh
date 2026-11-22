import { beforeEach, describe, it, expect, vi } from 'vitest';

// The module pulls in preference-store → AsyncStorage at import time; mock it so
// the suite loads under Vitest (the native module isn't resolvable here).
vi.mock('@react-native-async-storage/async-storage', () => {
  let storage: Record<string, string> = {};
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage[key] ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage[key] = value;
      }),
      removeItem: vi.fn(async (key: string) => {
        delete storage[key];
      }),
      getAllKeys: vi.fn(async () => Object.keys(storage)),
      removeMany: vi.fn(async (keys: string[]) => {
        keys.forEach((key) => delete storage[key]);
      }),
      __reset: () => {
        storage = {};
      },
    },
  };
});

import { createClimbDraftKey } from '../create-climb-draft-store';

beforeEach(async () => {
  const storage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
  };
  storage.__reset();
});

describe('createClimbDraftKey', () => {
  const base = { boardName: 'kilter', layoutId: 1, sizeId: 2, setIds: '10', angle: 40 };

  it('includes every board dimension in the key', () => {
    expect(createClimbDraftKey(base)).toBe('kilter:1:2:10:40');
  });

  it('distinguishes hold sets at the same layout/size/angle', () => {
    // Kilter/Tension share a layout/size/angle across "original" vs "commercial"
    // (bolt-on) sets. The key must differ so one set's draft never restores hold
    // IDs that don't exist in the other set.
    const original = createClimbDraftKey({ ...base, setIds: '10' });
    const commercial = createClimbDraftKey({ ...base, setIds: '11' });
    expect(original).not.toBe(commercial);
  });

  it('distinguishes board, layout, size, and angle', () => {
    expect(createClimbDraftKey({ ...base, boardName: 'tension' })).not.toBe(createClimbDraftKey(base));
    expect(createClimbDraftKey({ ...base, layoutId: 99 })).not.toBe(createClimbDraftKey(base));
    expect(createClimbDraftKey({ ...base, sizeId: 99 })).not.toBe(createClimbDraftKey(base));
    expect(createClimbDraftKey({ ...base, angle: 25 })).not.toBe(createClimbDraftKey(base));
  });

  it('clears every locally saved draft through the account cleanup boundary', async () => {
    const { clearAllCreateClimbDrafts, loadDraft, saveDraft } = await import('../create-climb-draft-store');
    const draft = { holdsJson: '{}', name: 'Project', description: '', isDraft: true };
    await saveDraft('first-board', draft);
    await saveDraft('second-board', { ...draft, name: 'Second project' });

    await clearAllCreateClimbDrafts({ userId: 'ignored-native-user', authSessionId: 'ignored-native-session' });

    await expect(loadDraft('first-board')).resolves.toBeNull();
    await expect(loadDraft('second-board')).resolves.toBeNull();
  });

  it('round-trips the edit and fork slots alongside the new-climb one', async () => {
    const { saveDraft, loadDraft, createClimbEditDraftKey, createClimbForkDraftKey } =
      await import('../create-climb-draft-store');
    const newClimbKey = createClimbDraftKey(base);
    const editKey = createClimbEditDraftKey('kilter', 'climb-9');
    const forkKey = createClimbForkDraftKey(newClimbKey);

    // Identity lives in the key, which is what lets all three autosave at once
    // without any of them clobbering another.
    expect(editKey).toBe('edit:kilter:climb-9');
    expect(forkKey).toBe(`fork:${newClimbKey}`);
    expect(new Set([newClimbKey, editKey, forkKey]).size).toBe(3);

    await saveDraft(newClimbKey, { holdsJson: '{}', name: 'New', description: '', isDraft: true });
    await saveDraft(editKey, { holdsJson: '{}', name: 'Edit', description: '', isDraft: true });
    await saveDraft(forkKey, { holdsJson: '{}', name: 'Fork', description: '', isDraft: true });

    await expect(loadDraft(newClimbKey)).resolves.toMatchObject({ name: 'New' });
    await expect(loadDraft(editKey)).resolves.toMatchObject({ name: 'Edit' });
    await expect(loadDraft(forkKey)).resolves.toMatchObject({ name: 'Fork' });
  });

  it('sweeps all three key shapes on account cleanup', async () => {
    const { saveDraft, loadDraft, clearAllCreateClimbDrafts, createClimbEditDraftKey, createClimbForkDraftKey } =
      await import('../create-climb-draft-store');
    const keys = [
      createClimbDraftKey(base),
      createClimbEditDraftKey('kilter', 'climb-9'),
      createClimbForkDraftKey('k'),
    ];
    for (const key of keys) {
      await saveDraft(key, { holdsJson: '{}', name: key, description: '', isDraft: true });
    }

    await clearAllCreateClimbDrafts();

    for (const key of keys) {
      await expect(loadDraft(key)).resolves.toBeNull();
    }
  });

  it('still loads a payload stored in the original four-field shape', async () => {
    // The no-migration guarantee: every field added since is optional, and the
    // new-climb key string never changed, so drafts already on devices restore.
    const { saveDraft, loadDraft } = await import('../create-climb-draft-store');
    const key = createClimbDraftKey(base);
    await saveDraft(key, { holdsJson: '{"1":{"state":"HAND"}}', name: 'Legacy', description: '', isDraft: true });

    await expect(loadDraft(key)).resolves.toEqual({
      holdsJson: '{"1":{"state":"HAND"}}',
      name: 'Legacy',
      description: '',
      isDraft: true,
    });
  });

  it('always reports storage as available on native', async () => {
    const { isDraftStorageAvailable } = await import('../create-climb-draft-store');
    expect(isDraftStorageAvailable()).toBe(true);
    expect(isDraftStorageAvailable(null)).toBe(true);
  });
});

describe('spray authoring draft migration', () => {
  const config = { boardName: 'spray', layoutId: 7957, sizeId: 7957, setIds: '1', angle: 40 };
  const draft = { holdsJson: '{}', name: 'Recovered project', description: '', isDraft: true };
  async function registerWall(versionId: number, wallUuid = 'recovery-wall'): Promise<void> {
    const { registerSprayWall } = await import('../spray/spray-wall-registry');
    registerSprayWall(config.layoutId, {
      wallUuid,
      angle: 40,
      version: versionId,
      versionId,
      photoWidth: 1200,
      photoHeight: 1600,
      photoUrl: 'https://example.com/photo',
      photoThumbUrl: null,
      photoExpiresAt: '2099-01-01T00:00:00.000Z',
      holds: [],
    });
  }

  it('migrates a legacy version slot before maintenance and keeps its backup', async () => {
    const { loadDraft, saveDraft } = await import('../create-climb-draft-store');
    await registerWall(10);
    const legacyKey = 'spray:7957:7957-svid10:1:40';
    await saveDraft(legacyKey, draft);
    const stableKey = createClimbDraftKey(config);
    await expect(loadDraft(stableKey)).resolves.toEqual(draft);
    await expect(loadDraft(legacyKey)).resolves.toEqual(draft);
    await registerWall(11);
    expect(createClimbDraftKey(config)).toBe(stableKey);
    await expect(loadDraft(stableKey)).resolves.toEqual(draft);
  });

  it('restores the legacy copy even if the destination write fails', async () => {
    const { loadDraft, saveDraft } = await import('../create-climb-draft-store');
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    await registerWall(20);
    const legacyKey = 'spray:7957:7957-svid20:1:40';
    await saveDraft(legacyKey, draft);
    const stableKey = createClimbDraftKey(config);
    vi.spyOn(storage, 'setItem').mockRejectedValueOnce(new Error('storage full'));
    // Returning recovered content keeps the controller out of its empty-editor
    // clear path even when the write-first migration cannot finish yet.
    await expect(loadDraft(stableKey)).resolves.toEqual(draft);
    await expect(storage.getItem(`boardsesh_create_climb_draft:${stableKey}`)).resolves.toBeNull();
    await expect(loadDraft(legacyKey)).resolves.toEqual(draft);
    await expect(loadDraft(stableKey)).resolves.toEqual(draft);
  });

  it('does not restore another wall and deliberate clear cannot resurrect the migrated slot', async () => {
    const { loadDraft, saveDraft, clearDraft } = await import('../create-climb-draft-store');
    await registerWall(30);
    const legacyKey = 'spray:7957:7957-svid30:1:40';
    await saveDraft(legacyKey, draft);
    const stableKey = createClimbDraftKey(config);
    await expect(loadDraft(stableKey)).resolves.toEqual(draft);
    await clearDraft(stableKey);
    await expect(loadDraft(stableKey)).resolves.toBeNull();
    await saveDraft(stableKey, draft);
    await registerWall(31, 'other-wall');
    expect(createClimbDraftKey(config)).not.toBe(stableKey);
    await expect(loadDraft(createClimbDraftKey(config))).resolves.toBeNull();
  });
});
