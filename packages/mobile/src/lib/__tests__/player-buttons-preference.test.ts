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
    expect(isDefaultPlayerButtons(result.current)).toBe(true);
  });

  // Synchronous, so the very first frame of the player already has the bar the
  // climber set up: no jump from the default bar to theirs.
  it('has the stored buttons, switch and position on the first read', async () => {
    const { usePlayerButtonsPreference } = await launchWith({
      playerButtonsV1: {
        version: 1,
        order: ['queue', 'mirror', 'favorite', 'angle', 'share'],
        visible: { share: false },
      },
      playerPreviousNext: false,
      playerButtonsPosition: 'above',
    });
    const { result } = renderHook(() => usePlayerButtonsPreference());
    expect(result.current.buttons.order).toEqual(['queue', 'mirror', 'favorite', 'angle', 'share']);
    expect(result.current.buttons.visible).toEqual({
      mirror: true,
      favorite: true,
      angle: true,
      share: false,
      queue: true,
    });
    expect(result.current.previousNext).toBe(false);
    expect(result.current.position).toBe('above');
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

  it('stores a change, and Restore defaults clears all three keys back to the defaults', async () => {
    const { usePlayerButtonsEditor, isDefaultPlayerButtons, DEFAULT_PLAYER_BUTTONS } = await launchWith();
    const { result } = renderHook(() => usePlayerButtonsEditor());

    act(() => result.current.move('queue', -1));
    act(() => result.current.setVisible('share', false));
    act(() => result.current.setPreviousNext(false));
    act(() => result.current.setPosition('above'));
    expect(stored('playerButtonsV1')).toMatchObject({
      version: 1,
      order: ['mirror', 'favorite', 'angle', 'queue', 'share'],
      visible: { share: false },
    });
    expect(result.current.position).toBe('above');
    expect(isDefaultPlayerButtons(result.current)).toBe(false);

    act(() => result.current.restoreDefaults());
    // `null` rather than a copy of today's defaults, so a later release's defaults still apply.
    expect(stored('playerButtonsV1')).toBeNull();
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
  it('keeps one identity across an unrelated settings write', async () => {
    const { usePlayerButtonsPreference, setSetting } = await launchWith();
    const { result } = renderHook(() => usePlayerButtonsPreference());
    const first = result.current;
    act(() => setSetting('theme', 'dark'));
    expect(result.current).toBe(first);
  });
});
