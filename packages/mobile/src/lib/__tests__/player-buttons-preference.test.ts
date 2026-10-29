// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStorage = new Map<string, string>();
vi.mock('react-native-mmkv', () => ({
  createMMKV: () => ({
    getString: (key: string) => mockStorage.get(key),
    set: (key: string, value: string) => mockStorage.set(key, value),
    remove: (key: string) => mockStorage.delete(key),
    clearAll: () => mockStorage.clear(),
  }),
}));

/** A fresh settings store and player-buttons store over what is stored, as at launch. */
async function launchWith(stored: Record<string, unknown> = {}) {
  mockStorage.clear();
  for (const [key, value] of Object.entries(stored)) mockStorage.set(key, JSON.stringify(value));
  vi.resetModules();
  const preference = await import('../player-buttons-preference');
  const settings = await import('../../settings/hooks');
  const buttons = await import('../player-buttons');
  return { ...preference, ...settings, ...buttons };
}

const stored = (key: string): unknown => {
  const raw = mockStorage.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
};

beforeEach(() => {
  mockStorage.clear();
});

describe('player buttons preference', () => {
  it("draws today's bar below the board with nothing stored", async () => {
    const { usePlayerButtonsPreference, DEFAULT_PLAYER_BUTTONS, isDefaultPlayerButtons } = await launchWith();
    const { result } = renderHook(() => usePlayerButtonsPreference());
    expect(result.current.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
    expect(result.current.previousNext).toBe(true);
    expect(result.current.position).toBe('below');
    expect(result.current.boardControl).toBe('wallButton');
    expect(isDefaultPlayerButtons(result.current)).toBe(true);
  });

  // Synchronous, so the very first frame of the player already has the bar the
  // climber set up: no jump from the default bar to theirs.
  it('has the stored buttons, switch and position on the first read', async () => {
    const { usePlayerButtonsPreference } = await launchWith({
      playerButtonsV2: {
        version: 1,
        order: ['queue', 'mirror', 'favorite', 'angle', 'share'],
        visible: { share: true, favorite: false },
      },
      playerPreviousNext: false,
      playerButtonsPosition: 'above',
    });
    const { result } = renderHook(() => usePlayerButtonsPreference());
    expect(result.current.buttons.order).toEqual(['queue', 'mirror', 'favorite', 'angle', 'share']);
    expect(result.current.buttons.visible).toEqual({
      mirror: true,
      favorite: false,
      angle: false,
      share: true,
      queue: true,
    });
    expect(result.current.previousNext).toBe(false);
    expect(result.current.position).toBe('above');
  });

  // #7000: the buttons' meaning changed, so they moved to a new key. A round-2
  // record is never read, and nothing stored can break the bar.
  it.each([
    [
      'a round-2 record under the old key',
      { playerButtonsV1: { version: 1, order: ['queue'], visible: { mirror: false } } },
    ],
    ['garbage under the new key', { playerButtonsV2: 'not a layout' }],
    ['a record from a future version', { playerButtonsV2: { version: 2, order: ['angle'], visible: {} } }],
    [
      'a record with unknown ids and bad switches',
      { playerButtonsV2: { version: 1, order: ['wallControl', 7, 'angle'], visible: { angle: 'yes', queue: false } } },
    ],
  ])('starts everyone on the defaults with %s, without a crash', async (_case, storedValues) => {
    const { usePlayerButtonsPreference, DEFAULT_PLAYER_BUTTONS } = await launchWith(storedValues);
    const { result } = renderHook(() => usePlayerButtonsPreference());
    if ('playerButtonsV2' in storedValues && typeof storedValues.playerButtonsV2 === 'object') {
      // A readable record keeps what it can: known ids, real booleans, defaults for the rest.
      expect(result.current.buttons.order).toEqual(expect.arrayContaining([...DEFAULT_PLAYER_BUTTONS.order]));
      expect(result.current.buttons.order).toHaveLength(DEFAULT_PLAYER_BUTTONS.order.length);
    } else {
      expect(result.current.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
    }
  });

  it("reads a position or switch this build doesn't know as the default", async () => {
    const { usePlayerButtonsPreference } = await launchWith({
      playerButtonsPosition: 'beside',
      playerPreviousNext: 'yes',
    });
    const { result } = renderHook(() => usePlayerButtonsPreference());
    expect(result.current.position).toBe('below');
    expect(result.current.previousNext).toBe(true);
  });

  it('stores a change, and Restore defaults clears every key back to the defaults', async () => {
    const { usePlayerButtonsEditor, isDefaultPlayerButtons, DEFAULT_PLAYER_BUTTONS } = await launchWith();
    const { result } = renderHook(() => usePlayerButtonsEditor());

    act(() => result.current.move('queue', -1));
    act(() => result.current.setVisible('share', true));
    act(() => result.current.setPreviousNext(false));
    act(() => result.current.setPosition('above'));
    expect(stored('playerButtonsV2')).toMatchObject({
      version: 1,
      order: ['mirror', 'queue', 'favorite', 'share', 'angle'],
      visible: { share: true },
    });
    expect(result.current.position).toBe('above');
    expect(isDefaultPlayerButtons(result.current)).toBe(false);

    act(() => result.current.restoreDefaults());
    // `null` rather than a copy of today's defaults, so a later release's defaults still apply.
    expect(stored('playerButtonsV2')).toBeNull();
    expect(result.current.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
    expect(stored('playerPreviousNext')).toBe(true);
    expect(stored('playerButtonsPosition')).toBe('below');
    expect(result.current.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
    expect(isDefaultPlayerButtons(result.current)).toBe(true);
  });

  it('leaves the two switches unwritten when Restore defaults finds them at their defaults', async () => {
    const { restorePlayerButtonDefaults, playerButtonsStore } = await launchWith();
    playerButtonsStore.setVisible('favorite', false);
    restorePlayerButtonDefaults();
    expect(stored('playerPreviousNext')).toBeUndefined();
    expect(stored('playerButtonsPosition')).toBeUndefined();
  });

  it('goes back to the defaults when every setting is reset', async () => {
    const { usePlayerButtonsEditor, resetAllSettings, DEFAULT_PLAYER_BUTTONS } = await launchWith();
    const { result } = renderHook(() => usePlayerButtonsEditor());
    act(() => result.current.setVisible('mirror', false));
    act(() => result.current.setPosition('above'));
    act(() => resetAllSettings());
    expect(result.current.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
    expect(result.current.position).toBe('below');
  });

  // The player reads this on every render; an unrelated setting must not hand
  // it a new object (and re-resolve the bar).
  // #7000: View options › Buttons › Board control rides the buttons' record.
  describe('board control', () => {
    it.each([
      ['nothing stored', undefined],
      ['a record without one', { version: 1, order: ['mirror'], visible: {} }],
      ['a value this build does not know', { version: 1, order: [], visible: {}, boardControl: 'neon' }],
      ['a number', { version: 1, order: [], visible: {}, boardControl: 5 }],
      ['a record of another version', { version: 2, order: [], visible: {}, boardControl: 'lightbulb' }],
      ['garbage', 'lightbulb'],
    ])('reads %s as the wall button', async (_case, record) => {
      const { usePlayerButtonsPreference } = await launchWith(record === undefined ? {} : { playerButtonsV2: record });
      expect(renderHook(() => usePlayerButtonsPreference()).result.current.boardControl).toBe('wallButton');
    });

    it('reads a stored bulb on the first frame', async () => {
      const { usePlayerButtonsPreference } = await launchWith({
        playerButtonsV2: { version: 1, order: ['mirror'], visible: {}, boardControl: 'lightbulb' },
      });
      expect(renderHook(() => usePlayerButtonsPreference()).result.current.boardControl).toBe('lightbulb');
    });

    it('keeps the buttons when the choice changes, and the choice when the buttons do', async () => {
      const { usePlayerButtonsEditor, isDefaultPlayerButtons } = await launchWith();
      const { result } = renderHook(() => usePlayerButtonsEditor());

      act(() => result.current.setBoardControl('lightbulb'));
      // A record even with the buttons on their defaults, so the choice is kept.
      expect(stored('playerButtonsV2')).toMatchObject({ version: 1, boardControl: 'lightbulb' });
      expect(result.current.boardControl).toBe('lightbulb');
      expect(isDefaultPlayerButtons(result.current)).toBe(false);

      act(() => result.current.move('queue', -1));
      expect(stored('playerButtonsV2')).toMatchObject({
        order: ['mirror', 'queue', 'favorite', 'share', 'angle'],
        boardControl: 'lightbulb',
      });
      act(() => result.current.move('queue', 1));
      // Back on the default buttons: still a record, since the bulb is chosen.
      expect(stored('playerButtonsV2')).toMatchObject({ boardControl: 'lightbulb' });

      act(() => result.current.setBoardControl('wallButton'));
      // Back on every default: `null`, so a later release's defaults still apply.
      expect(stored('playerButtonsV2')).toBeNull();
      expect(isDefaultPlayerButtons(result.current)).toBe(true);
    });

    it('keeps a moved button when the wall button comes back', async () => {
      const { usePlayerButtonsEditor } = await launchWith();
      const { result } = renderHook(() => usePlayerButtonsEditor());
      act(() => result.current.setBoardControl('lightbulb'));
      act(() => result.current.setVisible('share', true));
      act(() => result.current.setBoardControl('wallButton'));
      expect(stored('playerButtonsV2')).toEqual({
        version: 1,
        order: ['mirror', 'favorite', 'queue', 'share', 'angle'],
        visible: expect.objectContaining({ share: true }),
      });
      expect(result.current.buttons.visible.share).toBe(true);
    });

    it('goes back to the wall button on Restore defaults', async () => {
      const { usePlayerButtonsEditor } = await launchWith();
      const { result } = renderHook(() => usePlayerButtonsEditor());
      act(() => result.current.setBoardControl('lightbulb'));
      act(() => result.current.setVisible('share', true));
      act(() => result.current.restoreDefaults());
      expect(stored('playerButtonsV2')).toBeNull();
      expect(result.current.boardControl).toBe('wallButton');
    });
  });

  it('keeps one identity across an unrelated settings write', async () => {
    const { usePlayerButtonsPreference, setSetting } = await launchWith();
    const { result } = renderHook(() => usePlayerButtonsPreference());
    const first = result.current;
    act(() => setSetting('theme', 'dark'));
    expect(result.current).toBe(first);
  });
});
