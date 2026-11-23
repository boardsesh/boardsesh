// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
async function launchWith(stored: Record<string, unknown> = {}, platform: 'native' | 'web' = 'native') {
  mockStorage.clear();
  for (const [key, value] of Object.entries(stored)) mockStorage.set(key, JSON.stringify(value));
  vi.resetModules();
  vi.doMock('../player-navigation-default', () =>
    vi.importActual(platform === 'web' ? '../player-navigation-default.web' : '../player-navigation-default'),
  );
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('player buttons preference', () => {
  it("draws today's bar below the board with nothing stored", async () => {
    const { usePlayerButtonsPreference, DEFAULT_PLAYER_BUTTONS, isDefaultPlayerButtons } = await launchWith();
    const { result } = renderHook(() => usePlayerButtonsPreference());
    expect(result.current.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
    expect(result.current.previousNext).toBe(false);
    expect(result.current.position).toBe('below');
    expect(result.current.boardControl).toBe('wallButton');
    expect(isDefaultPlayerButtons(result.current)).toBe(true);
  });

  // Synchronous, so the very first frame of the player already has the bar the
  // climber set up: no jump from the default bar to theirs.
  it('has the stored buttons, switch and position on the first read', async () => {
    const { usePlayerButtonsPreference } = await launchWith({
      playerButtonsV4: {
        version: 1,
        order: ['queue', 'mirror', 'favorite', 'angle', 'share'],
        visible: { share: true, favorite: false },
      },
      playerPreviousNext: false,
      playerButtonsPosition: 'above',
    });
    const { result } = renderHook(() => usePlayerButtonsPreference());
    expect(result.current.buttons.order).toEqual(['queue', 'mirror', 'favorite', 'angle', 'playNext', 'share']);
    expect(result.current.buttons.visible).toEqual({
      mirror: true,
      favorite: false,
      angle: true,
      playNext: true,
      share: true,
      queue: true,
    });
    expect(result.current.previousNext).toBe(false);
    expect(result.current.position).toBe('above');
  });

  it.each([true, false])('preserves the stored navigation choice %s', async (previousNext) => {
    const { usePlayerButtonsPreference } = await launchWith({ playerPreviousNext: previousNext });
    expect(renderHook(() => usePlayerButtonsPreference()).result.current.previousNext).toBe(previousNext);
  });

  describe('web navigation', () => {
    beforeEach(() => {
      vi.stubGlobal(
        'matchMedia',
        vi.fn(() => ({ matches: true })),
      );
    });

    it.each([
      ['mouse', 'fine', 'hover', 'fine', 'hover', 0, true],
      ['trackpad on a touchscreen laptop', 'fine', 'hover', 'fine', 'hover', 10, true],
      ['touch-primary tablet with a mouse', 'coarse', 'none', 'fine', 'hover', 10, true],
      ['phone', 'coarse', 'none', 'coarse', 'none', 5, false],
      ['touch tablet', 'coarse', 'none', 'coarse', 'none', 10, false],
      ['fine pointer without hover', 'fine', 'none', 'fine', 'none', 0, false],
      ['coarse pointer with hover', 'coarse', 'hover', 'coarse', 'hover', 5, false],
    ])(
      'uses available input capabilities on a %s',
      async (_device, pointer, hover, anyPointer, anyHover, maxTouchPoints, expected) => {
        const browserNavigator = Object.create(navigator) as Navigator;
        Object.defineProperty(browserNavigator, 'maxTouchPoints', { value: maxTouchPoints });
        vi.stubGlobal('navigator', browserNavigator);
        const matchMedia = vi.fn((query: string) => ({
          matches:
            query === '(any-hover: hover) and (any-pointer: fine)'
              ? anyPointer === 'fine' && anyHover === 'hover'
              : query === '(hover: hover) and (pointer: fine)' && pointer === 'fine' && hover === 'hover',
        }));
        vi.stubGlobal('matchMedia', matchMedia);
        const { usePlayerButtonsPreference, getSetting, isDefaultPlayerButtons } = await launchWith({}, 'web');
        const { result } = renderHook(() => usePlayerButtonsPreference());
        expect(matchMedia).toHaveBeenCalledWith('(any-hover: hover) and (any-pointer: fine)');
        expect(result.current.previousNext).toBe(expected);
        expect(getSetting('playerPreviousNext')).toBe(expected);
        expect(isDefaultPlayerButtons(result.current)).toBe(true);
      },
    );

    it.each([true, false])('preserves the saved choice %s in a touch-only browser', async (previousNext) => {
      vi.stubGlobal('matchMedia', () => ({ matches: false }));
      const { usePlayerButtonsPreference } = await launchWith({ playerPreviousNext: previousNext }, 'web');
      expect(renderHook(() => usePlayerButtonsPreference()).result.current.previousNext).toBe(previousNext);
    });

    it('keeps navigation off when media queries are unavailable', async () => {
      vi.stubGlobal('matchMedia', undefined);
      const { usePlayerButtonsPreference } = await launchWith({}, 'web');
      expect(renderHook(() => usePlayerButtonsPreference()).result.current.previousNext).toBe(false);
    });

    it('can load the browser default during server rendering', async () => {
      vi.stubGlobal('window', undefined);
      vi.resetModules();
      expect((await import('../player-navigation-default.web')).DEFAULT_PLAYER_PREVIOUS_NEXT).toBe(false);
    });

    it.each([
      [undefined, true],
      ['unrecognized', true],
      [true, true],
      [false, false],
    ])('reads stored %s as %s on the first frame', async (storedPreviousNext, expectedPreviousNext) => {
      const settings = storedPreviousNext === undefined ? {} : { playerPreviousNext: storedPreviousNext };
      const { usePlayerButtonsPreference, isDefaultPlayerButtons, getSetting } = await launchWith(settings, 'web');
      const { result } = renderHook(() => usePlayerButtonsPreference());
      expect(result.current.previousNext).toBe(expectedPreviousNext);
      expect(isDefaultPlayerButtons(result.current)).toBe(expectedPreviousNext);
      if (storedPreviousNext === undefined) expect(getSetting('playerPreviousNext')).toBe(true);
    });

    it('follows mouse attachment and removal until a navigation choice is saved', async () => {
      let mouseAvailable = false;
      const listeners = new Set<() => void>();
      vi.stubGlobal('matchMedia', () => ({
        get matches() {
          return mouseAvailable;
        },
        addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      }));
      const { usePlayerButtonsEditor, hasSetting } = await launchWith({}, 'web');
      const { result, unmount } = renderHook(() => usePlayerButtonsEditor());
      expect(result.current.previousNext).toBe(false);
      act(() => {
        mouseAvailable = true;
        for (const listener of listeners) listener();
      });
      expect(result.current.previousNext).toBe(true);
      expect(hasSetting('playerPreviousNext')).toBe(false);
      act(() => result.current.setPreviousNext(false));
      act(() => {
        mouseAvailable = false;
        for (const listener of listeners) listener();
      });
      act(() => {
        mouseAvailable = true;
        for (const listener of listeners) listener();
      });
      expect(result.current.previousNext).toBe(false);
      act(() => result.current.restoreDefaults());
      expect(result.current.previousNext).toBe(true);
      expect(hasSetting('playerPreviousNext')).toBe(false);
      act(() => {
        mouseAvailable = false;
        for (const listener of listeners) listener();
      });
      expect(result.current.previousNext).toBe(false);
      unmount();
      expect(listeners.size).toBe(0);
    });

    it('restores visible navigation after hiding it or resetting settings', async () => {
      const { usePlayerButtonsEditor, resetAllSettings, isDefaultPlayerButtons } = await launchWith({}, 'web');
      const { result } = renderHook(() => usePlayerButtonsEditor());
      act(() => result.current.setPreviousNext(false));
      expect(result.current.previousNext).toBe(false);
      act(() => result.current.restoreDefaults());
      expect(result.current.previousNext).toBe(true);
      expect(isDefaultPlayerButtons(result.current)).toBe(true);
      act(() => result.current.setPreviousNext(false));
      act(() => resetAllSettings());
      expect(result.current.previousNext).toBe(true);
    });

    it('restores hidden navigation in a touch-only browser', async () => {
      vi.stubGlobal('matchMedia', () => ({ matches: false }));
      const { usePlayerButtonsEditor, resetAllSettings, isDefaultPlayerButtons } = await launchWith({}, 'web');
      const { result } = renderHook(() => usePlayerButtonsEditor());
      act(() => result.current.setPreviousNext(true));
      act(() => result.current.restoreDefaults());
      expect(result.current.previousNext).toBe(false);
      expect(isDefaultPlayerButtons(result.current)).toBe(true);
      act(() => result.current.setPreviousNext(true));
      act(() => resetAllSettings());
      expect(result.current.previousNext).toBe(false);
    });
  });

  describe('V3 migration', () => {
    const previousDefaults = {
      version: 1,
      order: ['mirror', 'angle', 'favorite', 'share', 'queue'],
      visible: { mirror: true, angle: true, favorite: true, share: true, queue: true },
    };

    it.each([null, previousDefaults, { ...previousDefaults, boardControl: 'lightbulb' }])(
      'adds Play next for default V3 layouts without overwriting V3',
      async (record) => {
        const { usePlayerButtonsPreference, DEFAULT_PLAYER_BUTTONS } = await launchWith({ playerButtonsV3: record });
        const preference = renderHook(() => usePlayerButtonsPreference()).result.current;
        expect(preference.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
        expect(preference.boardControl).toBe(record && 'boardControl' in record ? record.boardControl : 'wallButton');
        expect(stored('playerButtonsV3')).toEqual(record);
      },
    );

    it('keeps custom V3 arrangements stable with Play next off', async () => {
      const legacy = {
        ...previousDefaults,
        order: ['queue', 'futureAction', 'mirror', 'angle', 'share', 'favorite'],
        visible: { ...previousDefaults.visible, share: false, futureAction: true },
        boardControl: 'lightbulb',
      };
      const { usePlayerButtonsEditor } = await launchWith({ playerButtonsV3: legacy });
      const { result } = renderHook(() => usePlayerButtonsEditor());
      expect(result.current.buttons.order).toEqual(['queue', 'mirror', 'angle', 'playNext', 'share', 'favorite']);
      expect(result.current.buttons.visible.playNext).toBe(false);
      act(() => result.current.setVisible('playNext', true));
      expect(stored('playerButtonsV4')).toMatchObject({
        order: ['queue', 'futureAction', 'mirror', 'angle', 'playNext', 'share', 'favorite'],
        visible: { playNext: true, futureAction: true, share: false },
        boardControl: 'lightbulb',
      });
      expect(stored('playerButtonsV3')).toEqual(legacy);
    });

    it('restores V4 defaults across relaunch without reimporting custom V3', async () => {
      const legacy = { ...previousDefaults, visible: { ...previousDefaults.visible, favorite: false } };
      const { restorePlayerButtonDefaults } = await launchWith({ playerButtonsV3: legacy });
      restorePlayerButtonDefaults();
      vi.resetModules();
      const { usePlayerButtonsPreference } = await import('../player-buttons-preference');
      expect(renderHook(() => usePlayerButtonsPreference()).result.current.buttons.visible.playNext).toBe(true);
      expect(stored('playerButtonsV3')).toEqual(legacy);
    });
  });

  describe('V2 migration', () => {
    const legacyDefaults = {
      version: 1,
      order: ['mirror', 'favorite', 'queue', 'share', 'angle'],
      visible: { mirror: true, favorite: true, queue: true, share: false, angle: false },
    };

    it.each([null, legacyDefaults])('adopts the new defaults from an unchanged V2 layout', async (record) => {
      const { usePlayerButtonsPreference, DEFAULT_PLAYER_BUTTONS } = await launchWith({ playerButtonsV2: record });
      expect(renderHook(() => usePlayerButtonsPreference()).result.current.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
      expect(stored('playerButtonsV4')).toBeNull();
      expect(stored('playerButtonsV2')).toEqual(record);
    });

    it('carries the bulb choice while adopting new button defaults', async () => {
      const legacy = { ...legacyDefaults, boardControl: 'lightbulb' };
      const { usePlayerButtonsPreference, DEFAULT_PLAYER_BUTTONS } = await launchWith({ playerButtonsV2: legacy });
      const preference = renderHook(() => usePlayerButtonsPreference()).result.current;
      expect(preference.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
      expect(preference.boardControl).toBe('lightbulb');
      expect(stored('playerButtonsV4')).toMatchObject({
        order: DEFAULT_PLAYER_BUTTONS.order,
        visible: DEFAULT_PLAYER_BUTTONS.visible,
        boardControl: 'lightbulb',
      });
      expect(stored('playerButtonsV2')).toEqual(legacy);
    });

    it('materializes omitted V2 switches against the legacy defaults', async () => {
      const legacy = { version: 1, order: ['queue', 'mirror', 'favorite', 'share', 'angle'], visible: {} };
      const { usePlayerButtonsPreference } = await launchWith({ playerButtonsV2: legacy });
      const preference = renderHook(() => usePlayerButtonsPreference()).result.current;
      expect(preference.buttons.order).toEqual([...legacy.order, 'playNext']);
      expect(preference.buttons.visible).toEqual({ ...legacyDefaults.visible, playNext: false });
      expect(stored('playerButtonsV4')).toMatchObject({
        order: [...legacy.order, 'playNext'],
        visible: { ...legacyDefaults.visible, playNext: false },
      });
      expect(stored('playerButtonsV2')).toEqual(legacy);
    });

    it('keeps unknown V2 ids and boolean switches through migration and an edit', async () => {
      const legacy = {
        ...legacyDefaults,
        order: ['mirror', 'futureButton', 'favorite', 'queue', 'share', 'angle'],
        visible: { ...legacyDefaults.visible, futureButton: false, futureToggle: true },
      };
      const { playerButtonsStore } = await launchWith({ playerButtonsV2: legacy });
      expect(stored('playerButtonsV4')).toMatchObject({
        order: [...legacy.order, 'playNext'],
        visible: legacy.visible,
      });
      playerButtonsStore.setVisible('favorite', false);
      expect(stored('playerButtonsV4')).toMatchObject({
        order: [...legacy.order, 'playNext'],
        visible: { futureButton: false, futureToggle: true, favorite: false },
      });
      expect(stored('playerButtonsV2')).toEqual(legacy);
    });

    it.each([null, 'broken', { version: 2, order: [], visible: {} }])(
      'does not import V2 when V4 is already present',
      async (record) => {
        const { usePlayerButtonsPreference, DEFAULT_PLAYER_BUTTONS } = await launchWith({
          playerButtonsV2: { ...legacyDefaults, boardControl: 'lightbulb' },
          playerButtonsV4: record,
        });
        const preference = renderHook(() => usePlayerButtonsPreference()).result.current;
        expect(preference.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
        expect(preference.boardControl).toBe('wallButton');
        expect(stored('playerButtonsV4')).toEqual(record);
      },
    );

    it('keeps restored V4 defaults after a relaunch without importing V2 again', async () => {
      const legacy = { ...legacyDefaults, order: ['queue', 'mirror', 'favorite', 'share', 'angle'] };
      const { restorePlayerButtonDefaults } = await launchWith({ playerButtonsV2: legacy });
      restorePlayerButtonDefaults();
      expect(stored('playerButtonsV4')).toBeNull();
      vi.resetModules();
      const preference = await import('../player-buttons-preference');
      const { DEFAULT_PLAYER_BUTTONS } = await import('../player-buttons');
      expect(renderHook(() => preference.usePlayerButtonsPreference()).result.current.buttons).toEqual(
        DEFAULT_PLAYER_BUTTONS,
      );
      expect(stored('playerButtonsV2')).toEqual(legacy);
    });
  });

  // #7000: the buttons' meaning changed, so they moved to a new key. A round-2
  // record is never read, and nothing stored can break the bar.
  it.each([
    [
      'a round-2 record under the old key',
      { playerButtonsV1: { version: 1, order: ['queue'], visible: { mirror: false } } },
    ],
    ['garbage under the new key', { playerButtonsV4: 'not a layout' }],
    ['a record from a future version', { playerButtonsV4: { version: 2, order: ['angle'], visible: {} } }],
    [
      'a record with unknown ids and bad switches',
      { playerButtonsV4: { version: 1, order: ['wallControl', 7, 'angle'], visible: { angle: 'yes', queue: false } } },
    ],
  ])('starts everyone on the defaults with %s, without a crash', async (_case, storedValues) => {
    const { usePlayerButtonsPreference, DEFAULT_PLAYER_BUTTONS } = await launchWith(storedValues);
    const { result } = renderHook(() => usePlayerButtonsPreference());
    if ('playerButtonsV4' in storedValues && typeof storedValues.playerButtonsV4 === 'object') {
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
    expect(result.current.previousNext).toBe(false);
  });

  it('stores a change, and Restore defaults clears every key back to the defaults', async () => {
    const { usePlayerButtonsEditor, isDefaultPlayerButtons, DEFAULT_PLAYER_BUTTONS } = await launchWith();
    const { result } = renderHook(() => usePlayerButtonsEditor());

    act(() => result.current.move('queue', -1));
    act(() => result.current.setVisible('share', false));
    act(() => result.current.setPreviousNext(true));
    act(() => result.current.setPosition('above'));
    expect(stored('playerButtonsV4')).toMatchObject({
      version: 1,
      order: ['mirror', 'angle', 'playNext', 'favorite', 'queue', 'share'],
      visible: { share: false },
    });
    expect(result.current.position).toBe('above');
    expect(isDefaultPlayerButtons(result.current)).toBe(false);

    act(() => result.current.restoreDefaults());
    // `null` rather than a copy of today's defaults, so a later release's defaults still apply.
    expect(stored('playerButtonsV4')).toBeNull();
    expect(result.current.buttons).toEqual(DEFAULT_PLAYER_BUTTONS);
    expect(stored('playerPreviousNext')).toBeUndefined();
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
      const { usePlayerButtonsPreference } = await launchWith(record === undefined ? {} : { playerButtonsV4: record });
      expect(renderHook(() => usePlayerButtonsPreference()).result.current.boardControl).toBe('wallButton');
    });

    it('reads a stored bulb on the first frame', async () => {
      const { usePlayerButtonsPreference } = await launchWith({
        playerButtonsV4: { version: 1, order: ['mirror'], visible: {}, boardControl: 'lightbulb' },
      });
      expect(renderHook(() => usePlayerButtonsPreference()).result.current.boardControl).toBe('lightbulb');
    });

    it('keeps the buttons when the choice changes, and the choice when the buttons do', async () => {
      const { usePlayerButtonsEditor, isDefaultPlayerButtons } = await launchWith();
      const { result } = renderHook(() => usePlayerButtonsEditor());

      act(() => result.current.setBoardControl('lightbulb'));
      // A record even with the buttons on their defaults, so the choice is kept.
      expect(stored('playerButtonsV4')).toMatchObject({ version: 1, boardControl: 'lightbulb' });
      expect(result.current.boardControl).toBe('lightbulb');
      expect(isDefaultPlayerButtons(result.current)).toBe(false);

      act(() => result.current.move('queue', -1));
      expect(stored('playerButtonsV4')).toMatchObject({
        order: ['mirror', 'angle', 'playNext', 'favorite', 'queue', 'share'],
        boardControl: 'lightbulb',
      });
      act(() => result.current.move('queue', 1));
      // Back on the default buttons: still a record, since the bulb is chosen.
      expect(stored('playerButtonsV4')).toMatchObject({ boardControl: 'lightbulb' });

      act(() => result.current.setBoardControl('wallButton'));
      // Back on every default: `null`, so a later release's defaults still apply.
      expect(stored('playerButtonsV4')).toBeNull();
      expect(isDefaultPlayerButtons(result.current)).toBe(true);
    });

    it('keeps a moved button when the wall button comes back', async () => {
      const { usePlayerButtonsEditor } = await launchWith();
      const { result } = renderHook(() => usePlayerButtonsEditor());
      act(() => result.current.setBoardControl('lightbulb'));
      act(() => result.current.setVisible('share', false));
      act(() => result.current.setBoardControl('wallButton'));
      expect(stored('playerButtonsV4')).toEqual({
        version: 1,
        order: ['mirror', 'angle', 'playNext', 'favorite', 'share', 'queue'],
        visible: expect.objectContaining({ share: false }),
      });
      expect(result.current.buttons.visible.share).toBe(false);
    });

    it('goes back to the wall button on Restore defaults', async () => {
      const { usePlayerButtonsEditor } = await launchWith();
      const { result } = renderHook(() => usePlayerButtonsEditor());
      act(() => result.current.setBoardControl('lightbulb'));
      act(() => result.current.setVisible('share', false));
      act(() => result.current.restoreDefaults());
      expect(stored('playerButtonsV4')).toBeNull();
      expect(result.current.boardControl).toBe('wallButton');
    });

    it('preserves unknown visibility-only switches when returning to the wall button', async () => {
      const { usePlayerButtonsEditor } = await launchWith({
        playerButtonsV4: {
          version: 1,
          order: ['mirror', 'angle', 'playNext', 'favorite', 'share', 'queue'],
          visible: { mirror: true, angle: true, favorite: true, share: true, queue: true, futureButton: false },
          boardControl: 'lightbulb',
        },
      });
      const { result } = renderHook(() => usePlayerButtonsEditor());
      act(() => result.current.setBoardControl('wallButton'));
      expect(stored('playerButtonsV4')).toMatchObject({ visible: { futureButton: false } });
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
