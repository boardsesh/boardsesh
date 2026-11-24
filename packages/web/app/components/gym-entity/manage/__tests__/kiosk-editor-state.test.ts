import { describe, expect, it } from 'vitest';
import { KioskLayoutSchema, MAX_KIOSK_BOARDS, emptyKioskLayout } from '@boardsesh/kiosk';
import {
  addBoardSlot,
  editorStateFromLayout,
  editorStatesEqual,
  moveBoardSlot,
  removeBoardSlot,
  serializeKioskLayout,
  setInstallQrEnabled,
  setKioskTheme,
  setLeaderboardEnabled,
  setLeaderboardPeriod,
  setLeaderboardScope,
  setSlotBoard,
  type KioskEditorState,
} from '../kiosk-editor-state';

const boardA = '11111111-1111-4111-8111-111111111111';
const boardB = '22222222-2222-4222-8222-222222222222';
const boardC = '33333333-3333-4333-8333-333333333333';
const boardD = '44444444-4444-4444-8444-444444444444';
const boardE = '55555555-5555-4555-8555-555555555555';

function stateWith(
  boardUuids: string[],
  leaderboard: KioskEditorState['leaderboard'] = null,
  showInstallQr = false,
  theme: KioskEditorState['theme'] = 'dark',
): KioskEditorState {
  return { boardUuids, leaderboard, showInstallQr, theme };
}

describe('editorStateFromLayout', () => {
  it('reads a stored layout leniently', () => {
    const state = editorStateFromLayout({
      version: 1,
      boards: [{ boardUuid: boardA }, { boardUuid: boardB }],
      leaderboard: { boardUuid: boardB, period: 'week' },
    });
    expect(state.boardUuids).toEqual([boardA, boardB]);
    expect(state.leaderboard).toEqual({ boardUuid: boardB, period: 'week' });
  });

  it('degrades corrupt input to an empty state instead of throwing', () => {
    expect(editorStateFromLayout('garbage')).toEqual({
      boardUuids: [],
      leaderboard: null,
      showInstallQr: false,
      theme: 'dark',
    });
    expect(editorStateFromLayout(emptyKioskLayout())).toEqual({
      boardUuids: [],
      leaderboard: null,
      showInstallQr: false,
      theme: 'dark',
    });
  });

  it('reads a saved theme and defaults legacy layouts to dark', () => {
    expect(editorStateFromLayout({ version: 1, boards: [] }).theme).toBe('dark');
    expect(editorStateFromLayout({ version: 1, boards: [], theme: 'light' }).theme).toBe('light');
  });

  it('reads the showInstallQr toggle', () => {
    const state = editorStateFromLayout({
      version: 1,
      boards: [{ boardUuid: boardA }],
      leaderboard: null,
      showInstallQr: true,
    });
    expect(state.showInstallQr).toBe(true);
  });
});

describe('addBoardSlot', () => {
  it('appends in slot order', () => {
    const state = addBoardSlot(stateWith([boardA]), boardB);
    expect(state.boardUuids).toEqual([boardA, boardB]);
  });

  it('ignores a board already assigned (dedupe)', () => {
    const initial = stateWith([boardA, boardB]);
    expect(addBoardSlot(initial, boardA)).toBe(initial);
  });

  it('refuses to grow past MAX_KIOSK_BOARDS', () => {
    const full = stateWith([boardA, boardB, boardC, boardD]);
    expect(full.boardUuids).toHaveLength(MAX_KIOSK_BOARDS);
    expect(addBoardSlot(full, boardE)).toBe(full);
  });
});

