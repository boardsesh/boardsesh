import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    },
  };
});

const board = { serial: 'ABC123', configKey: 'kilter::1::2' };

describe('last-connected-board-store', () => {
  beforeEach(async () => {
    vi.resetModules();
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default as unknown as {
      __reset: () => void;
    };
    asyncStorage.__reset();
  });

  it('round-trips the remembered board through storage', async () => {
    const { getStoredLastConnectedBoard, setStoredLastConnectedBoard } = await import('../last-connected-board-store');
    await setStoredLastConnectedBoard(board);
    await expect(getStoredLastConnectedBoard()).resolves.toEqual(board);
  });

  it('returns null when nothing is stored', async () => {
    const { getStoredLastConnectedBoard } = await import('../last-connected-board-store');
    await expect(getStoredLastConnectedBoard()).resolves.toBeNull();
  });

  it('clears the remembered board (a deliberate disconnect forgets it)', async () => {
    const { getStoredLastConnectedBoard, setStoredLastConnectedBoard, clearStoredLastConnectedBoard } =
      await import('../last-connected-board-store');
    await setStoredLastConnectedBoard(board);
    await clearStoredLastConnectedBoard();
    await expect(getStoredLastConnectedBoard()).resolves.toBeNull();
  });

  it('overwrites a previously remembered board', async () => {
    const { getStoredLastConnectedBoard, setStoredLastConnectedBoard } = await import('../last-connected-board-store');
    await setStoredLastConnectedBoard(board);
    const other = { serial: 'XYZ789', configKey: 'tension::8::17' };
    await setStoredLastConnectedBoard(other);
    await expect(getStoredLastConnectedBoard()).resolves.toEqual(other);
  });

  it('ignores a malformed stored payload rather than returning garbage', async () => {
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    // A value from an older/foreign schema that parses but isn't a board shape.
    await asyncStorage.setItem('boardsesh_last_connected_board_v1', JSON.stringify({ serial: 42 }));
    const { getStoredLastConnectedBoard } = await import('../last-connected-board-store');
    await expect(getStoredLastConnectedBoard()).resolves.toBeNull();
  });

  it('rejects a stored payload with both a serial and a device id set', async () => {
    // The two handles are mutually exclusive by board generation — the writer
    // never sets both. A record with both is an unvalidated/foreign write, so
    // it must fail visibly (null → picker fallback) rather than silently
    // reconnecting on an ambiguous pairing.
    const asyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    await asyncStorage.setItem(
      'boardsesh_last_connected_board_v1',
      JSON.stringify({ configKey: 'moonboard::1::2', serial: 'ABC123', deviceId: 'device-1' }),
    );
    const { getStoredLastConnectedBoard } = await import('../last-connected-board-store');
    await expect(getStoredLastConnectedBoard()).resolves.toBeNull();
  });
});
