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

  it('round-trips queue, current item, and suggestion source', async () => {
    const { getStoredQueueSnapshot, setStoredQueueSnapshot } = await import('../queue-snapshot-store');
    const queue = [makeQueueItem('a'), makeQueueItem('b')];
    const source = makeSuggestionSource(3, 1);
    await setStoredQueueSnapshot({ queue, currentClimbQueueItem: queue[0], playlistSuggestionSource: source });

    const stored = await getStoredQueueSnapshot();
    expect(stored?.queue).toEqual(queue);
    expect(stored?.currentClimbQueueItem).toEqual(queue[0]);
    expect(stored?.playlistSuggestionSource).toEqual(source);
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

  it('caps an oversized suggestion source to a window around the activated climb', async () => {
    const { getStoredQueueSnapshot, setStoredQueueSnapshot } = await import('../queue-snapshot-store');
    const source = makeSuggestionSource(500, 250);
    await setStoredQueueSnapshot({ queue: [], currentClimbQueueItem: null, playlistSuggestionSource: source });

    const stored = await getStoredQueueSnapshot();
    const persistedClimbs = stored?.playlistSuggestionSource?.climbs ?? [];
    expect(persistedClimbs.length).toBe(100);
    // The activated climb survives the cap so the swipe-through anchor holds.
    expect(persistedClimbs.some((climb) => climb.uuid === 'climb-250')).toBe(true);
    // Identity fields ride along untouched.
    expect(stored?.playlistSuggestionSource?.activatedClimbUuid).toBe('climb-250');
  });

  it('keeps a small suggestion source intact (no needless slicing)', async () => {
    const { getStoredQueueSnapshot, setStoredQueueSnapshot } = await import('../queue-snapshot-store');
    const source = makeSuggestionSource(10, 9);
    await setStoredQueueSnapshot({ queue: [], currentClimbQueueItem: null, playlistSuggestionSource: source });
    const stored = await getStoredQueueSnapshot();
    expect(stored?.playlistSuggestionSource?.climbs).toHaveLength(10);
  });
});