describe('setSlotBoard', () => {
  it('replaces the slot in place', () => {
    const state = setSlotBoard(stateWith([boardA, boardB]), 1, boardC);
    expect(state.boardUuids).toEqual([boardA, boardC]);
  });

  it('rejects a swap that would duplicate another slot', () => {
    const initial = stateWith([boardA, boardB]);
    expect(setSlotBoard(initial, 1, boardA)).toBe(initial);
  });

  it('widens a leaderboard scoped to the replaced board', () => {
    const initial = stateWith([boardA, boardB], { boardUuid: boardB, period: 'session' });
    const state = setSlotBoard(initial, 1, boardC);
    expect(state.leaderboard).toEqual({ boardUuid: null, period: 'session' });
  });

  it('keeps a leaderboard scoped to an untouched board', () => {
    const initial = stateWith([boardA, boardB], { boardUuid: boardA, period: 'day' });
    const state = setSlotBoard(initial, 1, boardC);
    expect(state.leaderboard).toEqual({ boardUuid: boardA, period: 'day' });
  });

  it('is a no-op out of range', () => {
    const initial = stateWith([boardA]);
    expect(setSlotBoard(initial, 3, boardB)).toBe(initial);
  });
});

describe('moveBoardSlot', () => {
  it('swaps with the neighbour in the given direction', () => {
    expect(moveBoardSlot(stateWith([boardA, boardB, boardC]), 2, -1).boardUuids).toEqual([boardA, boardC, boardB]);
    expect(moveBoardSlot(stateWith([boardA, boardB, boardC]), 0, 1).boardUuids).toEqual([boardB, boardA, boardC]);
  });

  it('is a no-op at the edges', () => {
    const initial = stateWith([boardA, boardB]);
    expect(moveBoardSlot(initial, 0, -1)).toBe(initial);
    expect(moveBoardSlot(initial, 1, 1)).toBe(initial);
  });
});

describe('removeBoardSlot', () => {
  it('drops the slot and keeps order', () => {
    const state = removeBoardSlot(stateWith([boardA, boardB, boardC]), 1);
    expect(state.boardUuids).toEqual([boardA, boardC]);
  });

  it('widens a leaderboard scoped to the removed board', () => {
    const initial = stateWith([boardA, boardB], { boardUuid: boardB, period: 'month' });
    const state = removeBoardSlot(initial, 1);
    expect(state.leaderboard).toEqual({ boardUuid: null, period: 'month' });
  });

  it('turns the rail off when the last board goes (editor invariant)', () => {
    const initial = stateWith([boardA], { boardUuid: null, period: 'session' });
    const state = removeBoardSlot(initial, 0);
    expect(state).toEqual({ boardUuids: [], leaderboard: null, showInstallQr: false, theme: 'dark' });
  });

  it('preserves the install-QR toggle when the last board goes', () => {
    const initial = stateWith([boardA], { boardUuid: null, period: 'session' }, true);
    expect(removeBoardSlot(initial, 0).showInstallQr).toBe(true);
  });
});

describe('leaderboard transitions', () => {
  it('enables with the session default scoped to all boards', () => {
    const state = setLeaderboardEnabled(stateWith([boardA]), true);
    expect(state.leaderboard).toEqual({ boardUuid: null, period: 'session' });
  });

  it('refuses to enable with zero boards', () => {
    const initial = stateWith([]);
    expect(setLeaderboardEnabled(initial, true)).toBe(initial);
  });

  it('disables to null', () => {
    const initial = stateWith([boardA], { boardUuid: boardA, period: 'week' });
    expect(setLeaderboardEnabled(initial, false).leaderboard).toBeNull();
  });

  it('only scopes to an assigned board', () => {
    const initial = stateWith([boardA], { boardUuid: null, period: 'session' });
    expect(setLeaderboardScope(initial, boardB)).toBe(initial);
    expect(setLeaderboardScope(initial, boardA).leaderboard?.boardUuid).toBe(boardA);
    expect(setLeaderboardScope(setLeaderboardScope(initial, boardA), null).leaderboard?.boardUuid).toBeNull();
  });

  it('sets the period only while the rail is on', () => {
    const railOff = stateWith([boardA]);
    expect(setLeaderboardPeriod(railOff, 'day')).toBe(railOff);
    const railOn = setLeaderboardEnabled(railOff, true);
    expect(setLeaderboardPeriod(railOn, 'day').leaderboard?.period).toBe('day');
  });
});

