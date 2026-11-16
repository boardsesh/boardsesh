// What sits at the top of the board picker, above Your boards. Pure, so every
// scan phase and every mix of rows is a table row in the tests; the screen
// fetches the gym's roster and InRangeSection draws the answer.
//
// The scan only works out which gym the climber is at. It no longer ranks
// boards by signal, and nothing is "closest":
// - Named boards heard: the gym most of them belong to. A tie goes to the gym
//   of the board you're on when it is one of the tied, else to the tied gym
//   with the strongest signal (the rows arrive strongest first). At {gym} then
//   lists that gym's whole roster in a fixed order, A to Z by the name the row
//   shows, with the board you're on in place and marked selected.
// - Exactly one named board heard, which is not the board you're on and not at
//   its gym: that board alone, with Climb here (the hero), and no At {gym}.
// - Nothing named heard: the gym of the board you're on, when it has one.
// - Only boxes it cannot name heard (a MoonBoard, a bare `Kilter Board`, a
//   serial nobody saved) and no gym known: the box's card with its three ways
//   forward. Once a gym is known they are ignored.
// - Nothing heard and no gym: nothing at the top, so Your boards leads. There
//   is no "No boards in range" line.
//
// The scan's own states (asking for Bluetooth, Bluetooth off or refused, a tap
// to scan, serials it could not look up) are a notice drawn above whatever
// leads, so the gym of the board you're on still shows when the scan waits for
// a tap (the `picker-auto-scan-kill` switch) or cannot run at all.
//
// The board you're on shows once on the whole screen: Your boards and Near you
// leave out every board the top lists (`pickerTopBoardUuids`).

import type { UserBoard } from '@boardsesh/shared-schema';
import { stripGymNamePrefix } from '@boardsesh/board-config';
import { boardRowKeys, boardUuidOrNull } from '../../lib/boards/board-identity';
import type { BoardPickSection, BoardPickSource } from '../../lib/boards/use-activate-board';
import type { PickerScanPhase } from './picker-scan-phase';
import type { QuickstartLookupState, QuickstartRow } from './quickstart-scan-rows';

/** A row the picker can name: a saved board, by serial or by this phone's recognition. */
export type InRangeBoardRow = Extract<QuickstartRow, { kind: 'board' }>;

/** A board the picker heard but cannot name. */
export type UnnamedInRangeRow = Extract<QuickstartRow, { kind: 'moonboard' | 'bare_name' | 'unknown_setup' }>;

/** Where At {gym}'s gym came from: what the scan heard, or the board you're on. */
export type AtGymSource = 'scan' | 'active_board';

/** The scan's own card or line, drawn above whatever leads the top. */
export type PickerScanNotice =
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
  /**
   * Serials heard that the lookup could not name (no signal). Beside boards
   * the scan did name (`besideHeardBoards`) it is one compact line under them;
   * otherwise the "need signal" card with Retry.
   */
  | { kind: 'lookup_failed'; besideHeardBoards: boolean };

/** One board the top lists. */
export type PickerTopBoard = {
  /** Unique within the top: the uuid, or serial and config for a hidden board found by serial (#6552). */
  key: string;
  board: UserBoard;
  /** The name the row shows. Under At {gym} the gym prefix is gone ("Crux - Cave" reads "Cave"). */
  title: string;
  /** The board you're on. */
  selected: boolean;
};

/** What leads the top. `Board` is a `PickerTopBoard` here and a card item in the view. */
export type PickerTopContent<Board> =
  /** Nothing: Your boards leads. */
  | { kind: 'none' }
  /** Scanning with no gym known yet: the placeholder that holds the slot. */
  | { kind: 'looking' }
  /** The gym's roster, A to Z, the board you're on in place. */
  | { kind: 'at_gym'; gymUuid: string; gymName: string; source: AtGymSource; rows: readonly Board[] }
  /** One named board somewhere other than the board you're on, with Climb here. */
  | { kind: 'hero'; board: Board }
  /** A box it cannot name, with no gym known: its three ways forward. */
  | { kind: 'unnamed'; row: UnnamedInRangeRow };

export type PickerTopView<Board> = {
  notice: PickerScanNotice | null;
  content: PickerTopContent<Board>;
  /** The scan is still listening: a small spinner by the title. */
  scanning: boolean;
  /**
   * The scan ran to its end and heard nothing. Draws nothing by itself; it is
   * when Android may be hiding the results, so the location hint can show.
   */
  heardNothing: boolean;
};

type GymRef = { gymUuid: string; gymName: string };

