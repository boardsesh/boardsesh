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

import { createClimbDraftKey, loadDraft, saveDraft, type CreateClimbDraft } from '../create-climb-draft-store';

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
});

describe('MoonBoard draft metadata', () => {
  it('round-trips angle, grade, method, and benchmark state', async () => {
    const draft = {
      holdsJson: '{}',
      name: 'Project',
      description: 'Beta',
      isDraft: true,
      moonboard: {
        angle: 25 as const,
        userGrade: '7A',
        method: 'method_footless' as const,
        isBenchmark: true,
      },
    };

    await saveDraft('moonboard-valid', draft);

    await expect(loadDraft('moonboard-valid')).resolves.toEqual(draft);
  });

  it('loads an older draft when its optional MoonBoard metadata is invalid', async () => {
    const draftWithInvalidMetadata = {
      holdsJson: '{}',
      name: 'Older project',
      description: '',
      isDraft: true,
      moonboard: {
        angle: 30,
        userGrade: '6B',
        method: 'method_no_kickboard',
        isBenchmark: false,
      },
    } as unknown as CreateClimbDraft;
    await saveDraft('moonboard-invalid', draftWithInvalidMetadata);

    const stored = await loadDraft('moonboard-invalid');
    expect(stored).toMatchObject({ name: 'Older project', isDraft: true });
    expect(stored?.moonboard).toBeUndefined();
  });
});
