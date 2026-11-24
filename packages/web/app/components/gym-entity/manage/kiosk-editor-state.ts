// Pure state model for the kiosk editor. Every transition the editor UI can
// perform lives here so the invariants are unit-testable without React:
//
//  - at most MAX_KIOSK_BOARDS slots, no duplicate boards (slot = array order);
//  - the leaderboard rail can only be enabled while at least one board is
//    assigned (the strict schema ALLOWS a rail with zero boards — the renderer
//    shows an empty rail — but the editor prevents building that state, per
//    the plan's design notes);
//  - a single-board leaderboard scope always points at an assigned board;
//    removing or swapping that board widens the scope to all boards rather
//    than leaving a dangling reference.
//
// Serialisation goes back through the strict `KioskLayoutSchema` before the
// save mutation, so these invariants are enforced twice: here for inline UX,
// and there as the write-time gate the backend shares.

import {
  KIOSK_DEFAULT_LEADERBOARD_PERIOD,
  KIOSK_LAYOUT_VERSION,
  MAX_KIOSK_BOARDS,
  parseKioskLayoutLenient,
  type KioskLayout,
  type KioskLeaderboardPeriod,
  type KioskTheme,
} from '@boardsesh/kiosk';

export type KioskEditorLeaderboard = {
  /** Scope: a single assigned board's uuid, or null for every kiosk board. */
  boardUuid: string | null;
  period: KioskLeaderboardPeriod;
};

export type KioskEditorState = {
  /** Assigned board uuids in slot (on-screen) order. Deduped, ≤ MAX_KIOSK_BOARDS. */
  boardUuids: string[];
  /** Leaderboard rail config, or null when the rail is off. */
  leaderboard: KioskEditorLeaderboard | null;
  /** When true, every board on the kiosk renders its own install-Boardsesh QR. */
  showInstallQr: boolean;
  /** Explicit appearance for this kiosk, independent of the editor's OS theme. */
  theme: KioskTheme;
};

/**
 * Build the editor's initial state from a persisted `layout` JSON scalar.
 * Lenient parse: corrupt slots are dropped rather than crashing the editor,
 * matching what the TV would actually render.
 */
export function editorStateFromLayout(layout: unknown): KioskEditorState {
  const { layout: parsed } = parseKioskLayoutLenient(layout);
  return {
    boardUuids: parsed.boards.map((slot) => slot.boardUuid),
    leaderboard: parsed.leaderboard === null ? null : { ...parsed.leaderboard },
    showInstallQr: parsed.showInstallQr,
    theme: parsed.theme,
  };
}

/** Append a board slot. No-op when the board is already assigned or the kiosk is full. */
export function addBoardSlot(state: KioskEditorState, boardUuid: string): KioskEditorState {
  if (state.boardUuids.length >= MAX_KIOSK_BOARDS || state.boardUuids.includes(boardUuid)) {
    return state;
  }
  return { ...state, boardUuids: [...state.boardUuids, boardUuid] };
}

/**
 * Replace the board in slot `index`. No-op when the index is out of range or
 * the new board already occupies another slot. A leaderboard scoped to the
 * replaced board widens to all boards (the old board is no longer on screen).
 */
export function setSlotBoard(state: KioskEditorState, index: number, boardUuid: string): KioskEditorState {
  if (index < 0 || index >= state.boardUuids.length) return state;
  const previousUuid = state.boardUuids[index];
  if (previousUuid === boardUuid) return state;
  if (state.boardUuids.includes(boardUuid)) return state;

  const boardUuids = state.boardUuids.slice();
  boardUuids[index] = boardUuid;
  return {
    ...state,
    boardUuids,
    leaderboard: widenScopeIfDangling(state.leaderboard, boardUuids),
  };
}

/**
 * Move slot `index` one position up (-1) or down (+1). Slot order is on-screen
 * order, so this is the whole reorder story. No-op at the edges.
 */
export function moveBoardSlot(state: KioskEditorState, index: number, direction: -1 | 1): KioskEditorState {
  const targetIndex = index + direction;
  if (index < 0 || index >= state.boardUuids.length) return state;
  if (targetIndex < 0 || targetIndex >= state.boardUuids.length) return state;

  const boardUuids = state.boardUuids.slice();
  [boardUuids[index], boardUuids[targetIndex]] = [boardUuids[targetIndex], boardUuids[index]];
  return { ...state, boardUuids };
}