/** What leads, before the gym's roster is known. */
export type PickerTopLead =
  | { kind: 'none' }
  | { kind: 'looking' }
  | (GymRef & {
      kind: 'at_gym';
      source: AtGymSource;
      /** The boards the scan named at this gym, so the rows never wait on the roster. */
      heardBoards: readonly UserBoard[];
    })
  | { kind: 'hero'; board: UserBoard }
  | { kind: 'unnamed'; row: UnnamedInRangeRow };

/** The first step: everything but the roster, which needs `pickerTopGymUuid` to fetch. */
export type PickerTopDecision = Omit<PickerTopView<never>, 'content'> & {
  lead: PickerTopLead;
  activeBoard: UserBoard | null;
};

export type PickerTopInputs = {
  phase: PickerScanPhase;
  /** The scan's rows, strongest signal first (`buildQuickstartRows`). */
  rows: readonly QuickstartRow[];
  lookup: QuickstartLookupState;
  /** The board you're on: null for none, undefined while it is still being read. */
  activeBoard: UserBoard | null | undefined;
};

const NONE: PickerTopLead = { kind: 'none' };
const LOOKING: PickerTopLead = { kind: 'looking' };

/** A board's gym, when it has both an id and a name to put in "At {gym}". */
function gymOf(board: UserBoard): GymRef | null {
  return board.gymUuid && board.gymName ? { gymUuid: board.gymUuid, gymName: board.gymName } : null;
}

/**
 * Whether two boards are the same board. A hidden board found by serial has
 * no uuid (#6375), so it compares on its serial instead.
 */
function isSameBoard(first: UserBoard, second: UserBoard): boolean {
  const firstUuid = boardUuidOrNull(first.uuid);
  const secondUuid = boardUuidOrNull(second.uuid);
  if (firstUuid !== null && secondUuid !== null) return firstUuid === secondUuid;
  return Boolean(first.serialNumber) && first.serialNumber === second.serialNumber;
}

function isBoardRow(row: QuickstartRow): row is InRangeBoardRow {
  return row.kind === 'board';
}

function isUnnamedRow(row: QuickstartRow): row is UnnamedInRangeRow {
  return row.kind === 'moonboard' || row.kind === 'bare_name' || row.kind === 'unknown_setup';
}

/**
 * The gym most of the named boards belong to. A tie goes to the gym of the
 * board you're on when it is one of the tied, else to the tied gym heard
 * first, which is the strongest signal. Null when no named board has a gym.
 */
export function gymMostHeard(named: readonly InRangeBoardRow[], activeGym: GymRef | null): GymRef | null {
  const tallies = new Map<string, { gym: GymRef; count: number; firstHeard: number }>();
  named.forEach((row, index) => {
    const gym = gymOf(row.board);
    if (!gym) return;
    const tally = tallies.get(gym.gymUuid);
    if (tally) tally.count += 1;
    else tallies.set(gym.gymUuid, { gym, count: 1, firstHeard: index });
  });
  let tied: { gym: GymRef; count: number; firstHeard: number }[] = [];
  for (const tally of tallies.values()) {
    if (tied.length === 0 || tally.count > (tied[0]?.count ?? 0)) tied = [tally];
    else if (tally.count === tied[0]?.count) tied.push(tally);
  }
  if (tied.length === 0) return null;
  const activeTally = activeGym ? tied.find((tally) => tally.gym.gymUuid === activeGym.gymUuid) : undefined;
  if (activeTally) return activeTally.gym;
  return tied.reduce((strongest, tally) => (tally.firstHeard < strongest.firstHeard ? tally : strongest)).gym;
}

/** What the named boards lead with: the hero, the gym they point at, or nothing they can decide. */
function leadFromNamed(
  named: readonly InRangeBoardRow[],
  activeBoard: UserBoard | null,
  activeGym: GymRef | null,
): PickerTopLead | null {
  const [only] = named;
  if (only === undefined) return null;
  if (named.length === 1) {
    const onIt = activeBoard !== null && isSameBoard(only.board, activeBoard);
    const atItsGym = activeGym !== null && gymOf(only.board)?.gymUuid === activeGym.gymUuid;
    if (!onIt && !atItsGym) return { kind: 'hero', board: only.board };
  }
  const gym = gymMostHeard(named, activeGym);
  if (!gym) return null;
  return {
    kind: 'at_gym',
    ...gym,
    source: 'scan',
    heardBoards: named.filter((row) => gymOf(row.board)?.gymUuid === gym.gymUuid).map((row) => row.board),
  };
}

