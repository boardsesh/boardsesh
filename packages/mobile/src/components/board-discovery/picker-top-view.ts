// What sits at the top of the board picker, above Your boards. Pure, so every
// scan phase and every mix of rows is a table row in the tests; the screen
// fetches the gym's roster, holds the top steady while it scans
// (use-steady-picker-top.ts) and InRangeSection draws the answer.
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
//   Several named boards none of which is at a gym (home walls) lead with the
//   strongest the same way, unless the board you're on is among them. The
//   hero says "In front of you" only when it is the strongest signal heard.
// - Nothing named heard: the gym of the board you're on, when it has one.
// - Boxes it cannot name heard (a MoonBoard, a bare `Kilter Board`, a serial
//   nobody saved) and nothing named: the box's card with its three ways
//   forward, above At {gym} when the board you're on names the gym.
// - Nothing heard and no gym: nothing at the top, so Your boards leads. There
//   is no "No boards in range" line, and a climber on a home wall gets no
//   "Looking" placeholder: only one with no board at all does.
//
// For its first few seconds (`holdScanLead`) the scan's answer is not drawn at
// all: what a scan hears first is the box nearest the door, not the wall the
// climber stands at.
//
// The scan's own states (asking for Bluetooth, Bluetooth off or refused, a tap
// to scan, serials it could not look up) are a notice drawn above whatever
// leads, so the gym of the board you're on still shows when the scan waits for
// a tap (the `picker-auto-scan-kill` switch) or cannot run at all. Once the
// climber has said Not now to the Bluetooth card it is one line with Allow
// Bluetooth from then on, never gone: a board can't be lit without Bluetooth.
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
  /** Bluetooth not allowed yet: the Continue card, which asks, with Not now. */
  | { kind: 'permission_card' }
  /** Bluetooth not allowed yet, after Not now on the card: a line and Allow Bluetooth, which asks. */
  | { kind: 'permission_line' }
  /** Bluetooth refused for good: a line and Open Settings. */
  | { kind: 'blocked_denied' }
  /** Bluetooth off: a line, and Turn on Bluetooth (Android) or a Control Center hint (iOS). */
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
  /** Scanning, with no board picked and no gym known yet: the placeholder that holds the slot. */
  | { kind: 'looking' }
  /** The gym's roster, A to Z, the board you're on in place. */
  | {
      kind: 'at_gym';
      gymUuid: string;
      gymName: string;
      source: AtGymSource;
      rows: readonly Board[];
      /** The rows the scan heard, by key: a long gym keeps them in view, like the selected row. */
      heardKeys: ReadonlySet<string>;
    }
  /**
   * One named board somewhere other than the board you're on, with Climb here.
   * `strongestSignal`: no box was heard louder, so it can say "In front of you".
   */
  | { kind: 'hero'; board: Board; strongestSignal: boolean };

