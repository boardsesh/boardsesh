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

/** A fresh settings store and mini-player store over what is stored, as at launch. */
async function launchWith(stored: Record<string, unknown> = {}) {
  mockStorage.clear();
  for (const [key, value] of Object.entries(stored)) mockStorage.set(key, JSON.stringify(value));
  vi.resetModules();
  const preference = await import('../mini-player-buttons-preference');
  const settings = await import('../../settings/hooks');
  const buttons = await import('../mini-player-buttons');
  return { ...preference, ...settings, ...buttons };
}

const stored = (key: string): unknown => {
  const raw = mockStorage.get(key);
  return raw === undefined ? undefined : JSON.parse(raw);
};

beforeEach(() => {
  mockStorage.clear();
});

describe('mini player buttons editor', () => {
  it('starts on the defaults with nothing stored', async () => {
    const { useMiniPlayerButtonsEditor, DEFAULT_MINI_PLAYER_BUTTONS } = await launchWith();
    const { result } = renderHook(() => useMiniPlayerButtonsEditor());
    expect(result.current.buttons).toEqual(DEFAULT_MINI_PLAYER_BUTTONS);
    expect(result.current.isDefault).toBe(true);
  });

  it('stores a switch and a move under miniPlayerButtonsV1', async () => {
    const { useMiniPlayerButtonsEditor } = await launchWith();
    const { result } = renderHook(() => useMiniPlayerButtonsEditor());
    act(() => result.current.setVisible('favorite', true));
    act(() => result.current.move('queue', -1));
    expect(stored('miniPlayerButtonsV1')).toMatchObject({
      version: 1,
      order: ['next', 'previous', 'mirror', 'queue', 'favorite', 'share', 'angle'],
    });
    expect(result.current.buttons.visible.favorite).toBe(true);
    expect(result.current.isDefault).toBe(false);
  });

  it('stores null once a change is undone by hand', async () => {
    const { useMiniPlayerButtonsEditor } = await launchWith();
    const { result } = renderHook(() => useMiniPlayerButtonsEditor());
    act(() => result.current.setVisible('next', false));
    expect(stored('miniPlayerButtonsV1')).not.toBeNull();
    act(() => result.current.setVisible('next', true));
    expect(stored('miniPlayerButtonsV1')).toBeNull();
    expect(result.current.isDefault).toBe(true);
  });

  it('keeps an id this build does not know when the climber changes something else', async () => {
    const { useMiniPlayerButtonsEditor } = await launchWith({
      miniPlayerButtonsV1: { version: 1, order: ['angle', 'next', 'volume'], visible: { volume: true } },
    });
    const { result } = renderHook(() => useMiniPlayerButtonsEditor());
    expect(result.current.buttons.order[0]).toBe('angle');
    act(() => result.current.setVisible('share', true));
    const record = stored('miniPlayerButtonsV1') as { order: string[]; visible: Record<string, boolean> };
    expect(record.order).toContain('volume');
    expect(record.visible.volume).toBe(true);
  });

  it('Restore defaults clears the key back to null', async () => {
    const { useMiniPlayerButtonsEditor, DEFAULT_MINI_PLAYER_BUTTONS } = await launchWith();
    const { result } = renderHook(() => useMiniPlayerButtonsEditor());
    act(() => result.current.move('angle', -1));
    act(() => result.current.setVisible('share', true));
    expect(result.current.isDefault).toBe(false);
    act(() => result.current.restoreDefaults());
    expect(stored('miniPlayerButtonsV1')).toBeNull();
    expect(result.current.buttons).toEqual(DEFAULT_MINI_PLAYER_BUTTONS);
    expect(result.current.isDefault).toBe(true);
  });

  it('goes back to the defaults when every setting is reset', async () => {
    const { useMiniPlayerButtonsEditor, resetAllSettings, DEFAULT_MINI_PLAYER_BUTTONS } = await launchWith();
    const { result } = renderHook(() => useMiniPlayerButtonsEditor());
    act(() => result.current.setVisible('queue', true));
    act(() => resetAllSettings());
    expect(result.current.buttons).toEqual(DEFAULT_MINI_PLAYER_BUTTONS);
  });
});
