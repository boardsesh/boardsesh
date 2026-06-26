import {
  coordinateToHoldId,
  uuidv5,
  MOONBOARD_UUID_NAMESPACE,
  HOLD_STATE_CODES,
  moonBoardGradeToDifficultyId,
} from './moonboard-helpers.js';
import { fingerprintFromHolds, methodDescription } from './moonboard-2024-helpers.js';
import { moonBoardMethodToCharacteristic } from '@boardsesh/shared-schema/characteristics';

// =============================================================================
// MoonBoard app-API catalog (boardsesh/moonboard-scraper app-catalog/)
// =============================================================================
// The MoonBoard iOS app's REST API (rest-v1.moonclimbing.com) returns one file
// per board ({ count, holdsetup, problems[] }), covering all 7 boards. Unlike
// the older community dump and the degraded 2024 export, every problem carries a
// stable `id`, per-angle `configurations` (grade + userRating + repeats +
// isBenchmark), and the holds as a single `moves` string ("s~G5~|l~C12~|e~C18~").
//
// We import one climb row per (problem, graded angle). Empty-grade configurations
// are the non-primary angle a setter never graded — they carry no grade, rating
// or ascents, so we skip them rather than flood the catalog with phantom climbs.
// =============================================================================

// In-file `holdsetup` id → our internal layout id (see @boardsesh/board-config
// MOONBOARD_LAYOUTS). 2010 reuses the existing layout 1; Mini 2025 is layout 7.
export const HOLDSETUP_TO_LAYOUT: Record<number, number> = {
  1: 2, // MoonBoard 2016
  15: 4, // MoonBoard Masters 2017
  17: 5, // MoonBoard Masters 2019
  19: 6, // Mini MoonBoard 2020
  21: 3, // MoonBoard 2024
  22: 7, // Mini MoonBoard 2025
  23: 1, // MoonBoard 2010
};

export type MoonBoardCatalogConfiguration = {
  apiId: number;
  grade: string; // e.g. "6C+"; "" for the angle a setter never graded
  userGrade?: string | null;
  userRating?: number | null; // 1-5 community stars; 0 = no rating
  isBenchmark?: boolean;
  isPrimary?: boolean;
  configuration: string; // "25°" | "40°"
  primaryAngle?: string;
  repeats?: number | null;
  dateDeleted?: string | null;
};

export type MoonBoardCatalogProblem = {
  id: number;
  name: string;
  setter?: string | null;
  setbyId?: string | null;
  climbMethod?: string | null;
  moves: string | null; // "<role>~<cell>~|<role>~<cell>~|…"
  holdsetup?: number;
  dateInserted?: string | null;
  dateDeleted?: string | null;
  Active?: boolean;
  configurations: MoonBoardCatalogConfiguration[] | null;
};

export type MoonBoardCatalogFile = {
  count: number;
  holdsetup: number;
  problems: MoonBoardCatalogProblem[];
};

export type MoonBoardCatalogHold = {
  holdId: number;
  holdState: string; // 'STARTING' | 'HAND' | 'FINISH'
};

export type MappedCatalogClimb = {
  // The id-based UUID a *new* climb gets. The importer overrides this with a
  // matched existing UUID when a climb with the same holds already exists (so
  // the merge updates in place instead of duplicating).
  uuid: string;
  layoutId: number;
  angle: number;
  name: string;
  setterUsername: string | null;
  frames: string;
  holdFingerprint: string;
  // undefined for an unmappable grade — caller decides (we only emit graded configs).
  difficultyId: number | undefined;
  isBenchmark: boolean;
  ascensionistCount: number;
  // null when userRating is 0/absent — 0 isn't on the 1-5 quality scale.
  qualityAverage: number | null;
  createdAt: string | null;
  holds: MoonBoardCatalogHold[];
  characteristics: string[] | null;
  description: string;
};

const STATE_TO_ROLE: Record<string, number> = {
  STARTING: HOLD_STATE_CODES.start,
  HAND: HOLD_STATE_CODES.hand,
  FINISH: HOLD_STATE_CODES.finish,
};

/**
 * Map a `moves` role letter to a hold state. The app uses `s`=start, `e`=end
 * (finish), and several letters for the holds in between — `l`/`r` (left/right
 * hand), `m` (match), `p` (intermediate), `f` (foot). Boardsesh only models
 * STARTING/HAND/FINISH, so everything that isn't a start or end is a HAND.
 */