export type PickerTopView<Board> = {
  notice: PickerScanNotice | null;
  content: PickerTopContent<Board>;
  /**
   * A box it heard but cannot name, with nothing named heard: its card, with
   * its three ways forward. Above At {gym} when the board you're on names the
   * gym, alone otherwise.
   */
  unnamed: UnnamedInRangeRow | null;
  /** The scan is still listening: a small spinner by the title. */
  scanning: boolean;
  /**
   * The key (as the top keys its boards) of the loudest thing heard, when
   * that is a board it can name; null when it heard nothing counted yet, or
   * the loudest was a box it can't name. A hero held from earlier in the scan
   * says "In front of you" only while it is still this.
   */
  loudestBoardKey: string | null;
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
  | { kind: 'hero'; board: UserBoard; strongestSignal: boolean };

/** The first step: everything but the roster, which needs `pickerTopGymUuid` to fetch. */
export type PickerTopDecision = Omit<PickerTopView<never>, 'content'> & {
  lead: PickerTopLead;
  activeBoard: UserBoard | null;
  /**
   * Every board the scan named so far, strongest first; empty while nothing
   * heard counts yet. For a top already drawn to keep (`decisionAtDrawnTop`).
   */
  heardNamed: readonly UserBoard[];
};

export type PickerTopInputs = {
  phase: PickerScanPhase;
  /** The scan's rows, strongest signal first (`buildQuickstartRows`). */
  rows: readonly QuickstartRow[];
  lookup: QuickstartLookupState;
  /** The board you're on: null for none, undefined while it is still being read. */
  activeBoard: UserBoard | null | undefined;
  /**
   * The scan has listened only a moment (`usePickerScanHold`): nothing it
   * heard is drawn yet, so the first box heard, often not the one the climber
   * stands at, never leads and then gives way.
   */
  holdScanLead?: boolean;
  /** The climber said Not now to the Bluetooth card: asking is one line from then on. */
  bluetoothNotNow?: boolean;
};

const NONE: PickerTopLead = { kind: 'none' };
const LOOKING: PickerTopLead = { kind: 'looking' };

/** A board's gym, when it has both an id and a name to put in "At {gym}". */
function gymOf(board: UserBoard): GymRef | null {
  return board.gymUuid && board.gymName ? { gymUuid: board.gymUuid, gymName: board.gymName } : null;
}

/**
 * Whether two boards are the same board. A hidden board found by serial has
 * no uuid (#6375), so it compares on its serial and type instead: a Kilter and
 * a Tension box can share a serial.
 */
export function isSameBoard(first: UserBoard, second: UserBoard): boolean {
  const firstUuid = boardUuidOrNull(first.uuid);
  const secondUuid = boardUuidOrNull(second.uuid);
  if (firstUuid !== null && secondUuid !== null) return firstUuid === secondUuid;
  return (
    Boolean(first.serialNumber) && first.serialNumber === second.serialNumber && first.boardType === second.boardType
  );
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
  heard: readonly QuickstartRow[],
  activeBoard: UserBoard | null,
  activeGym: GymRef | null,
): PickerTopLead | null {
  const [strongest] = named;
  if (strongest === undefined) return null;
  // "In front of you" only when nothing at all, named or not, was heard louder.
  const hero: PickerTopLead = {
    kind: 'hero',
    board: strongest.board,
    strongestSignal: heard[0]?.key === strongest.key,
  };
  if (named.length === 1) {
    const onIt = activeBoard !== null && isSameBoard(strongest.board, activeBoard);
    const atItsGym = activeGym !== null && gymOf(strongest.board)?.gymUuid === activeGym.gymUuid;
    if (!onIt && !atItsGym) return hero;
  }
  const gym = gymMostHeard(named, activeGym);
  if (!gym) {
    // Several named boards and none at a gym (home walls): the strongest leads,
    // as one board would. Not when the board you're on is among them: it is
    // the one in front of you, and Your boards already marks it.
    const onItHeard = activeBoard !== null && named.some((row) => isSameBoard(row.board, activeBoard));
    return named.length > 1 && !onItHeard ? hero : null;
  }
  return {
    kind: 'at_gym',
    ...gym,
    source: 'scan',
    heardBoards: named.filter((row) => gymOf(row.board)?.gymUuid === gym.gymUuid).map((row) => row.board),
  };
}

/** Which notice the scan shows for a phase that does not listen. */
function noticeForIdlePhase(
  phase: Exclude<PickerScanPhase, 'scanning' | 'done'>,
  bluetoothNotNow: boolean,
): PickerScanNotice | null {
  switch (phase) {
    case 'hidden':
      return null;
    case 'needs_permission':
      return bluetoothNotNow ? { kind: 'permission_line' } : { kind: 'permission_card' };
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

export function decidePickerTop({
  phase,
  rows,
  lookup,
  activeBoard,
  holdScanLead = false,
  bluetoothNotNow = false,
}: PickerTopInputs): PickerTopDecision {
  const active = activeBoard ?? null;
  const activeGym = active ? gymOf(active) : null;
  const fromActiveBoard: PickerTopLead | null = activeGym
    ? { kind: 'at_gym', ...activeGym, source: 'active_board', heardBoards: [] }
    : null;

  if (phase !== 'scanning' && phase !== 'done') {
    // The scan is not listening: whatever it heard before says nothing now.
    return {
      notice: noticeForIdlePhase(phase, bluetoothNotNow),
      lead: fromActiveBoard ?? NONE,
      unnamed: null,
      scanning: false,
      loudestBoardKey: null,
      heardNothing: false,
      activeBoard: active,
      heardNamed: [],
    };
  }

  const scanning = phase === 'scanning';
  // Nothing heard counts yet while the scan has only just started listening,
  // or while its first serial lookup is out (the answer could point at
  // another gym): the board you're on's gym, or nothing.
  const heard = lookup === 'pending' || (scanning && holdScanLead) ? [] : rows;
  const named = heard.filter(isBoardRow);
  const lookupFailed = heard.some((row) => row.kind === 'lookup_failed');
  // A box it can't name is worth a card only when nothing named was heard.
  const unnamed = named.length === 0 ? (heard.find(isUnnamedRow) ?? null) : null;
  const [loudest] = heard;
  const loudestBoardKey = loudest?.kind === 'board' ? (boardRowKeys([loudest.board])[0] ?? null) : null;

  let lead: PickerTopLead =
    leadFromNamed(named, heard, active, activeGym) ??
    fromActiveBoard ??
    // The placeholder is for a climber with no board yet: one on a home wall
    // has Your boards to look at, and the scan may well hear nothing new.
    (scanning && active === null ? LOOKING : NONE);

  const besideHeardBoards = lead.kind === 'hero' || (lead.kind === 'at_gym' && lead.source === 'scan');
  const notice: PickerScanNotice | null = lookupFailed ? { kind: 'lookup_failed', besideHeardBoards } : null;
  // A card already holds the slot (need signal, or the box it can't name); a
  // placeholder under it would say the opposite.
  if (lead.kind === 'looking' && (notice !== null || unnamed !== null)) lead = NONE;

  return {
    notice,
    lead,
    unnamed,
    scanning,
    loudestBoardKey,
    heardNothing: phase === 'done' && rows.length === 0,
    activeBoard: active,
    heardNamed: named.map((row) => row.board),
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
function atGymContent(
  lead: Extract<PickerTopLead, { kind: 'at_gym' }>,
  gymRoster: readonly UserBoard[] | undefined,
  activeBoard: UserBoard | null,
): Extract<PickerTopContent<PickerTopBoard>, { kind: 'at_gym' }> {
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
  const rows = boards
    .map((board, index) => ({
      key: keys[index] ?? board.uuid,
      board,
      title: stripGymNamePrefix(board.name, lead.gymName),
      selected: activeBoard !== null && isSameBoard(board, activeBoard),
    }))
    .sort(compareRows);
  const heardKeys = new Set(
    rows.filter((row) => lead.heardBoards.some((heard) => isSameBoard(heard, row.board))).map((row) => row.key),
  );
  return { kind: 'at_gym', gymUuid: lead.gymUuid, gymName: lead.gymName, source: lead.source, rows, heardKeys };
}

/**
 * The second step: the top with its rows, once `useGymBoards` has (or has not
 * yet) answered for `pickerTopGymUuid(decision)`.
 */
export function buildPickerTopView(
  decision: PickerTopDecision,
  gymRoster: readonly UserBoard[] | undefined,
): PickerTopView<PickerTopBoard> {
  const { notice, unnamed, scanning, loudestBoardKey, heardNothing, lead, activeBoard } = decision;
  let content: PickerTopContent<PickerTopBoard>;
  switch (lead.kind) {
    case 'at_gym':
      content = atGymContent(lead, gymRoster, activeBoard);
      break;
    case 'hero': {
      const [key = lead.board.uuid] = boardRowKeys([lead.board]);
      content = {
        kind: 'hero',
        board: { key, board: lead.board, title: lead.board.name, selected: false },
        strongestSignal: lead.strongestSignal,
      };
      break;
    }
    default:
      content = lead;
  }
  return { notice, content, unnamed, scanning, loudestBoardKey, heardNothing };
}

/** Both steps at once, for callers that already hold the roster (tests, stories). */
export function pickerTopView(
  inputs: PickerTopInputs,
  gymRoster?: readonly UserBoard[],
): PickerTopView<PickerTopBoard> {
  return buildPickerTopView(decidePickerTop(inputs), gymRoster);
}

/**
 * Whether the scan put this content at the top, rather than the board you're
 * on: once drawn, it holds for the rest of the scan (`stabilizePickerTop`).
 */
export function isScanLed(content: PickerTopContent<unknown>): boolean {
  return content.kind === 'hero' || (content.kind === 'at_gym' && content.source === 'scan');
}

/**
 * The top as the climber keeps seeing it while one scan runs on. `drawn` is
 * what the scan put at the top earlier in this scan, or null before it has
 * (`usePickerTopSteadiness` keeps it). Once the scan has led:
 * - its gym stays the gym: a box heard later never swaps one gym for another,
 *   or At {gym} for a hero, under the climber's finger;
 * - its hero stays the hero, with one way out: its own gym, once more of that
 *   gym's walls are heard (two walls at a gym are At {gym}, `decisionAtDrawnTop`),
 *   never back to a hero, never another gym;
 * - At {gym} keeps the order it was drawn in, and walls that arrive later
 *   (the roster landing, another wall heard) join at the end.
 * The rest of the view (notices, the spinner, the box it can't name, a hero's
 * "In front of you") follows `next`.
 */
export function stabilizePickerTop(
  drawn: PickerTopContent<PickerTopBoard> | null,
  next: PickerTopView<PickerTopBoard>,
): PickerTopView<PickerTopBoard> {
  if (drawn === null || (drawn.kind !== 'hero' && drawn.kind !== 'at_gym')) return next;
  const nextContent = next.content;
  if (drawn.kind === 'hero') {
    if (nextContent.kind === 'hero' && nextContent.board.key === drawn.board.key) return next;
    const heroGym = drawn.board.board.gymUuid;
    if (nextContent.kind === 'at_gym' && heroGym && nextContent.gymUuid === heroGym) return next;
    // "In front of you" from what the scan hears now, not from when it was drawn.
    const strongestSignal = next.loudestBoardKey === drawn.board.key;
    return { ...next, content: { ...drawn, strongestSignal }, unnamed: null };
  }
  if (nextContent.kind !== 'at_gym' || nextContent.gymUuid !== drawn.gymUuid) {
    return { ...next, content: drawn, unnamed: null };
  }
  const nextByKey = new Map(nextContent.rows.map((row) => [row.key, row]));
  const drawnKeys = new Set(drawn.rows.map((row) => row.key));
  const kept = drawn.rows.flatMap((row) => {
    const current = nextByKey.get(row.key);
    return current ? [current] : [];
  });
  const joined = nextContent.rows.filter((row) => !drawnKeys.has(row.key));
  return { ...next, content: { ...nextContent, rows: [...kept, ...joined] } };
}

/** How many named walls heard at one gym make the top At {gym} rather than a hero. */
const AT_GYM_MIN_HEARD = 2;

/**
 * The decision as the top already drawn this scan (`drawn`, null before the
 * scan has led) lets it go on, so the roster fetched is the one drawn:
 * - At {gym} stays on its gym, every wall heard there (then or since) marked
 *   heard, while the scan's own answer points at a gym with more;
 * - a hero at a gym becomes At {its gym} once two of that gym's walls are
 *   heard, however many another gym has (`stabilizePickerTop` allows that one
 *   move, and no other); until then it stays the hero, "In front of you" only
 *   while it is the loudest heard, and no other gym's roster is fetched;
 * - anything else is the decision as it is.
 */
export function decisionAtDrawnTop(
  decision: PickerTopDecision,
  drawn: PickerTopContent<PickerTopBoard> | null,
): PickerTopDecision {
  const { lead, heardNamed } = decision;
  if (drawn?.kind === 'at_gym') {
    const sameGym = lead.kind === 'at_gym' && lead.gymUuid === drawn.gymUuid;
    const heardBoards: UserBoard[] = drawn.rows.filter((row) => drawn.heardKeys.has(row.key)).map((row) => row.board);
    for (const board of heardNamed) {
      if (board.gymUuid !== drawn.gymUuid || heardBoards.some((listed) => isSameBoard(listed, board))) continue;
      heardBoards.push(board);
    }
    return {
      ...decision,
      lead: {
        kind: 'at_gym',
        gymUuid: drawn.gymUuid,
        gymName: drawn.gymName,
        source: sameGym ? lead.source : drawn.source,
        heardBoards,
      },
    };
  }
  if (drawn?.kind === 'hero') {
    const heroBoard = drawn.board.board;
    const heroGym = gymOf(heroBoard);
    if (heroGym) {
      if (lead.kind === 'at_gym' && lead.gymUuid === heroGym.gymUuid) return decision;
      const heardAtHeroGym = heardNamed.filter((board) => board.gymUuid === heroGym.gymUuid);
      if (heardAtHeroGym.length >= AT_GYM_MIN_HEARD) {
        return { ...decision, lead: { kind: 'at_gym', ...heroGym, source: 'scan', heardBoards: heardAtHeroGym } };
      }
    }
    if (lead.kind === 'hero' && isSameBoard(lead.board, heroBoard)) return decision;
    // The hero stays, and no other gym's roster is fetched behind it.
    return {
      ...decision,
      lead: { kind: 'hero', board: heroBoard, strongestSignal: decision.loudestBoardKey === drawn.board.key },
    };
  }
  return decision;
}

/** What a drawn top looks like, to tell whether a new render moved anything. */
export function pickerTopSignature(content: PickerTopContent<PickerTopBoard>): string {
  switch (content.kind) {
    case 'hero':
      return `hero:${content.board.key}`;
    case 'at_gym':
      return `at_gym:${content.gymUuid}:${content.rows.map((row) => row.key).join(',')}`;
    default:
      return content.kind;
  }
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
  /**
   * 0-based, in the section's full order. A long At {gym} collapsed behind
   * Show all draws a shorter list: the list reports where the row was drawn.
   */
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
      return {
        ...view,
        content:
          board === undefined ? { kind: 'none' } : { kind: 'hero', board, strongestSignal: content.strongestSignal },
      };
    }
    default:
      return { ...view, content };
  }
}

/** Rows At {gym} shows before Show all. */
export const AT_GYM_COLLAPSED_ROW_COUNT = 4;
/** Rows Your boards shows before Show all: about 91% of climbers have 3 or fewer. */
export const YOUR_BOARDS_COLLAPSED_ROW_COUNT = 6;

/**
 * The rows a long list shows before Show all. The picker's ScrollView cannot
 * hold a virtualised list, and a big gym has a dozen walls. Never collapses to
 * hide a single row. Rows that must stay in view (the board you're on, which
 * no other list shows; the walls the scan heard) always do, in their place:
 * the other rows give up the room they take, so the rows that show keep their
 * order and the list stays about `limit` long.
 */
export function collapsedRows<Row>(
  rows: readonly Row[],
  mustShow: (row: Row) => boolean,
  limit: number,
): readonly Row[] {
  if (rows.length <= limit + 1) return rows;
  const mustShowCount = rows.filter(mustShow).length;
  let otherRoom = Math.max(0, limit - mustShowCount);
  const shown = rows.filter((row) => {
    if (mustShow(row)) return true;
    if (otherRoom === 0) return false;
    otherRoom -= 1;
    return true;
  });
  return shown.length >= rows.length - 1 ? rows : shown;
}
