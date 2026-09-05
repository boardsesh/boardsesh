import { CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema/characteristics';
import { uuidv5 } from './moonboard-helpers.js';
import { fingerprintFromHolds } from './moonboard-2024-helpers.js';
import {
  WOODS_WIRE_ROLE,
  WOODS_GRADE_TO_DIFFICULTY,
  WOODS_DIFFICULTY_IDS,
  woodsGradeToDifficulty,
} from '@boardsesh/board-constants/woods';
import { BOULDER_GRADES } from '@boardsesh/board-constants/boulder-grade-mapping';

// =============================================================================
// Woods Board catalog (boardsesh/woodsboard-scraper)
// =============================================================================
// The Daniel Woods Board iOS app's REST API returns one file per physical board
// size ({ boardDimension, count, problems[] }). Each problem carries a stable
// `id`, an integer `problemGrade` (0-17), `author`, `angle` (20-70 step 5), the
// `boardDimension` ("8x10" | "12x12"), and the holds as a `holdList` of
// { type: "Start" | "Hand" | "Finish" | "Foot" | "Clear", baseHoldLocation }.
//
// We import one climb per (board size, name, author, hold layout). The Woods
// board has a single hold layout (layout 1); the two sizes are product sizes,
// selected via `compatibleSizeIds` — and part of the climb UUID, because the
// same hold ids mean different holds on the two walls. Frames use the firmware's own wire role codes
// (@boardsesh/board-constants WOODS_WIRE_ROLE) so a frame's role maps straight
// onto the wire when the BLE encoder lights the board.
// =============================================================================

// Minted once for Boardsesh's Woods import. Deterministic v5 UUIDs are keyed off
// this namespace, so a re-scrape of the same problem maps to the same climb UUID.
export const WOODS_UUID_NAMESPACE = '8d5c391a-3b86-4960-a706-91c95602e214';

// Every Woods climb lives on the single Woods layout. The two physical sizes
// (8x10, 12x12) are product sizes, not separate layouts.
export const WOODS_LAYOUT_ID = 1;

// The Woods board ships one fixed hold layout. The board config reports a single
// synthetic set so the board-selection UI has something to select, but there is
// no add-on set to buy or leave off the wall. `required_set_ids` is the
// denormalised "which sets must be installed" column that search and playlists
// filter with `required_set_ids <@ ARRAY[selected]`, and the empty array is the
// honest answer: a Woods climb requires no sets, and `{} <@ anything` is true in
// Postgres, so a Woods climb can never be filtered out by a set list. NULL would
// read as "not backfilled yet" (and `NULL <@ …` drops the row wherever the filter
// does run).
// Typed `readonly` so nothing writes through the single exported instance; the
// import copies it into each climb row (`[...WOODS_REQUIRED_SET_IDS]`), which is
// what the driver wants anyway.
export const WOODS_REQUIRED_SET_IDS: readonly number[] = [];

// boardDimension → compatible product-size ids. 8x10 is product size 1, 12x12 is
// product size 2 (matching the WOODS_BOARD_SIZES ordering in board-constants).
export const WOODS_DIMENSION_TO_SIZE_IDS: Readonly<Record<string, readonly number[]>> = {
  '8x10': [1],
  '12x12': [2],
};

// Woods grades that fold onto a lower grade's shared difficulty id because the
// shared BOULDER_GRADES table has no distinct id left for them. Derived from
// WOODS_GRADE_TO_DIFFICULTY rather than hardcoded, so extending the shared table
// past 8c+/V16 would stop counting V17 as clamped on its own. Today: {17}.
export const WOODS_CLAMPED_GRADES: ReadonlySet<number> = (() => {
  const grades = Object.keys(WOODS_GRADE_TO_DIFFICULTY)
    .map(Number)
    .sort((left, right) => left - right);
  return new Set(
    grades.filter((grade, index) =>
      grades
        .slice(0, index)
        .some((lowerGrade) => WOODS_GRADE_TO_DIFFICULTY[lowerGrade] === WOODS_GRADE_TO_DIFFICULTY[grade]),
    ),
  );
})();

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

// `datePublished` as the Woods API publishes it: US-ordered MM/DD/YYYY plus a
// 24-hour clock. Proven against the full catalog (5,418 rows): the first field
// never exceeds 12 while the second reaches 31, so the leading number is the
// month, not the day. 29 rows put a comma after the year ("02/05/2023, 18:34:33")
// — the same format with a locale separator, so the comma is optional here rather
// than those rows silently losing their date. `T` is accepted for the same reason.
const WOODS_PUBLISHED_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4}),?[ T](\d{2}):(\d{2}):(\d{2})$/;