/**
 * Remove slot `index`. A leaderboard scoped to the removed board widens to all
 * boards; removing the LAST board turns the rail off entirely (the editor
 * never leaves a rail enabled with zero boards).
 */
export function removeBoardSlot(state: KioskEditorState, index: number): KioskEditorState {
  if (index < 0 || index >= state.boardUuids.length) return state;
  const boardUuids = state.boardUuids.filter((_, slotIndex) => slotIndex !== index);
  if (boardUuids.length === 0) {
    return { ...state, boardUuids, leaderboard: null };
  }
  return {
    ...state,
    boardUuids,
    leaderboard: widenScopeIfDangling(state.leaderboard, boardUuids),
  };
}

/**
 * Toggle the leaderboard rail. Enabling with zero boards is a no-op — the
 * Switch is disabled in that state, and this guard keeps the invariant even if
 * the UI slips. A freshly enabled rail defaults to all boards + the live
 * session ranking.
 */
export function setLeaderboardEnabled(state: KioskEditorState, enabled: boolean): KioskEditorState {
  if (!enabled) {
    return state.leaderboard === null ? state : { ...state, leaderboard: null };
  }
  if (state.leaderboard !== null) return state;
  if (state.boardUuids.length === 0) return state;
  return { ...state, leaderboard: { boardUuid: null, period: KIOSK_DEFAULT_LEADERBOARD_PERIOD } };
}

/** Scope the rail to one assigned board (uuid) or all boards (null). No-op when the rail is off or the board isn't assigned. */
export function setLeaderboardScope(state: KioskEditorState, boardUuid: string | null): KioskEditorState {
  if (state.leaderboard === null) return state;
  if (boardUuid !== null && !state.boardUuids.includes(boardUuid)) return state;
  return { ...state, leaderboard: { ...state.leaderboard, boardUuid } };
}

/** Set the rail's ranking window. No-op when the rail is off. */
export function setLeaderboardPeriod(state: KioskEditorState, period: KioskLeaderboardPeriod): KioskEditorState {
  if (state.leaderboard === null) return state;
  return { ...state, leaderboard: { ...state.leaderboard, period } };
}

/** Toggle the per-board install QR. Independent of board count and the rail. */
export function setInstallQrEnabled(state: KioskEditorState, enabled: boolean): KioskEditorState {
  if (state.showInstallQr === enabled) return state;
  return { ...state, showInstallQr: enabled };
}

/** Change this kiosk's appearance without touching its boards or leaderboard. */
export function setKioskTheme(state: KioskEditorState, theme: KioskTheme): KioskEditorState {
  if (state.theme === theme) return state;
  return { ...state, theme };
}

/** Serialise editor state to the wire/storage `KioskLayout` shape. */
export function serializeKioskLayout(state: KioskEditorState): KioskLayout {
  return {
    version: KIOSK_LAYOUT_VERSION,
    boards: state.boardUuids.map((boardUuid) => ({ boardUuid })),
    leaderboard: state.leaderboard === null ? null : { ...state.leaderboard },
    showInstallQr: state.showInstallQr,
    theme: state.theme,
  };
}

/** Structural equality — drives the editor's dirty flag. */
export function editorStatesEqual(first: KioskEditorState, second: KioskEditorState): boolean {
  if (first.boardUuids.length !== second.boardUuids.length) return false;
  if (first.boardUuids.some((uuid, index) => uuid !== second.boardUuids[index])) return false;
  if (first.showInstallQr !== second.showInstallQr) return false;
  if (first.theme !== second.theme) return false;
  if (first.leaderboard === null || second.leaderboard === null) {
    return first.leaderboard === second.leaderboard;
  }
  return (
    first.leaderboard.boardUuid === second.leaderboard.boardUuid &&
    first.leaderboard.period === second.leaderboard.period
  );
}

function widenScopeIfDangling(
  leaderboard: KioskEditorLeaderboard | null,
  boardUuids: string[],
): KioskEditorLeaderboard | null {
  if (leaderboard === null || leaderboard.boardUuid === null) return leaderboard;
  if (boardUuids.includes(leaderboard.boardUuid)) return leaderboard;
  return { ...leaderboard, boardUuid: null };
}
