import { beforeEach, describe, expect, it, vi } from 'vitest';

const userASessionOne = { userId: 'user-a', authSessionId: 'session-a1' };
const userASessionTwo = { userId: 'user-a', authSessionId: 'session-a2' };
const userBSession = { userId: 'user-b', authSessionId: 'session-b1' };

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

async function resetStorage(): Promise<void> {
  const storage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
  };
  storage.__reset();
}

describe('browser user-scoped draft stores', () => {
  beforeEach(async () => {
    vi.resetModules();
    await resetStorage();
  });

  it('does not expose user A queue snapshot to user B', async () => {
    const { setStoredQueueSnapshot, getStoredQueueSnapshot } = await import('../queue-snapshot-store.web');
    const { setCurrentUserStorageOwner } = await import('../user-storage-owner.web');
    setCurrentUserStorageOwner(userASessionOne);
    await setStoredQueueSnapshot({
      queue: [],
      currentClimbQueueItem: null,
      playlistSuggestionSource: null,
    });

    setCurrentUserStorageOwner(userASessionTwo);
    await expect(getStoredQueueSnapshot()).resolves.toBeNull();
    setCurrentUserStorageOwner(userBSession);
    await expect(getStoredQueueSnapshot()).resolves.toBeNull();
    setCurrentUserStorageOwner(userASessionOne);
    await expect(getStoredQueueSnapshot()).resolves.toMatchObject({ queue: [] });
  });

  it('does not expose user A create-climb draft to user B on the same board', async () => {
    const { saveDraft, loadDraft } = await import('../create-climb-draft-store.web');
    const { setCurrentUserStorageOwner } = await import('../user-storage-owner.web');
    const boardKey = 'kilter:1:2:10:40';
    const draft = { holdsJson: '{}', name: 'A project', description: '', isDraft: true };
    setCurrentUserStorageOwner(userASessionOne);
    await saveDraft(boardKey, draft);

    setCurrentUserStorageOwner(userASessionTwo);
    await expect(loadDraft(boardKey)).resolves.toBeNull();
    setCurrentUserStorageOwner(userBSession);
    await expect(loadDraft(boardKey)).resolves.toBeNull();
    setCurrentUserStorageOwner(userASessionOne);
    await expect(loadDraft(boardKey)).resolves.toEqual(draft);
  });

  it('reports storage as unavailable with no signed-in owner, and writes nothing', async () => {
    // Every browser write is account-scoped, so a signed-out visitor stores
    // nothing at all. The status line reads this so it can say "Sign in to keep
    // this draft" instead of promising a draft that was never written.
    const { isDraftStorageAvailable, saveDraft, loadDraft } = await import('../create-climb-draft-store.web');
    const { setCurrentUserStorageOwner } = await import('../user-storage-owner.web');

    setCurrentUserStorageOwner(null);
    expect(isDraftStorageAvailable()).toBe(false);
    await saveDraft('kilter:1:2:10:40', { holdsJson: '{}', name: 'Anonymous', description: '', isDraft: true });
    await expect(loadDraft('kilter:1:2:10:40')).resolves.toBeNull();

    setCurrentUserStorageOwner(userASessionOne);
    expect(isDraftStorageAvailable()).toBe(true);
    // ...and the signed-out attempt left nothing behind for the account either.
    await expect(loadDraft('kilter:1:2:10:40')).resolves.toBeNull();
  });

  it('does not expose user A recap draft to user B for the same session', async () => {
    const { setDraftComment, getDraftComment } = await import('../session-comment-draft-store.web');
    const { setCurrentUserStorageOwner } = await import('../user-storage-owner.web');
    setCurrentUserStorageOwner(userASessionOne);
    await setDraftComment('session-1', 'A private recap');

    setCurrentUserStorageOwner(userASessionTwo);
    await expect(getDraftComment('session-1')).resolves.toBeNull();
    setCurrentUserStorageOwner(userBSession);
    await expect(getDraftComment('session-1')).resolves.toBeNull();
    setCurrentUserStorageOwner(userASessionOne);
    await expect(getDraftComment('session-1')).resolves.toBe('A private recap');
  });

  it('clears all create-climb drafts for only the supplied owner', async () => {
    const { clearAllCreateClimbDrafts, loadDraft, saveDraft } = await import('../create-climb-draft-store.web');
    const firstDraft = { holdsJson: '{}', name: 'A project', description: '', isDraft: true };
    const secondDraft = { ...firstDraft, name: 'A second project' };
    const otherUserDraft = { ...firstDraft, name: 'B project' };
    await saveDraft('first-board', firstDraft, userASessionOne);
    await saveDraft('second-board', secondDraft, userASessionOne);
    await saveDraft('first-board', otherUserDraft, userBSession);

    await clearAllCreateClimbDrafts(userASessionOne);

    await expect(loadDraft('first-board', userASessionOne)).resolves.toBeNull();
    await expect(loadDraft('second-board', userASessionOne)).resolves.toBeNull();
    await expect(loadDraft('first-board', userBSession)).resolves.toEqual(otherUserDraft);
  });

  it('clears the recap draft for only the supplied owner', async () => {
    const { clearSessionCommentDraft, getDraftComment, setDraftComment } =
      await import('../session-comment-draft-store.web');
    await setDraftComment('session-1', 'A private recap', userASessionOne);
    await setDraftComment('session-1', 'B private recap', userBSession);

    await clearSessionCommentDraft(userASessionOne);

    await expect(getDraftComment('session-1', userASessionOne)).resolves.toBeNull();
    await expect(getDraftComment('session-1', userBSession)).resolves.toBe('B private recap');
  });
});