export type WoodsHoldListItem = { type: string; baseHoldLocation: number };

export type WoodsCatalogProblem = {
  id: number;
  matching: boolean;
  anyFeet: boolean;
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

/** Missing upstream flags are unknown, never implicit false values. */
export function woodsProblemCharacteristics(
  problem: Pick<WoodsCatalogProblem, 'id' | 'matching' | 'anyFeet'>,
): string[] {
  if (typeof problem.matching !== 'boolean' || typeof problem.anyFeet !== 'boolean') {
    throw new Error(`Woods problem ${problem.id} requires boolean matching and anyFeet flags`);
  }
  const characteristics: string[] = [];
  if (!problem.matching) characteristics.push(CLIMB_CHARACTERISTICS.NO_MATCH);
  if (problem.anyFeet) characteristics.push(CLIMB_CHARACTERISTICS.ANY_FEET);
  return characteristics;
}

export type WoodsCatalogFile = {
  boardDimension: string;
  count: number;
  problems: WoodsCatalogProblem[];
};

/**
 * Parse one catalog file, failing loudly WITH THE FILE NAME. TypeScript's
 * `WoodsCatalogFile` is erased at runtime, so a re-scrape that changes shape
 * (say, `problems` becoming an object) would otherwise read as `undefined`
 * lengths and silently import nothing — and a malformed file would surface as a
 * bare SyntaxError that makes the operator bisect the catalog directory to find
 * it. Only the fields the importer dereferences unconditionally are guarded;
 * per-problem fields stay the job of `mapWoodsProblemToClimb`.
 */
export function parseWoodsCatalogFile(raw: string, fileName: string): WoodsCatalogFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Catalog file ${fileName} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  const candidate = parsed as Partial<WoodsCatalogFile> | null;
  if (typeof candidate !== 'object' || candidate === null) {
    throw new Error(
      `Catalog file ${fileName} is not a JSON object (got ${candidate === null ? 'null' : typeof candidate})`,
    );
  }
  if (typeof candidate.boardDimension !== 'string') {
    throw new Error(`Catalog file ${fileName} has no string "boardDimension" — is this a Woods catalog dump?`);
  }
  if (!Array.isArray(candidate.problems)) {
    throw new Error(`Catalog file ${fileName} has no "problems" array — is this a Woods catalog dump?`);
  }
  for (const problem of candidate.problems) {
    if (!problem || typeof problem !== 'object') throw new Error(`Catalog file ${fileName} has an invalid problem`);
    try {
      woodsProblemCharacteristics(problem);
    } catch (error) {
      throw new Error(`Catalog file ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return candidate as WoodsCatalogFile;
}

// A mapped climb hold (board_climb_holds row payload).
export type WoodsClimbHold = { holdId: number; holdState: WoodsHoldState };

// Parsed hold including the wire role code used to build the frames string.
export type ParsedWoodsHold = { holdId: number; holdState: WoodsHoldState; roleCode: number };

export type MappedWoodsClimb = {
  uuid: string;
  characteristics: string[];
  layoutId: number;
  angle: number;
  name: string;
  setterUsername: string | null;
  frames: string;
  holdFingerprint: string;
  compatibleSizeIds: number[];
  // The shared BOULDER_GRADES difficulty id (10-33) the Woods 0-17 grade folds
  // onto, or null when the Woods app emitted a grade outside its own scale — the
  // importer then stores NULL rather than inventing a difficulty for the climb.
  difficulty: number | null;
  // True when `difficulty` had to fold onto a lower grade's id (V17 → 8c+/V16).
  // Counted by the importer so the clamp stays visible in the run summary.
  difficultyClamped: boolean;
  ascensionistCount: number;
  // The Woods API has no 1-5 community rating (only like/dislike counts), so
  // quality is left null rather than invented onto the 1-5 scale.
  qualityAverage: number | null;
  // The Woods app's free-text first-ascensionist credit (non-empty on 611 of the
  // 5,418 catalog rows). It is a display name, not a Boardsesh account, so it
  // lands in fa_username with fa_at left null — the API publishes no FA date.
  faUsername: string | null;
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
 * Drop "Clear" holds, collapse repeats of the same hold id (last wins), and sort
 * ascending by baseHoldLocation so the frames string and UUID are deterministic
 * regardless of the order the API returned the holds in.
 *
 * The dedupe is not defensive padding: 12x12 problem 81 ("The Motto") lists hold
 * 757 twice. Without collapsing it here the repeat reaches the frames string and
 * the hold fingerprint, while board_climb_holds (keyed on climb + hold id) keeps
 * a single row — three views of one climb derived from two different hold lists.
 * Last wins so a later entry's role is the one that survives, matching how the
 * app renders a hold that was tapped again.
 */
export function parseHoldList(holdList: WoodsHoldListItem[]): ParsedWoodsHold[] {
  const byHoldId = new Map<number, ParsedWoodsHold>();
  for (const item of holdList) {
    const holdState = woodsHoldState(item.type);
    if (holdState === null) continue;
    byHoldId.set(item.baseHoldLocation, {
      holdId: item.baseHoldLocation,
      holdState,
      roleCode: TYPE_TO_ROLE_CODE[item.type],
    });
  }
  return [...byHoldId.values()].sort((left, right) => left.holdId - right.holdId);
}

/** Encode holds as the `p{baseHoldLocation}r{roleCode}` frames string. */
export function holdsToFrames(holds: ParsedWoodsHold[]): string {
  return holds.map((hold) => `p${hold.holdId}r${hold.roleCode}`).join('');
}

/**
 * Deterministic, idempotent climb UUID. The Woods API has stable problem ids,
 * but we key the UUID on boardDimension|name|author|frames (not the id) so a
 * re-set of the same physical problem maps to the same climb. A different hold
 * layout yields different frames → a different UUID.
 *
 * The board size is part of the key because the two sizes are two different
 * walls, not two views of one. 8x10 hold ids are a numeric subset of the 12x12
 * ids but sit at different physical positions, so a problem that happens to
 * share a name, setter and hold-id list across both files is two climbs. Keying
 * without the dimension would collapse them onto one row, and whichever file
 * imported last would overwrite compatible_size_ids — hiding the other size's
 * climb from every client that filters on size.
 */
export function woodsClimbUuid(args: { name: string; author: string; frames: string; boardDimension: string }): string {
  return uuidv5(`${args.boardDimension}|${args.name}|${args.author}|${args.frames}`, WOODS_UUID_NAMESPACE);
}

/**
 * 8x10 → [1], 12x12 → [2]; [] for an unrecognised dimension. Returns a fresh
 * array every call, so a climb row never holds a reference into the lookup table
 * that another row could mutate out from under it.
 */
export function dimensionToSizeIds(boardDimension: string): number[] {
  const sizeIds = WOODS_DIMENSION_TO_SIZE_IDS[boardDimension];
  return sizeIds ? [...sizeIds] : [];
}

/**
 * Rewrite the Woods API's `datePublished` as the `YYYY-MM-DD HH:mm:ss` string
 * `board_climbs.created_at` wants, or null when the value doesn't parse.
 *
 * `created_at` is a plain text column and every consumer sorts it LEXICALLY, so
 * "05/04/2025 17:23:17" would sort by month-of-year and file a 12/2023 climb
 * after a 01/2026 one. Zero-padding into ISO ordering is what makes "newest
 * first" actually mean newest. MoonBoard has the same column and stores its
 * `dateInserted` in ISO for exactly this reason.
 *
 * The API publishes MM/DD, not DD/MM — proven against the full catalog, where the
 * first field never exceeds 12 while the second reaches 31.
 */
export function normalizeWoodsPublishedDate(raw: string | null | undefined): string | null {
  const match = WOODS_PUBLISHED_DATE_PATTERN.exec((raw ?? '').trim());
  if (!match) return null;
  const [, month, day, year, hours, minutes, seconds] = match;
  // The pattern proves the shape, not the values. Range-check the fields as
  // well, or "13/45/2020 99:99:99" is stored verbatim as "2020-13-45 99:99:99" —
  // a string that sorts after every real December and that no date parser will
  // read back. Null is the honest answer for a value the API mangled.
  //
  // A leading field above 12 is not a DD/MM row worth rescuing either: the
  // catalog is MM/DD throughout, so re-reading "31/12/2025" as 31 December would
  // invent an ordering from a row that is simply corrupt.
  if (Number(month) < 1 || Number(month) > 12) return null;
  if (Number(day) < 1 || Number(day) > 31) return null;
  if (Number(hours) > 23 || Number(minutes) > 59 || Number(seconds) > 59) return null;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hours}:${minutes}:${seconds}`;
}

/**
 * Map a raw catalog problem to the climb/stats/holds payload, or null when the
 * problem has no real holds (empty or Clear-only) and so can't be imported.
 */
export function mapWoodsProblemToClimb(problem: WoodsCatalogProblem): MappedWoodsClimb | null {
  const characteristics = woodsProblemCharacteristics(problem);
  const parsedHolds = parseHoldList(problem.holdList ?? []);
  if (parsedHolds.length === 0) return null;
  const frames = holdsToFrames(parsedHolds);
  const holds: WoodsClimbHold[] = parsedHolds.map((hold) => ({ holdId: hold.holdId, holdState: hold.holdState }));
  const author = (problem.author ?? '').trim();
  const firstAscent = (problem.firstAscent ?? '').trim();
  const difficulty = woodsGradeToDifficulty(problem.problemGrade);
  return {
    characteristics,
    // Key the UUID off the same trimmed author that lands in setter_username —
    // keying off the raw value would mint a different UUID for " ada" and "ada"
    // while storing the same display name.
    uuid: woodsClimbUuid({
      name: problem.problemName,
      author,
      frames,
      boardDimension: problem.boardDimension,
    }),
    layoutId: WOODS_LAYOUT_ID,
    angle: problem.angle,
    name: problem.problemName,
    setterUsername: author.length > 0 ? author : null,
    frames,
    holdFingerprint: fingerprintFromHolds(holds),
    compatibleSizeIds: dimensionToSizeIds(problem.boardDimension),
    difficulty,
    difficultyClamped: difficulty !== null && WOODS_CLAMPED_GRADES.has(problem.problemGrade),
    ascensionistCount: problem.repeats ?? 0,
    qualityAverage: null,
    faUsername: firstAscent.length > 0 ? firstAscent : null,
    createdAt: normalizeWoodsPublishedDate(problem.datePublished),
    holds,
  };
}

/**
 * board_difficulty_grades rows for the Woods board: one row per distinct shared
 * difficulty id a Woods grade can fold onto (17 of the 24 BOULDER_GRADES ids),
 * ascending, labelled with the shared table's own `difficulty_name`.
 *
 * The Woods app grades on its own 0-17 V scale, but storing those raw numbers
 * would misalign every grade surface in the app — filters, colours, the offline
 * grade rail and tick grade matching all speak the shared difficulty-id scale.
 * WOODS_GRADE_TO_DIFFICULTY does the folding; this seeds the labels for it.
 */
export function woodsGradeRows(): WoodsGradeRow[] {
  return BOULDER_GRADES.filter((grade) => WOODS_DIFFICULTY_IDS.has(grade.difficulty_id))
    .map((grade) => ({
      boardType: 'woods' as const,
      difficulty: grade.difficulty_id,
      boulderName: grade.difficulty_name,
      routeName: null,
      isListed: true,
    }))
    .sort((left, right) => left.difficulty - right.difficulty);
}
