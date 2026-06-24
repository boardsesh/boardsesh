import { createHash } from 'crypto';
import { moonBoardMethodToCharacteristic } from '@boardsesh/shared-schema/characteristics';
import {
  coordinateToHoldId,
  moveToHoldState,
  movesToFrames,
  moonBoardGradeToDifficultyId,
  uuidv5,
  MOONBOARD_UUID_NAMESPACE,
  type MoonBoardMove,
} from './moonboard-helpers.js';

// =============================================================================
// MoonBoard 2024 catalog export (boardsesh/moonboard-scraper)
// =============================================================================
// The scraper ships two files: "Benchmark Problems Moonboard 2024 40.json"
// (412 benchmarks) and "Problems Moonboard 2024 40.json" (the full ~35k-problem
// catalog). We import the full catalog. The format has no stable problem id,
// no repeats/userRating, and — in the full file — usually no date fields, so
// fields beyond name/grade/setby/moves are treated as optional.
// =============================================================================

export const MOONBOARD_2024_LAYOUT_ID = 3;

export type MoonBoard2024Move = {
  description: string; // grid coordinate, e.g. "F5"
  isStart: boolean;
  isEnd: boolean;
};

// Only name/grade/setby/moves are reliably present across both files; everything
// else can be absent (notably the date fields in the full catalog file).
export type MoonBoard2024Problem = {
  name: string;
  grade: string; // e.g. "6C+"; may be "" for ungraded projects
  userGrade?: string | null;
  setby: string;
  method?: string;
  holdsetup?: { description: string; holdsets: unknown };
  isBenchmark?: boolean;
  moves: MoonBoard2024Move[];
  holdsets?: { description: string }[];
  dateInserted?: string | null;
  dateUpdated?: string | null;
  dateDeleted?: string | null;
};

export type MoonBoard2024DumpFile = {
  total?: number;
  data: MoonBoard2024Problem[];
};

export type MoonBoard2024Hold = {
  holdId: number;
  holdState: string; // 'STARTING' | 'HAND' | 'FINISH'
};

export type MappedMoonBoard2024Climb = {
  uuid: string;
  layoutId: number;
  angle: number;
  name: string;
  setterUsername: string;
  frames: string;
  holdFingerprint: string;
  // undefined for ungraded "PROJECT"/empty-grade problems — imported with a null
  // difficulty rather than skipped.
  difficultyId: number | undefined;
  isBenchmark: boolean;
  createdAt: string | null;
  holds: MoonBoard2024Hold[];
  // Structured characteristics array for board_climbs.characteristics. For
  // MoonBoard 2024 this is the method token (or null for "feet follow hands").
  characteristics: string[] | null;
  // Free-text description. Used to preserve a non-standard `method` label (the
  // handful of joke "method" values like "KICKBOARDS ARE AID", plus PROJECT /
  // BENCHMARK) that don't map to a characteristic — otherwise '' .
  description: string;
};

// The recognized "matched" defaults — these are the absence of a method, not a
// label worth preserving in the description.
const DEFAULT_METHODS: ReadonlySet<string> = new Set(['any marked holds', 'feet follow hands']);

/**
 * If a problem's `method` doesn't resolve to a characteristic token AND isn't
 * the plain default, keep the raw label as the description so the setter's
 * (often joke-y) note isn't lost. Everything that maps to a tag, plus the
 * default and empty values, yields ''.
 *
 * In this catalog the joke "methods" are nearly always identical to the climb
 * `name` (the setter reused the text), so we skip those — duplicating the name
 * into the description adds nothing. Only a method that genuinely differs from
 * the name is preserved.
 */
export function methodDescription(
  method: string | null | undefined,
  characteristic: string | null,
  name: string | null | undefined,
): string {
  if (characteristic) return '';
  const trimmed = (method ?? '').trim();
  if (!trimmed || DEFAULT_METHODS.has(trimmed.toLowerCase())) return '';
  if (trimmed === (name ?? '').trim()) return '';
  return trimmed;
}

