import { uuidv5 } from './moonboard-helpers.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import { WOODS_WIRE_ROLE } from '@boardsesh/board-constants/woods';

// =============================================================================
// Woods Board catalog (boardsesh/woodsboard-scraper)
// =============================================================================
// The Daniel Woods Board iOS app's REST API returns one file per physical board
// size ({ boardDimension, count, problems[] }). Each problem carries a stable
// `id`, an integer `problemGrade` (0-17), `author`, `angle` (20-70 step 5), the
// `boardDimension` ("8x10" | "12x12"), and the holds as a `holdList` of
// { type: "Start" | "Hand" | "Finish" | "Foot" | "Clear", baseHoldLocation }.
//
// We import one climb per (name, author, hold layout). The Woods board has a
// single hold layout (layout 1); the two sizes are product sizes, selected via
// `compatibleSizeIds`. Frames use the firmware's own wire role codes
// (@boardsesh/board-constants WOODS_WIRE_ROLE) so a frame's role maps straight
// onto the wire when the BLE encoder lights the board.
// =============================================================================

// Minted once for Boardsesh's Woods import. Deterministic v5 UUIDs are keyed off
// this namespace, so a re-scrape of the same problem maps to the same climb UUID.
export const WOODS_UUID_NAMESPACE = '8d5c391a-3b86-4960-a706-91c95602e214';

// Every Woods climb lives on the single Woods layout. The two physical sizes
// (8x10, 12x12) are product sizes, not separate layouts.
export const WOODS_LAYOUT_ID = 1;

// The Woods board ships one fixed hold layout — there is no add-on set to buy or
// leave off the wall, so `WOODS_SIZES`/`getWoodsBoardDetails` expose no set ids at
// all. `required_set_ids` is the denormalised "which sets must be installed" column
// that search and playlists filter with `required_set_ids <@ ARRAY[selected]`, and
// the empty array is the honest answer: a Woods climb requires no sets, and `{} <@
// anything` is true in Postgres, so a Woods climb can never be filtered out by a
// set list. NULL would read as "not backfilled yet" (and `NULL <@ …` drops the row
// wherever the filter does run), and `{1}` would invent a set the board has no
// concept of and disappear the whole catalog against the empty configured list.
export const WOODS_REQUIRED_SET_IDS: number[] = [];

// Integer grade scale is 0-17 (WOODS_APP_API.md). Both ends inclusive → 18 rows.
export const WOODS_MIN_GRADE = 0;
export const WOODS_MAX_GRADE = 17;

// boardDimension → compatible product-size ids. 8x10 is product size 1, 12x12 is
// product size 2 (matching the WOODS_BOARD_SIZES ordering in board-constants).
export const WOODS_DIMENSION_TO_SIZE_IDS: Record<string, number[]> = {
  '8x10': [1],
  '12x12': [2],
};

export type WoodsHoldState = 'STARTING' | 'HAND' | 'FINISH' | 'FOOT';

// holdList `type` → Boardsesh hold state. "Clear" (and anything unrecognised) is
// not a climb hold and is dropped before mapping.
const TYPE_TO_HOLD_STATE: Record<string, WoodsHoldState> = {
  Start: 'STARTING',
  Hand: 'HAND',
  Finish: 'FINISH',
  Foot: 'FOOT',
};

// holdList `type` → Woods wire role code (spec §6, via @boardsesh/board-constants:
// Foot 1, Hand 2, Finish 3, Start 4). Never hardcoded — pulled from WOODS_WIRE_ROLE.
const TYPE_TO_ROLE_CODE: Record<string, number> = {
  Start: WOODS_WIRE_ROLE.START,
  Hand: WOODS_WIRE_ROLE.HAND,
  Finish: WOODS_WIRE_ROLE.FINISH,
  Foot: WOODS_WIRE_ROLE.FOOT,
};

export type WoodsHoldListItem = { type: string; baseHoldLocation: number };

export type WoodsCatalogProblem = {
  id: number;
  problemName: string;
  problemGrade: number; // integer 0-17
  proposedGrade?: number;
  communitySuggestedGrade?: number;
  author: string;
  angle: number;
  boardDimension: string;
  holdCount?: number;
  holdList: WoodsHoldListItem[];
  repeats?: number | null;
  totalLogLikes?: number | null;
  totalLogDislikes?: number | null;
  datePublished?: string | null;
  notes?: string | null;
  isProject?: boolean;
  firstAscent?: string | null;
};

export type WoodsCatalogFile = {
  boardDimension: string;
  count: number;
  problems: WoodsCatalogProblem[];
};

// A mapped climb hold (board_climb_holds row payload).
export type WoodsClimbHold = { holdId: number; holdState: WoodsHoldState };

// Parsed hold including the wire role code used to build the frames string.
export type ParsedWoodsHold = { holdId: number; holdState: WoodsHoldState; roleCode: number };