export function roleLetterToHoldState(role: string): string {
  if (role === 's') return 'STARTING';
  if (role === 'e') return 'FINISH';
  return 'HAND';
}

/**
 * Parse the pipe-separated `moves` string into (holdId, holdState) tuples. Each
 * token is `<role>~<cell>~` (e.g. "s~G5~"); the hold id is recomputed from the
 * cell with the same formula the rest of the codebase uses, so the ids match
 * what's already stored for MoonBoard climbs.
 */
export function parseMovesString(moves: string): MoonBoardCatalogHold[] {
  return moves
    .split('|')
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => {
      const [role, cell] = token.split('~').filter((part) => part.length > 0);
      if (!cell) throw new Error(`Malformed move token: "${token}"`);
      return { holdId: coordinateToHoldId(cell), holdState: roleLetterToHoldState(role) };
    });
}

/** Encode holds as the `p{holdId}r{roleCode}` frames string. */
export function holdsToFrames(holds: MoonBoardCatalogHold[]): string {
  return holds.map((hold) => `p${hold.holdId}r${STATE_TO_ROLE[hold.holdState]}`).join('');
}

/** "40°" → 40, "25°" → 25; undefined when no angle is present. */
export function angleFromConfiguration(configuration: string | null | undefined): number | undefined {
  const match = (configuration ?? '').match(/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Deterministic, idempotent UUID for a newly-inserted climb, keyed off the
 * stable MoonBoard problem id + angle. A re-scrape yields the same id, so the
 * same climb maps to the same UUID across runs.
 */
export function catalogClimbUuid(args: { id: number; angle: number }): string {
  return uuidv5(`moonboard:${args.id}:${args.angle}`, MOONBOARD_UUID_NAMESPACE);
}

/** A problem is importable if it isn't soft-deleted and has holds + configs. */
export function isImportableProblem(problem: MoonBoardCatalogProblem): boolean {
  if (problem.dateDeleted) return false;
  if (problem.Active === false) return false;
  if (!problem.moves || problem.moves.trim().length === 0) return false;
  if (!problem.configurations || problem.configurations.length === 0) return false;
  return true;
}

/** A configuration is importable if it isn't soft-deleted and the setter graded it. */
export function isImportableConfig(config: MoonBoardCatalogConfiguration): boolean {
  if (config.dateDeleted) return false;
  if (!config.grade || config.grade.trim().length === 0) return false;
  return true;
}

/** Map a single (problem, configuration) into the climb/stats/holds payload. */
export function mapCatalogConfig(
  problem: MoonBoardCatalogProblem,
  config: MoonBoardCatalogConfiguration,
  options: { layoutId: number; angle: number },
): MappedCatalogClimb {
  const { layoutId, angle } = options;
  const holds = parseMovesString(problem.moves ?? '');
  const frames = holdsToFrames(holds);
  const method = problem.climbMethod ?? undefined;
  const characteristic = moonBoardMethodToCharacteristic(method);
  const rating = config.userRating ?? 0;
  return {
    uuid: catalogClimbUuid({ id: problem.id, angle }),
    layoutId,
    angle,
    name: problem.name,
    setterUsername: problem.setter ?? null,
    frames,
    holdFingerprint: fingerprintFromHolds(holds),
    difficultyId: moonBoardGradeToDifficultyId(config.grade),
    isBenchmark: Boolean(config.isBenchmark),
    ascensionistCount: config.repeats ?? 0,
    qualityAverage: rating > 0 ? rating : null,
    createdAt: problem.dateInserted ?? null,
    holds,
    characteristics: characteristic ? [characteristic] : null,
    description: methodDescription(method, characteristic, problem.name),
  };
}

/**
 * Expand a problem into one mapped climb per graded, non-deleted configuration
 * (i.e. one row per angle). Returns [] for a problem we skip entirely.
 */
export function catalogProblemToClimbs(problem: MoonBoardCatalogProblem, layoutId: number): MappedCatalogClimb[] {
  if (!isImportableProblem(problem)) return [];
  const climbs: MappedCatalogClimb[] = [];
  for (const config of problem.configurations ?? []) {
    if (!isImportableConfig(config)) continue;
    const angle = angleFromConfiguration(config.configuration);
    if (angle === undefined) continue;
    climbs.push(mapCatalogConfig(problem, config, { layoutId, angle }));
  }
  return climbs;
}