/** Which notice the scan shows for a phase that does not listen. */
function noticeForIdlePhase(phase: Exclude<PickerScanPhase, 'scanning' | 'done'>): PickerScanNotice | null {
  switch (phase) {
    case 'hidden':
      return null;
    case 'needs_permission':
      return { kind: 'permission_card' };
    case 'blocked_denied':
      return { kind: 'blocked_denied' };
    case 'blocked_off':
      return { kind: 'blocked_off' };
    case 'unreachable':
      return { kind: 'unreachable' };
    case 'tap_to_scan':
      return { kind: 'tap_to_scan' };
  }
}

export function decidePickerTop({ phase, rows, lookup, activeBoard }: PickerTopInputs): PickerTopDecision {
  const active = activeBoard ?? null;
  const activeGym = active ? gymOf(active) : null;
  const fromActiveBoard: PickerTopLead | null = activeGym
    ? { kind: 'at_gym', ...activeGym, source: 'active_board', heardBoards: [] }
    : null;

  if (phase !== 'scanning' && phase !== 'done') {
    // The scan is not listening: whatever it heard before says nothing now.
    return {
      notice: noticeForIdlePhase(phase),
      lead: fromActiveBoard ?? NONE,
      scanning: false,
      heardNothing: false,
      activeBoard: active,
    };
  }

  const scanning = phase === 'scanning';
  // While the scan's first serial lookup is out, the boards it names are held
  // back and the answer could point at another gym, so nothing heard counts
  // yet: the board you're on's gym, or the placeholder.
  const heard = lookup === 'pending' ? [] : rows;
  const named = heard.filter(isBoardRow);
  const firstUnnamed = heard.find(isUnnamedRow);
  const lookupFailed = heard.some((row) => row.kind === 'lookup_failed');

  let lead: PickerTopLead =
    leadFromNamed(named, active, activeGym) ??
    fromActiveBoard ??
    (named.length === 0 && firstUnnamed ? { kind: 'unnamed', row: firstUnnamed } : null) ??
    (scanning ? LOOKING : NONE);

  const besideHeardBoards = lead.kind === 'hero' || (lead.kind === 'at_gym' && lead.source === 'scan');
  const notice: PickerScanNotice | null = lookupFailed ? { kind: 'lookup_failed', besideHeardBoards } : null;
  // The need-signal card already holds the slot; a placeholder under it would
  // say the opposite.
  if (lead.kind === 'looking' && notice !== null) lead = NONE;

  return {
    notice,
    lead,
    scanning,
    heardNothing: phase === 'done' && rows.length === 0,
    activeBoard: active,
  };
}

/** The gym whose roster the top needs (`useGymBoards`), or null when it lists no gym. */
export function pickerTopGymUuid(decision: PickerTopDecision): string | null {
  return decision.lead.kind === 'at_gym' ? decision.lead.gymUuid : null;
}

/** Order for At {gym}: A to Z by the shown name, numbers in number order ("Wall 2" before "Wall 10"). */
function compareRows(first: PickerTopBoard, second: PickerTopBoard): number {
  const byTitle = first.title.localeCompare(second.title, undefined, { numeric: true, sensitivity: 'base' });
  if (byTitle !== 0) return byTitle;
  if (first.key === second.key) return 0;
  return first.key < second.key ? -1 : 1;
}

/**
 * At {gym}'s rows: the board you're on, the boards the scan named there and
 * the gym's roster, once each, A to Z. The first two never wait on the roster,
 * so the section has rows while it loads. Where one board comes from more than
 * one of them, the board you're on wins, then the scan's: those are the full
 * boards, where the roster is a narrower read (`GymBoardForSwitcher`).
 */
function atGymRows(
  lead: Extract<PickerTopLead, { kind: 'at_gym' }>,
  gymRoster: readonly UserBoard[] | undefined,
  activeBoard: UserBoard | null,
): PickerTopBoard[] {
  const isAtGym = (board: UserBoard) => board.gymUuid === lead.gymUuid;
  const boards: UserBoard[] = [];
  const add = (board: UserBoard) => {
    if (!isAtGym(board) || boards.some((listed) => isSameBoard(listed, board))) return;
    boards.push(board);
  };
  if (activeBoard) add(activeBoard);
  for (const board of lead.heardBoards) add(board);
  // Filtered by gym as well: a roster still cached for another gym is not this one's.
  for (const board of gymRoster ?? []) add(board);
  const keys = boardRowKeys(boards);
  return boards
    .map((board, index) => ({
      key: keys[index] ?? board.uuid,
      board,
      title: stripGymNamePrefix(board.name, lead.gymName),
      selected: activeBoard !== null && isSameBoard(board, activeBoard),
    }))
    .sort(compareRows);
}

/**
 * The second step: the top with its rows, once `useGymBoards` has (or has not
 * yet) answered for `pickerTopGymUuid(decision)`.
 */
