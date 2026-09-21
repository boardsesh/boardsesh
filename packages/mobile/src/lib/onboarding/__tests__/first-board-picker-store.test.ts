import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  failReads: false,
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => {
      if (storage.failReads) throw new Error('read denied before first unlock');
      return storage.values.get(key) ?? null;
    }),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.values.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      storage.values.delete(key);
    }),
  },
}));

const { clearFirstBoardPickerShowCount, readFirstBoardPickerShowCount, recordFirstBoardPickerShown } =
  await import('../first-board-picker-store');

describe('first-board picker show counter', () => {
  beforeEach(() => {
    storage.values.clear();
    storage.failReads = false;
  });

  it('starts at zero', async () => {
    expect(await readFirstBoardPickerShowCount('user-a')).toBe(0);
  });

  it('reads back what was recorded for the same account', async () => {
    await recordFirstBoardPickerShown('user-a', 1);
    expect(await readFirstBoardPickerShowCount('user-a')).toBe(1);
    await recordFirstBoardPickerShown('user-a', 2);
    expect(await readFirstBoardPickerShowCount('user-a')).toBe(2);
  });

  // A second climber on a shared phone must not inherit the first one's count.
  it('starts another account from zero', async () => {
    await recordFirstBoardPickerShown('user-a', 2);
    expect(await readFirstBoardPickerShowCount('user-b')).toBe(0);
  });

  it('is gone after a sign-out clears it', async () => {
    await recordFirstBoardPickerShown('user-a', 2);
    await clearFirstBoardPickerShowCount();
    expect(await readFirstBoardPickerShowCount('user-a')).toBe(0);
  });

  it('reads a malformed value as zero rather than trusting it', async () => {
    storage.values.set('firstBoardPickerShown', JSON.stringify({ userId: 'user-a', count: 'lots' }));
    expect(await readFirstBoardPickerShowCount('user-a')).toBe(0);
  });

  // The decision reads null as "don't show": a cap that cannot be read cannot hold.
  it('reports a failed read as null, not as zero', async () => {
    storage.failReads = true;
    expect(await readFirstBoardPickerShowCount('user-a')).toBeNull();
  });
});
