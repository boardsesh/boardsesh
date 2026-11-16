// What the board picker's In range slot shows, from the scan's phase and rows
// (use-picker-board-scan.ts). Pure, so every phase and every mix of rows is a
// table row in the tests; InRangeSection.tsx only draws the answer.
//
// The rows arrive strongest signal first (buildQuickstartRows), so "closest"
// below is the first row of its kind.
//
// - One board the picker can name: the hero card, with Climb here.
// - Two or more it can name: a row each, closest first with a Closest pill, and
//   no single Climb here. The caption names their gym when they share one.
// - None it can name, but a box it heard (a MoonBoard, a bare `Kilter Board`, a
//   serial nobody saved): the closest one, with its three ways forward.
// - Serials heard but not looked up (no signal): the "need signal" retry.
// - A scan that found nothing: one quiet line and Scan again. A scan another
//   scan pre-empted (the rest timer, a connect) also ends here, so it is never
//   a final verdict: Scan again is always beside it.

import type { UserBoard } from '@boardsesh/shared-schema';
import type { PickerScanPhase } from './picker-scan-phase';
import type { QuickstartRow } from './quickstart-scan-rows';

/** A row the picker can name: a saved board, by serial or by this phone's recognition. */
export type InRangeBoardRow = Extract<QuickstartRow, { kind: 'board' }>;

/** A board the picker heard but cannot name. */
export type UnnamedInRangeRow = Extract<QuickstartRow, { kind: 'moonboard' | 'bare_name' | 'unknown_setup' }>;

/** What the slot draws. `Board` is a board row here and a card item in the view. */
export type InRangeContent<Board> =
  /** Nothing at all: a browser, no Bluetooth LE, or a phone already on a board. */
  | { kind: 'none' }
  /** Bluetooth not allowed yet: the Continue card, which asks. */
  | { kind: 'permission_card' }
  /** Bluetooth refused for good: a line and Open Settings. */
  | { kind: 'blocked_denied' }
  /** Bluetooth off: a line and Scan again. */
  | { kind: 'blocked_off' }
  /** Ready, waiting for a tap: the Scan card. */
  | { kind: 'tap_to_scan' }
  /** Scanning with nothing heard yet: the fixed-height placeholder. */
  | { kind: 'looking' }
  /** One board it can name. */
  | { kind: 'hero'; board: Board }
  /** Two or more it can name, closest first. `gymName` when every one is at the same gym. */
  | { kind: 'board_rows'; boards: readonly Board[]; gymName: string | null }
  /** The closest board it heard but cannot name. */
  | { kind: 'unnamed'; row: UnnamedInRangeRow }
  /** Serials heard, lookup down. */
  | { kind: 'lookup_failed' }
  /** The scan ended with nothing heard. */
  | { kind: 'none_in_range' };

export type InRangeView<Board> = {
  content: InRangeContent<Board>;
  /** The spinner beside the section title: the scan is still listening. */
  scanning: boolean;
};

/** The gym every board is at, or null when one has none or two differ. */
export function sharedGymName(boards: readonly UserBoard[]): string | null {
  const [first] = boards;
  if (!first?.gymUuid || !first.gymName) return null;
  return boards.every((board) => board.gymUuid === first.gymUuid) ? first.gymName : null;
}

function contentFromRows(rows: readonly QuickstartRow[]): InRangeContent<InRangeBoardRow> | null {
  const boardRows = rows.filter((row): row is InRangeBoardRow => row.kind === 'board');
  if (boardRows.length === 1) return { kind: 'hero', board: boardRows[0] };
  if (boardRows.length > 1) {
    return {
      kind: 'board_rows',
      boards: boardRows,
      gymName: sharedGymName(boardRows.map((row) => row.board)),
    };
  }
  // Nothing it can name: the closest thing it heard decides.
  const [closest] = rows;
  if (!closest) return null;
  if (closest.kind === 'lookup_failed') return { kind: 'lookup_failed' };
  if (closest.kind === 'board') return null;
  return { kind: 'unnamed', row: closest };
}

export function inRangeView(phase: PickerScanPhase, rows: readonly QuickstartRow[]): InRangeView<InRangeBoardRow> {
  switch (phase) {
    case 'hidden':
      return { content: { kind: 'none' }, scanning: false };
    case 'needs_permission':
      return { content: { kind: 'permission_card' }, scanning: false };
    case 'blocked_denied':
      return { content: { kind: 'blocked_denied' }, scanning: false };
    case 'blocked_off':
      return { content: { kind: 'blocked_off' }, scanning: false };
    case 'tap_to_scan':
      return { content: { kind: 'tap_to_scan' }, scanning: false };
    case 'scanning':
      return { content: contentFromRows(rows) ?? { kind: 'looking' }, scanning: true };
    case 'done':
      return { content: contentFromRows(rows) ?? { kind: 'none_in_range' }, scanning: false };
  }
}

/** The same content with each board row swapped for what the view draws. */
export function mapInRangeBoards<From, To>(
  content: InRangeContent<From>,
  mapBoards: (boards: readonly From[]) => To[],
): InRangeContent<To> {
  switch (content.kind) {
    case 'hero': {
      const [board] = mapBoards([content.board]);
      return board === undefined ? { kind: 'none_in_range' } : { kind: 'hero', board };
    }
    case 'board_rows':
      return { kind: 'board_rows', boards: mapBoards(content.boards), gymName: content.gymName };
    default:
      return content;
  }
}

/**
 * The board "Also at {gym}" lists the other walls of: the one board in range,
 * else the board the climber is on. None while several boards are in range
 * (their rows already are the gym's walls), and none for a board with no gym.
 * Nothing connects from the rows without a tap.
 */
export function alsoAtGymAnchor(
  content: InRangeContent<InRangeBoardRow>,
  activeBoard: UserBoard | null | undefined,
): UserBoard | null {
  if (content.kind === 'board_rows') return null;
  const anchor = content.kind === 'hero' ? content.board.board : activeBoard;
  return anchor?.gymUuid ? anchor : null;
}