export function buildPickerTopView(
  decision: PickerTopDecision,
  gymRoster: readonly UserBoard[] | undefined,
): PickerTopView<PickerTopBoard> {
  const { notice, scanning, heardNothing, lead, activeBoard } = decision;
  let content: PickerTopContent<PickerTopBoard>;
  switch (lead.kind) {
    case 'at_gym':
      content = {
        kind: 'at_gym',
        gymUuid: lead.gymUuid,
        gymName: lead.gymName,
        source: lead.source,
        rows: atGymRows(lead, gymRoster, activeBoard),
      };
      break;
    case 'hero': {
      const [key = lead.board.uuid] = boardRowKeys([lead.board]);
      content = { kind: 'hero', board: { key, board: lead.board, title: lead.board.name, selected: false } };
      break;
    }
    default:
      content = lead;
  }
  return { notice, content, scanning, heardNothing };
}

/** Both steps at once, for callers that already hold the roster (tests, stories). */
export function pickerTopView(
  inputs: PickerTopInputs,
  gymRoster?: readonly UserBoard[],
): PickerTopView<PickerTopBoard> {
  return buildPickerTopView(decidePickerTop(inputs), gymRoster);
}

/** The boards the top lists, so Your boards and Near you can leave them out. */
export function pickerTopBoards<Board>(content: PickerTopContent<Board>): readonly Board[] {
  switch (content.kind) {
    case 'at_gym':
      return content.rows;
    case 'hero':
      return [content.board];
    default:
      return [];
  }
}

/** The uuids of the boards the top lists. A hidden board found by serial has none, and is no saved board. */
export function pickerTopBoardUuids(view: PickerTopView<PickerTopBoard>): ReadonlySet<string> {
  const uuids = new Set<string>();
  for (const row of pickerTopBoards(view.content)) {
    const uuid = boardUuidOrNull(row.board.uuid);
    if (uuid !== null) uuids.add(uuid);
  }
  return uuids;
}

/** How a pick from the top is reported (`Board Picker Selection Completed`). */
export type PickerTopPick = {
  board: UserBoard;
  /** 'bluetooth' when the scan put the board here, 'gym_walls' when the board you're on did. */
  pickSource: Extract<BoardPickSource, 'bluetooth' | 'gym_walls'>;
  section: Extract<BoardPickSection, 'at_gym' | 'hero'>;
  /** 0-based, in the section's own order. */
  position: number;
};

/** Each board the top lists, by key, with how a pick of it is reported. */
export function pickerTopPicks(view: PickerTopView<PickerTopBoard>): ReadonlyMap<string, PickerTopPick> {
  const picks = new Map<string, PickerTopPick>();
  const { content } = view;
  if (content.kind === 'hero') {
    picks.set(content.board.key, { board: content.board.board, pickSource: 'bluetooth', section: 'hero', position: 0 });
  } else if (content.kind === 'at_gym') {
    const pickSource = content.source === 'scan' ? 'bluetooth' : 'gym_walls';
    content.rows.forEach((row, position) => {
      picks.set(row.key, { board: row.board, pickSource, section: 'at_gym', position });
    });
  }
  return picks;
}

/** The same top with each board swapped for what the view draws. */
export function mapPickerTopBoards<From, To>(
  view: PickerTopView<From>,
  mapBoards: (boards: readonly From[], kind: 'at_gym' | 'hero') => To[],
): PickerTopView<To> {
  const { content } = view;
  switch (content.kind) {
    case 'at_gym':
      return { ...view, content: { ...content, rows: mapBoards(content.rows, 'at_gym') } };
    case 'hero': {
      const [board] = mapBoards([content.board], 'hero');
      return { ...view, content: board === undefined ? { kind: 'none' } : { kind: 'hero', board } };
    }
    default:
      return { ...view, content };
  }
}

/** Rows At {gym} shows before Show all. */
export const AT_GYM_COLLAPSED_ROW_COUNT = 4;

/**
 * The rows a long At {gym} shows before Show all. The picker's ScrollView
 * cannot hold a virtualised list, and a big gym has a dozen walls. Never
 * collapses to hide a single row, and always keeps the selected row, which
 * Your boards no longer lists: past the cut it replaces the last row shown, so
 * the rows that show keep their order.
 */
export function collapsedAtGymRows<Row>(
  rows: readonly Row[],
  isSelected: (row: Row) => boolean,
  limit: number = AT_GYM_COLLAPSED_ROW_COUNT,
): readonly Row[] {
  if (rows.length <= limit + 1) return rows;
  const head = rows.slice(0, limit);
  if (head.some(isSelected)) return head;
  const selected = rows.find(isSelected);
  return selected === undefined ? head : [...rows.slice(0, limit - 1), selected];
}
