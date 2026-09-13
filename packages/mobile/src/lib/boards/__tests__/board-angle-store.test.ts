import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, unknown>();
const getPreferenceMock = vi.hoisted(() => vi.fn());
const setPreferenceMock = vi.hoisted(() => vi.fn());

vi.mock('../../preference-store', () => ({
  getPreference: getPreferenceMock,
  setPreference: setPreferenceMock,
}));

import { getStoredBoardAngle, setStoredBoardAngle, resolveBoardAngle } from '../board-angle-store';

describe('board-angle-store', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    getPreferenceMock.mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null));
    setPreferenceMock.mockImplementation((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    });
  });

  it('round-trips an angle for a board', async () => {
    await setStoredBoardAngle('board-a', 25);
    expect(await getStoredBoardAngle('board-a')).toBe(25);
  });

  it('returns null for a board it has never seen', async () => {
    expect(await getStoredBoardAngle('never-visited')).toBeNull();
  });

  it('keeps each board on its own angle', async () => {
    await setStoredBoardAngle('kilter', 40);
    await setStoredBoardAngle('tension', 25);

    expect(await getStoredBoardAngle('kilter')).toBe(40);
    expect(await getStoredBoardAngle('tension')).toBe(25);
  });

  // The whole point of the map: hopping to the other wall and back must not
  // re-adopt the board record's angle over the one the climber set.
  it('resolves a tracked board to the remembered angle, not the record angle', async () => {
    await setStoredBoardAngle('board-a', 25);

    expect(await resolveBoardAngle({ uuid: 'board-a', angle: 40, isAngleAdjustable: true })).toBe(25);
  });

  it('falls back to the record angle for an untracked board', async () => {
    expect(await resolveBoardAngle({ uuid: 'board-b', angle: 40, isAngleAdjustable: true })).toBe(40);
  });

  // A wall that cannot physically move must never report a remembered angle —
  // a stale local value would misreport the wall to everyone reading it.
  it('ignores a remembered angle for a fixed-angle wall', async () => {
    await setStoredBoardAngle('spray', 40);

    expect(await resolveBoardAngle({ uuid: 'spray', angle: 0, isAngleAdjustable: false })).toBe(0);
  });

  it('evicts the least recently set board once the map is full', async () => {
    for (let index = 0; index < 50; index += 1) {
      await setStoredBoardAngle(`board-${index}`, 30, 1_000 + index);
    }
    await setStoredBoardAngle('board-new', 45, 99_999);

    expect(await getStoredBoardAngle('board-0')).toBeNull();
    expect(await getStoredBoardAngle('board-49')).toBe(30);
    expect(await getStoredBoardAngle('board-new')).toBe(45);
  });
});