describe('serializeKioskLayout', () => {
  it('produces a layout the strict schema accepts', () => {
    const state = stateWith([boardA, boardB], { boardUuid: boardA, period: 'day' });
    const layout = serializeKioskLayout(state);
    expect(() => KioskLayoutSchema.parse(layout)).not.toThrow();
    expect(layout).toEqual({
      version: 1,
      boards: [{ boardUuid: boardA }, { boardUuid: boardB }],
      leaderboard: { boardUuid: boardA, period: 'day' },
      showInstallQr: false,
      theme: 'dark',
    });
  });

  it('serialises the install-QR toggle', () => {
    const layout = serializeKioskLayout(stateWith([boardA], null, true));
    expect(layout.showInstallQr).toBe(true);
    expect(() => KioskLayoutSchema.parse(layout)).not.toThrow();
  });

  it.each(['dark', 'light'] as const)('round-trips the %s theme through saved JSON', (theme) => {
    const state = stateWith([boardC, boardA], { boardUuid: null, period: 'month' }, true, theme);
    const saved = JSON.parse(JSON.stringify(KioskLayoutSchema.parse(serializeKioskLayout(state)))) as unknown;
    expect(editorStateFromLayout(saved)).toEqual(state);
    expect(editorStateFromLayout(serializeKioskLayout(state))).toEqual(state);
  });
});

describe('setKioskTheme', () => {
  it('changes only the theme and preserves the previous state', () => {
    const dark = stateWith([boardA], { boardUuid: boardA, period: 'week' }, true);
    const light = setKioskTheme(dark, 'light');
    expect(light.theme).toBe('light');
    expect(dark.theme).toBe('dark');
    expect(light.boardUuids).toBe(dark.boardUuids);
    expect(light.leaderboard).toBe(dark.leaderboard);
    expect(light.showInstallQr).toBe(true);
    expect(setKioskTheme(light, 'dark')).toEqual(dark);
  });

  it('returns the same state when the appearance is unchanged', () => {
    const dark = stateWith([]);
    expect(setKioskTheme(dark, 'dark')).toBe(dark);
  });

  it('can select light for an unconfigured kiosk', () => {
    expect(setKioskTheme(stateWith([]), 'light').theme).toBe('light');
  });
});

describe('setInstallQrEnabled', () => {
  it('turns the toggle on and off', () => {
    const off = stateWith([boardA]);
    const on = setInstallQrEnabled(off, true);
    expect(on.showInstallQr).toBe(true);
    expect(setInstallQrEnabled(on, false).showInstallQr).toBe(false);
  });

  it('is a no-op (same reference) when the value is unchanged', () => {
    const state = stateWith([boardA], null, true);
    expect(setInstallQrEnabled(state, true)).toBe(state);
  });

  it('is independent of board count and the rail', () => {
    // No boards, no rail — still togglable (QR is per-board, not per-slot).
    const empty = stateWith([]);
    expect(setInstallQrEnabled(empty, true).showInstallQr).toBe(true);
  });
});

describe('editorStatesEqual', () => {
  it('marks a theme-only edit dirty and becomes clean when reverted', () => {
    for (const dark of [stateWith([]), stateWith([boardA], { boardUuid: boardA, period: 'week' })]) {
      const light = setKioskTheme(dark, 'light');
      expect(editorStatesEqual(dark, light)).toBe(false);
      expect(editorStatesEqual(dark, setKioskTheme(light, 'dark'))).toBe(true);
    }
  });

  it('drives the dirty flag structurally', () => {
    const first = stateWith([boardA], { boardUuid: null, period: 'session' });
    const second = stateWith([boardA], { boardUuid: null, period: 'session' });
    expect(editorStatesEqual(first, second)).toBe(true);
    expect(editorStatesEqual(first, stateWith([boardA]))).toBe(false);
    expect(editorStatesEqual(first, stateWith([boardA], { boardUuid: null, period: 'day' }))).toBe(false);
    expect(editorStatesEqual(first, stateWith([boardB], { boardUuid: null, period: 'session' }))).toBe(false);
  });

  it('treats a changed install-QR toggle as dirty', () => {
    const off = stateWith([boardA], { boardUuid: null, period: 'session' }, false);
    const on = stateWith([boardA], { boardUuid: null, period: 'session' }, true);
    expect(editorStatesEqual(off, on)).toBe(false);
  });
});
