// What the board picker's In range slot shows, from the scan's phase and rows
// (use-picker-board-scan.ts). Pure, so every phase and every mix of rows is a
// table row in the tests; InRangeSection.tsx only draws the answer.
//
// The rows arrive strongest signal first (buildQuickstartRows), and the slot
// keeps that order: the strongest row leads, and only the lead says "In front
// of you".
//
// - A board the picker can name leads: the hero card with Climb here, or, with
//   two or more named boards, a row each with a Closest pill on the first and
//   no single Climb here (the caption names their gym when they share one).
//   A box it can't name heard as well shows as one compact row under them ("A
//   MoonBoard is also in range"), with its three ways forward behind a tap.
// - A box it can't name leads (a MoonBoard, a bare `Kilter Board`, a serial
//   nobody saved): its card, with its three ways forward, and any named boards
//   follow as rows. A MoonBoard beside a saved Kilter is not the Kilter.
// - Serials heard but not looked up (no signal) lead: the "need signal" retry,
//   named boards following.
// - While the serial lookup is out, the serial rows are held back, so a lead
//   drawn now could be overtaken when the answer lands: the slot holds its
//   place with the fixed-height "Looking for boards" card instead.
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

/** What else is in range, under a named lead, as one compact row. */
export type InRangeAlso =
  /** A box it can't name: the three ways forward open from the row. */
  | { kind: 'unnamed'; row: UnnamedInRangeRow }
  /** Serials it couldn't look up: Retry. */
  | { kind: 'lookup_failed' };

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
  /** Bluetooth could not be reached for a reason the scan could not read: a line and Scan again. */
  | { kind: 'unreachable' }
  /** Ready, waiting for a tap: the Scan card. */
  | { kind: 'tap_to_scan' }
  /** Nothing to lead with yet (or the lookup is out): the fixed-height placeholder. */
  | { kind: 'looking' }
  /** One named board leads, and is the only one. */
  | { kind: 'hero'; board: Board; also: InRangeAlso | null }
  /** Two or more named boards, closest first. `gymName` when every one is at the same gym. */
  | { kind: 'board_rows'; boards: readonly Board[]; gymName: string | null; also: InRangeAlso | null }
  /** A box it can't name leads; `boards` are the named boards heard behind it. */
  | { kind: 'unnamed'; row: UnnamedInRangeRow; boards: readonly Board[] }
  /** Serials it couldn't look up lead; `boards` are the named boards heard behind them. */
  | { kind: 'lookup_failed'; boards: readonly Board[] }
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

function isBoardRow(row: QuickstartRow): row is InRangeBoardRow {
  return row.kind === 'board';
}

function contentFromRows(rows: readonly QuickstartRow[]): InRangeContent<InRangeBoardRow> | null {
  const [lead] = rows;
  if (!lead) return null;
  const boardRows = rows.filter(isBoardRow);
  if (lead.kind === 'lookup_failed') return { kind: 'lookup_failed', boards: boardRows };
  if (lead.kind !== 'board') return { kind: 'unnamed', row: lead, boards: boardRows };

  // A named board leads. The closest thing it can't name, if any, is the one
  // compact row under it.
  const closestOther = rows.find((row) => !isBoardRow(row));
  const also: InRangeAlso | null =
    closestOther === undefined || isBoardRow(closestOther)
      ? null
      : closestOther.kind === 'lookup_failed'
        ? { kind: 'lookup_failed' }
        : { kind: 'unnamed', row: closestOther };
  if (boardRows.length === 1) return { kind: 'hero', board: lead, also };
  return {
    kind: 'board_rows',
    boards: boardRows,
    gymName: sharedGymName(boardRows.map((row) => row.board)),
    also,
  };
}

export function inRangeView(
  phase: PickerScanPhase,
  rows: readonly QuickstartRow[],
  { lookupPending }: { lookupPending: boolean },
): InRangeView<InRangeBoardRow> {
  switch (phase) {
    case 'hidden':
      return { content: { kind: 'none' }, scanning: false };
    case 'needs_permission':
      return { content: { kind: 'permission_card' }, scanning: false };
    case 'blocked_denied':
      return { content: { kind: 'blocked_denied' }, scanning: false };
    case 'blocked_off':
      return { content: { kind: 'blocked_off' }, scanning: false };
    case 'unreachable':
      return { content: { kind: 'unreachable' }, scanning: false };
    case 'tap_to_scan':
      return { content: { kind: 'tap_to_scan' }, scanning: false };
    case 'scanning':
      // The lookup's answer could put a stronger named board ahead of what
      // shows now, so the slot holds its height until it lands.
      if (lookupPending) return { content: { kind: 'looking' }, scanning: true };
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
      return board === undefined ? { kind: 'none_in_range' } : { kind: 'hero', board, also: content.also };
    }
    case 'board_rows':
      return {
        kind: 'board_rows',
        boards: mapBoards(content.boards),
        gymName: content.gymName,
        also: content.also,
      };
    case 'unnamed':
      return { kind: 'unnamed', row: content.row, boards: mapBoards(content.boards) };
    case 'lookup_failed':
      return { kind: 'lookup_failed', boards: mapBoards(content.boards) };
    default:
      return content;
  }
}

/**
 * The board "Also at {gym}" lists the other walls of: the one board in range,
 * else the board the climber is on. None while other named boards are in range
 * (their rows already are the walls around the climber), and none for a board
 * with no gym. Nothing connects from the rows without a tap.
 */
export function alsoAtGymAnchor(
  content: InRangeContent<InRangeBoardRow>,
  activeBoard: UserBoard | null | undefined,
): UserBoard | null {
  if (content.kind === 'board_rows') return null;
  if ((content.kind === 'unnamed' || content.kind === 'lookup_failed') && content.boards.length > 0) return null;
  const anchor = content.kind === 'hero' ? content.board.board : activeBoard;
  return anchor?.gymUuid ? anchor : null;
}
