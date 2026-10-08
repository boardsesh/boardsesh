import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';

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
      __reset: () => {
        storage = {};
      },
      __rawSet: (key: string, value: string) => {
        storage[key] = value;
      },
      __keys: () => Object.keys(storage),
    },
  };
});

function makeQueueItem(uuid: string): ClimbQueueItem {
  return {
    uuid,
    climb: { uuid: `climb-${uuid}`, name: `Climb ${uuid}`, angle: 40 },
  } as unknown as ClimbQueueItem;
}

function makeSuggestionSource(climbCount: number, activatedIndex: number): PlaylistSuggestionSource {
  const climbs = Array.from(
    { length: climbCount },
    (_, index) => ({ uuid: `climb-${index}`, name: `Climb ${index}` }) as PlaylistSuggestionSource['climbs'][number],
  );
  return {
    playlistUuid: 'playlist-1',
    activatedClimbUuid: `climb-${activatedIndex}`,
    boardKey: 'kilter:1:10:1,2',
    climbs,
  };
}

async function getStorageMock() {
  return (await import('@react-native-async-storage/async-storage')).default as unknown as {
    __reset: () => void;
    __rawSet: (key: string, value: string) => void;
    __keys: () => string[];
  };
}

describe('queue-snapshot-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await getStorageMock()).__reset();
  });

  it('keeps queue order and current selection without copied content or suggestions', async () => {
    const { getStoredQueueSnapshot, setStoredQueueSnapshot } = await import('../queue-snapshot-store');
    const queue = [makeQueueItem('a'), makeQueueItem('b')];
    const source = makeSuggestionSource(3, 1);
    await setStoredQueueSnapshot({ queue, currentClimbQueueItem: queue[0], playlistSuggestionSource: source });

    const stored = await getStoredQueueSnapshot();
    expect(stored?.queue.map((item) => item.uuid)).toEqual(['a', 'b']);
    expect(stored?.queue.map((item) => item.climb.uuid)).toEqual(['climb-a', 'climb-b']);
    expect(stored?.queue.every((item) => item.climb.name === '' && item.climb.frames === '')).toBe(true);
    expect(stored?.currentClimbQueueItem?.uuid).toBe('a');
    expect(stored?.playlistSuggestionSource).toBeNull();
    expect(typeof stored?.savedAt).toBe('string');
  });

  it('returns null when nothing is stored', async () => {
    const { getStoredQueueSnapshot } = await import('../queue-snapshot-store');
    await expect(getStoredQueueSnapshot()).resolves.toBeNull();
  });

  it('clears the stored snapshot', async () => {
    const { getStoredQueueSnapshot, setStoredQueueSnapshot, clearStoredQueueSnapshot } =
      await import('../queue-snapshot-store');
    await setStoredQueueSnapshot({
      queue: [makeQueueItem('a')],
      currentClimbQueueItem: null,
      playlistSuggestionSource: null,
    });
    await clearStoredQueueSnapshot();
    await expect(getStoredQueueSnapshot()).resolves.toBeNull();
  });

  it('returns null for a corrupt stored payload instead of throwing', async () => {
    const { getStoredQueueSnapshot } = await import('../queue-snapshot-store');
    const storageMock = await getStorageMock();
    // The store owns its key internally; write garbage under whatever key the
    // round-trip uses by setting it for every key written so far plus the
    // known constant.
    storageMock.__rawSet('boardsesh_local_queue_snapshot_v1', '{not json');
    await expect(getStoredQueueSnapshot()).resolves.toBeNull();
  });

  it('never writes copied climb details or attribution to storage', async () => {
    const { setStoredQueueSnapshot } = await import('../queue-snapshot-store');
    const item = {
      ...makeQueueItem('private'),
      addedBy: 'private-user',
      addedByUser: { id: 'private-user', username: 'Secret climber' },
      tickedBy: ['private-user'],
      climb: { ...makeQueueItem('private').climb, frames: 'secret-frames', description: 'Secret notes' },
    };
    await setStoredQueueSnapshot({
      queue: [item],
      currentClimbQueueItem: item,
      playlistSuggestionSource: makeSuggestionSource(500, 250),
    });
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    const serialized = vi.mocked(storage.setItem).mock.calls.at(-1)?.[1] ?? '';
    expect(serialized).not.toContain('Secret');
    expect(serialized).not.toContain('secret-frames');
    expect(serialized).not.toContain('private-user');
    expect(serialized).not.toContain('playlist-1');
    expect(JSON.parse(serialized).queue[0].uuid).toBe('private');
  });

  it('sanitizes legacy snapshots and preserves current-only, mirror and routing references', async () => {
    const { getStoredQueueSnapshot } = await import('../queue-snapshot-store');
    const current = {
      ...makeQueueItem('current'),
      climb: { ...makeQueueItem('current').climb, mirrored: true, boardType: 'spray', layoutId: 42 },
    };
    (await getStorageMock()).__rawSet(
      'boardsesh_local_queue_snapshot_v1',
      JSON.stringify({
        queue: [makeQueueItem('a')],
        currentClimbQueueItem: current,
        playlistSuggestionSource: makeSuggestionSource(3, 1),
        savedAt: 'legacy',
      }),
    );
    const snapshot = await getStoredQueueSnapshot({ userId: 'new-owner', authSessionId: '' });
    expect(snapshot?.queue.map((item) => item.uuid)).toEqual(['a']);
    expect(snapshot?.currentClimbQueueItem).toMatchObject({
      uuid: 'current',
      climb: {
        uuid: 'climb-current',
        name: '',
        frames: '',
        mirrored: true,
        boardType: 'spray',
        layoutId: 42,
        angle: 40,
      },
    });
    expect(snapshot?.playlistSuggestionSource).toBeNull();
  });

  it('keeps a thin or missing legacy climb as an unresolved queue slot', async () => {
    const { getStoredQueueSnapshot } = await import('../queue-snapshot-store');
    (await getStorageMock()).__rawSet(
      'boardsesh_local_queue_snapshot_v1',
      JSON.stringify({
        queue: [
          { uuid: 'missing', climb: null },
          { uuid: 'thin', climb: { uuid: 'climb-thin' } },
        ],
        currentClimbQueueItem: { uuid: 'current-only' },
        playlistSuggestionSource: null,
        savedAt: 'legacy',
      }),
    );
    const snapshot = await getStoredQueueSnapshot();
    expect(snapshot?.queue.map((item) => item.uuid)).toEqual(['missing', 'thin']);
    expect(snapshot?.queue.map((item) => item.climb.uuid)).toEqual(['', 'climb-thin']);
    expect(snapshot?.currentClimbQueueItem).toMatchObject({
      uuid: 'current-only',
      climb: { uuid: '', name: '', frames: '' },
    });
  });

  it('restores a stamped native snapshot only to its owner', async () => {
    const store = await import('../queue-snapshot-store');
    const owner = { userId: 'a', authSessionId: '' };
    await store.setStoredQueueSnapshot(
      { queue: [makeQueueItem('a')], currentClimbQueueItem: null, playlistSuggestionSource: null },
      owner,
    );
    expect((await store.getStoredQueueSnapshot(owner))?.queue[0].uuid).toBe('a');
    expect(await store.getStoredQueueSnapshot({ userId: 'b', authSessionId: '' })).toBeNull();
    expect(await store.getStoredQueueSnapshot(null)).toBeNull();
  });

  it('adopts sanitized anonymous references without exposing legacy content', async () => {
    const store = await import('../queue-snapshot-store');
    await store.setStoredQueueSnapshot({
      queue: [makeQueueItem('a')],
      currentClimbQueueItem: null,
      playlistSuggestionSource: null,
    });
    const owner = { userId: 'a', authSessionId: '' };
    const snapshot = await store.getStoredQueueSnapshot(owner);
    expect(snapshot?.queue[0].climb.name).toBe('');
    await store.setStoredQueueSnapshot(snapshot!, owner);
    expect(await store.getStoredQueueSnapshot({ userId: 'b', authSessionId: '' })).toBeNull();
  });
});

