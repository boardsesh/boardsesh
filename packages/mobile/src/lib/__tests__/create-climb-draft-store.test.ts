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