/**
 * Pull the angle out of an export filename like `Problems Moonboard 2024 40.json`.
 * Returns undefined when no MoonBoard angle (25 or 40) is present. ("2024" never
 * matches — neither "25" nor "40" is a whole-word token inside it.)
 */
export function angleFromFilename(filename: string): number | undefined {
  const match = filename.match(/\b(25|40)\b/);
  return match ? Number(match[1]) : undefined;
}

/** Expand a problem's moves into (holdId, holdState) tuples. */
export function movesToHolds(moves: MoonBoard2024Move[]): MoonBoard2024Hold[] {
  return moves.map((move) => ({
    holdId: coordinateToHoldId(move.description),
    holdState: moveToHoldState(move as MoonBoardMove),
  }));
}

/**
 * SHA-256 fingerprint of the climb's holds. Must match the canonical algorithm
 * in packages/kilter-sync/src/sync/fingerprint.ts and
 * packages/db/scripts/backfill-hold-fingerprints.ts — sorted
 * (hold_id:hold_state:frame_number) tuples joined with '|'. MoonBoard climbs
 * are single-frame, so frame_number is always 0. Stored on every climb for
 * cross-board tooling, but NOT used as the dedup identity (see below).
 */
export function fingerprintFromHolds(holds: MoonBoard2024Hold[]): string {
  const tuples = holds
    .map((hold) => `${hold.holdId}:${hold.holdState}:0`)
    .sort()
    .join('|');
  return createHash('sha256').update(tuples).digest('hex');
}

/**
 * Deterministic, idempotent climb UUID. The catalog has no stable id, so we
 * derive the UUID from name + setter + holds (per layout + angle). This is
 * idempotent across re-scrapes (a scraper run yields the same name/setter/holds
 * per problem) while preserving genuinely-distinct problems that share holds —
 * the full catalog has ~49 such cases (same holds, different name/grade/setter,
 * e.g. "CONEOFCOMPROMISE" 6B+ vs "SPACE KOOK" 6C). A holds-only (fingerprint)
 * key would silently merge those, so holds alone is NOT the identity; the
 * fingerprint is still stored on the row for tooling.
 *
 * angle is in the key because our MoonBoard model keeps one climb row per
 * (problem, angle), matching the 2023 import.
 */
export function moonBoard2024ClimbUuid(args: {
  layoutId: number;
  angle: number;
  name: string;
  setby: string;
  frames: string;
}): string {
  const key = `moonboard:${args.layoutId}:${args.angle}:${args.name}|${args.setby}|${args.frames}`;
  return uuidv5(key, MOONBOARD_UUID_NAMESPACE);
}

/** Map a raw export problem to the values needed for the climb/stats/holds rows. */
export function mapMoonBoard2024Problem(
  problem: MoonBoard2024Problem,
  options: { layoutId: number; angle: number },
): MappedMoonBoard2024Climb {
  const { layoutId, angle } = options;
  const frames = movesToFrames(problem.moves as MoonBoardMove[]);
  const holds = movesToHolds(problem.moves);
  // MoonBoard "method" (footless / footless+kickboard / no-kickboard) becomes a
  // structured characteristic; the default "feet follow hands" and unknown joke
  // labels map to null (no token) — see @boardsesh/shared-schema.
  const methodCharacteristic = moonBoardMethodToCharacteristic(problem.method);
  return {
    uuid: moonBoard2024ClimbUuid({ layoutId, angle, name: problem.name, setby: problem.setby, frames }),
    layoutId,
    angle,
    name: problem.name,
    setterUsername: problem.setby,
    frames,
    holdFingerprint: fingerprintFromHolds(holds),
    difficultyId: moonBoardGradeToDifficultyId(problem.grade),
    isBenchmark: Boolean(problem.isBenchmark),
    createdAt: problem.dateInserted ?? null,
    holds,
    characteristics: methodCharacteristic ? [methodCharacteristic] : null,
    description: methodDescription(problem.method, methodCharacteristic, problem.name),
  };
}