describe('queue snapshot removal ordering', () => {
  beforeEach(async () => {
    vi.resetModules();
    (await getStorageMock()).__reset();
  });

  it('rejects a save whose debounce was scheduled before removal', async () => {
    const { getStoredQueueSnapshot, setStoredQueueSnapshot, clearStoredQueueSnapshot, getQueueSnapshotGeneration } =
      await import('../queue-snapshot-store');
    const oldGeneration = getQueueSnapshotGeneration();
    await clearStoredQueueSnapshot();
    await setStoredQueueSnapshot(
      { queue: [makeQueueItem('deleted')], currentClimbQueueItem: null, playlistSuggestionSource: null },
      undefined,
      oldGeneration,
    );
    expect(await getStoredQueueSnapshot()).toBeNull();
    await setStoredQueueSnapshot({
      queue: [makeQueueItem('new')],
      currentClimbQueueItem: null,
      playlistSuggestionSource: null,
    });
    expect((await getStoredQueueSnapshot())?.queue[0].uuid).toBe('new');
  });

  it('waits for an in-flight save before deleting its snapshot', async () => {
    const { getStoredQueueSnapshot, setStoredQueueSnapshot, clearStoredQueueSnapshot } =
      await import('../queue-snapshot-store');
    const storage = (await import('@react-native-async-storage/async-storage')).default;
    const originalSetItem = vi.mocked(storage.setItem).getMockImplementation();
    let finishSave: (() => void) | undefined;
    vi.mocked(storage.setItem).mockImplementationOnce(
      (key, serialized) =>
        new Promise<void>((resolve) => {
          finishSave = () => {
            void originalSetItem?.(key, serialized).then(resolve);
          };
        }),
    );
    const saving = setStoredQueueSnapshot({
      queue: [makeQueueItem('deleted')],
      currentClimbQueueItem: null,
      playlistSuggestionSource: null,
    });
    await Promise.resolve();
    const clearing = clearStoredQueueSnapshot();
    expect(finishSave).toBeDefined();
    finishSave?.();
    await Promise.all([saving, clearing]);
    expect(await getStoredQueueSnapshot()).toBeNull();
  });
});

describe('privacy invalidation without logical queue deletion', () => {
  it('fences a pending write while retaining the saved queue references', async () => {
    const store = await import('../queue-snapshot-store');
    await store.setStoredQueueSnapshot({
      queue: [makeQueueItem('keep')],
      currentClimbQueueItem: null,
      playlistSuggestionSource: null,
    });
    const oldGeneration = store.getQueueSnapshotGeneration();
    store.invalidateStoredQueueSnapshot();
    await store.setStoredQueueSnapshot(
      { queue: [makeQueueItem('stale')], currentClimbQueueItem: null, playlistSuggestionSource: null },
      undefined,
      oldGeneration,
    );
    expect((await store.getStoredQueueSnapshot())?.queue.map((item) => item.uuid)).toEqual(['keep']);
  });
});