export type MappedWoodsClimb = {
  uuid: string;
  layoutId: number;
  angle: number;
  name: string;
  setterUsername: string | null;
  frames: string;
  holdFingerprint: string;
  compatibleSizeIds: number[];
  // The 0-17 integer difficulty, stored directly as the board_climb_stats difficulty.
  difficulty: number;
  ascensionistCount: number;
  // The Woods API has no 1-5 community rating (only like/dislike counts), so
  // quality is left null rather than invented onto the 1-5 scale.
  qualityAverage: number | null;
  createdAt: string | null;
  holds: WoodsClimbHold[];
};

export type WoodsGradeRow = {
  boardType: 'woods';
  difficulty: number;
  boulderName: string;
  routeName: null;
  isListed: boolean;
};

/**
 * Map a holdList `type` to a Boardsesh hold state, or null for "Clear" /
 * unrecognised entries (which are not climb holds and must be dropped).
 */
export function woodsHoldState(type: string): WoodsHoldState | null {
  return TYPE_TO_HOLD_STATE[type] ?? null;
}

/**
 * Drop "Clear" holds, map each remaining hold to its id/state/role, and sort
 * ascending by baseHoldLocation so the frames string and UUID are deterministic
 * regardless of the order the API returned the holds in.
 */
export function parseHoldList(holdList: WoodsHoldListItem[]): ParsedWoodsHold[] {
  return holdList
    .map((item) => {
      const holdState = woodsHoldState(item.type);
      if (holdState === null) return null;
      return { holdId: item.baseHoldLocation, holdState, roleCode: TYPE_TO_ROLE_CODE[item.type] };
    })
    .filter((hold): hold is ParsedWoodsHold => hold !== null)
    .sort((left, right) => left.holdId - right.holdId);
}

/** Encode holds as the `p{baseHoldLocation}r{roleCode}` frames string. */
export function holdsToFrames(holds: ParsedWoodsHold[]): string {
  return holds.map((hold) => `p${hold.holdId}r${hold.roleCode}`).join('');
}

/**
 * Deterministic, idempotent climb UUID. The Woods API has stable problem ids,
 * but we key the UUID on name|author|frames (not the id) so a re-set of the same
 * physical problem maps to the same climb. A different hold layout yields
 * different frames → a different UUID.
 */
export function woodsClimbUuid(args: { name: string; author: string; frames: string }): string {
  return uuidv5(`${args.name}|${args.author}|${args.frames}`, WOODS_UUID_NAMESPACE);
}

/** 8x10 → [1], 12x12 → [2]; [] for an unrecognised dimension. */
export function dimensionToSizeIds(boardDimension: string): number[] {
  return WOODS_DIMENSION_TO_SIZE_IDS[boardDimension] ?? [];
}

/**
 * Map a raw catalog problem to the climb/stats/holds payload, or null when the
 * problem has no real holds (empty or Clear-only) and so can't be imported.
 */
export function mapWoodsProblemToClimb(problem: WoodsCatalogProblem): MappedWoodsClimb | null {
  const parsedHolds = parseHoldList(problem.holdList ?? []);
  if (parsedHolds.length === 0) return null;
  const frames = holdsToFrames(parsedHolds);
  const holds: WoodsClimbHold[] = parsedHolds.map((hold) => ({ holdId: hold.holdId, holdState: hold.holdState }));
  const publishedDate = (problem.datePublished ?? '').trim();
  const author = (problem.author ?? '').trim();
  return {
    // Key the UUID off the same trimmed author that lands in setter_username —
    // keying off the raw value would mint a different UUID for " ada" and "ada"
    // while storing the same display name.
    uuid: woodsClimbUuid({ name: problem.problemName, author, frames }),
    layoutId: WOODS_LAYOUT_ID,
    angle: problem.angle,
    name: problem.problemName,
    setterUsername: author.length > 0 ? author : null,
    frames,
    holdFingerprint: fingerprintFromHolds(holds),
    compatibleSizeIds: dimensionToSizeIds(problem.boardDimension),
    difficulty: problem.problemGrade,
    ascensionistCount: problem.repeats ?? 0,
    qualityAverage: null,
    createdAt: publishedDate.length > 0 ? publishedDate : null,
    holds,
  };
}

/**
 * board_difficulty_grades rows for the Woods board. WOODS_APP_API.md documents
 * the grade as an "integer scale, 0-17" with no explicit labels; the Daniel
 * Woods Board app presents a 0-based V-scale, so we map difficulty n → "Vn"
 * (0→V0 … 17→V17). ASSUMPTION: this 0-based V mapping — adjust here if a labelled
 * scale is ever published.
 */
export function woodsGradeRows(): WoodsGradeRow[] {
  const rows: WoodsGradeRow[] = [];
  for (let difficulty = WOODS_MIN_GRADE; difficulty <= WOODS_MAX_GRADE; difficulty++) {
    rows.push({ boardType: 'woods', difficulty, boulderName: `V${difficulty}`, routeName: null, isListed: true });
  }
  return rows;
}
