import {
  coordinateToHoldId,
  uuidv5,
  MOONBOARD_UUID_NAMESPACE,
  HOLD_STATE_CODES,
  moonBoardGradeToDifficultyId,
} from './moonboard-helpers.js';
import { fingerprintFromHolds, methodDescription } from './moonboard-2024-helpers.js';
import { moonBoardMethodToCharacteristic } from '@boardsesh/shared-schema/characteristics';
import { MOONBOARD_ANGLES } from '@boardsesh/board-config';
import { sql } from 'drizzle-orm';

// =============================================================================
// MoonBoard catalog dataset
// =============================================================================
// The catalog provides one file
// per board ({ count, holdsetup, problems[] }), covering all 7 boards. Unlike
// the older community dump and the degraded 2024 export, every problem carries a
// stable `id`, per-angle `configurations` (grade + userRating + repeats +
// isBenchmark), and the holds as a single `moves` string ("s~G5~|l~C12~|e~C18~").
//
// We import ONE climb row per problem — angle-agnostic, matching Kilter/Tension —
// and one board_climb_stats row per graded angle under that same climb UUID.
// Empty-grade configurations are the non-primary angle a setter never graded —
// they carry no grade, rating or ascents, so we skip them rather than flood the
// catalog with phantom stats rows.
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
  moves: string | null; // "<role>~<cell>~|<role>~<cell>~…"
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

/** Per-angle grade/quality/ascent data for one graded configuration of a problem. */
export type MappedCatalogClimbStats = {
  angle: number;
  // undefined for an unmappable grade — caller decides (we only emit graded configs).
  difficultyId: number | undefined;
  // The setter grade exactly as the catalog spelled it, kept so the importer can
  // name the offending strings when difficultyId comes back undefined.
  sourceGrade: string;
  isBenchmark: boolean;
  ascensionistCount: number;
  // null when userRating is 0/absent — 0 isn't on the 1-5 quality scale.
  qualityAverage: number | null;
};

export type MappedCatalogClimb = {
  // The id-based UUID a *new* climb gets. The importer overrides this with a
  // matched existing UUID when a climb with the same holds already exists (so
  // the merge updates in place instead of duplicating).
  uuid: string;
  layoutId: number;
  name: string;
  setterUsername: string | null;
  frames: string;
  holdFingerprint: string;
  createdAt: string | null;
  holds: MoonBoardCatalogHold[];
  characteristics: string[] | null;
  description: string;
  // One entry per graded, non-deleted configuration (i.e. per angle).
  stats: MappedCatalogClimbStats[];
};

export type ExistingCatalogClimb = { uuid: string; name: string | null };

type ExistingCatalogClimbRow = ExistingCatalogClimb & {
  layoutId: number;
  isListed: boolean | null;
};

/**
 * Match-index key. Hold fingerprints are only comparable within one layout (the
 * same cells mean different holds on a different board), so every producer and
 * consumer of the index — and the in-batch duplicate fold — goes through this.
 */
export function catalogFingerprintKey(layoutId: number, holdFingerprint: string): string {
  return `${layoutId}|${holdFingerprint}`;
}

/**
 * Batch-map keys for the importer's staged stats/holds rows. `resolveIncumbentReplacement`
 * reports the beaten incumbent's keys for deletion, so the importer's map keys
 * and those stale keys MUST use one format — both sides call these, and
 * moonboard-catalog-batch.test.ts pins the agreement.
 */
export function statsBatchKey(uuid: string, angle: number): string {
  return `${uuid}:${angle}`;
}

export function holdsBatchKey(uuid: string, holdId: number): string {
  return `${uuid}:${holdId}`;
}

/**
 * Follow an alias chain to the uuid it ultimately resolves to. Returns
 * undefined for a cycle (a broken redirect we refuse to reason about).
 */
export function terminalCanonicalUuid(uuid: string, canonicalByAlias: ReadonlyMap<string, string>): string | undefined {
  const visited = new Set<string>();
  let currentUuid = uuid;
  while (!visited.has(currentUuid)) {
    visited.add(currentUuid);
    const nextUuid = canonicalByAlias.get(currentUuid);
    if (!nextUuid || nextUuid === currentUuid) return currentUuid;
    currentUuid = nextUuid;
  }
  return undefined;
}

/** Build the merge index, resolving redirects to their terminal canonical UUID. */
export function buildExistingCatalogMatchIndex(
  climbRows: ExistingCatalogClimbRow[],
  fingerprintByUuid: ReadonlyMap<string, string>,
  canonicalByAlias: ReadonlyMap<string, string>,
): Map<string, ExistingCatalogClimb[]> {
  const index = new Map<string, ExistingCatalogClimb[]>();
  // `null` is not affirmative catalog visibility, so it is treated as unlisted.
  const listedUuids = new Set(climbRows.filter((row) => row.isListed === true).map((row) => row.uuid));
  for (const row of climbRows) {
    if (row.isListed !== true) continue;
    const fingerprint = fingerprintByUuid.get(row.uuid);
    if (!fingerprint) continue;
    const canonicalUuid = terminalCanonicalUuid(row.uuid, canonicalByAlias);
    if (!canonicalUuid || !listedUuids.has(canonicalUuid)) continue;
    const key = catalogFingerprintKey(row.layoutId, fingerprint);
    const candidate = { uuid: canonicalUuid, name: row.name };
    const bucket = index.get(key);
    if (bucket) bucket.push(candidate);
    else index.set(key, [candidate]);
  }
  return index;
}

/** Update fields used when a catalog rerun repairs an existing alias target. */
export function catalogAliasConflictUpdate() {
  return { canonicalUuid: sql`excluded.canonical_uuid`, lastSeenAt: sql`now()` };
}

/**
 * Resolve an incoming catalog climb to an existing merge candidate, if any.
 *
 * `ambiguous: true` means the fingerprint bucket held >1 DISTINCT listed
 * candidate uuid — expected shape post-#3849 (one canonical per problem), but
 * on a database the moonboard_angle_dedup_backfill migration (#3849) hasn't run against yet, both angle-rows of a
 * problem are still separately listed and typically share a name, so the
 * name tie-break "resolves" to one of them non-deterministically (row order)
 * while the OTHER stays listed too. Writing through that state doubles-counts
 * ascents across two listed rows and can point a legacy alias at whichever
 * row the tie-break happened to pick. Callers should treat `ambiguous: true`
 * as "skip this problem, don't write anything for it" rather than silently
 * trusting the returned uuid — see import-moonboard-catalog.ts.
 */
export function resolveCatalogClimbUuid(
  mapped: MappedCatalogClimb,
  index: Map<string, ExistingCatalogClimb[]>,
): { uuid: string; matched: boolean; ambiguous: boolean } {
  const candidates = index.get(catalogFingerprintKey(mapped.layoutId, mapped.holdFingerprint));
  if (!candidates || candidates.length === 0) return { uuid: mapped.uuid, matched: false, ambiguous: false };
  const candidateUuids = new Set(candidates.map((candidate) => candidate.uuid));
  if (candidateUuids.size === 1) return { uuid: candidates[0].uuid, matched: true, ambiguous: false };
  const target = mapped.name.trim().toLowerCase();
  const named = candidates.find((candidate) => (candidate.name ?? '').trim().toLowerCase() === target);
  return named
    ? { uuid: named.uuid, matched: true, ambiguous: true }
    : { uuid: mapped.uuid, matched: false, ambiguous: true };
}

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
 * stable MoonBoard problem id — angle-agnostic, matching Kilter/Tension climb
 * identity. A re-scrape yields the same id, so the same problem maps to the
 * same UUID across runs regardless of which angles it's graded at.
 */
export function catalogClimbUuid(args: { id: number }): string {
  return uuidv5(`moonboard:${args.id}`, MOONBOARD_UUID_NAMESPACE);
}

/**
 * The OLD per-angle UUID scheme (`moonboard:{id}:{angle}`), from before climb
 * identity became angle-agnostic. Kept ONLY to mint legacy aliases — the
 * personal-logbook CSV importer (packages/backend/src/services/
 * moonboard-import.ts) still resolves ticks via this format and is out of
 * scope for this rewrite, so every graded angle must keep an alias row in
 * this shape pointing at the new canonical UUID.
 */
export function legacyCatalogClimbUuid(args: { id: number; angle: number }): string {
  return uuidv5(`moonboard:${args.id}:${args.angle}`, MOONBOARD_UUID_NAMESPACE);
}

/**
 * The alias rows to persist for a resolved catalog climb: a self-alias (so
 * `resolveCanonicalClimbUuid` always hits), the angle-agnostic id-based UUID
 * (when the non-destructive merge reused a different, pre-existing UUID), and
 * one legacy per-angle UUID per graded angle (see `legacyCatalogClimbUuid`).
 * Idempotent — a re-run yields the same rows; duplicates (e.g. a brand new
 * climb whose id-based UUID already equals its own canonical) are collapsed.
 */
export function catalogAliasRows(args: {
  problemId: number;
  angles: number[];
  canonicalUuid: string;
}): { aliasUuid: string; canonicalUuid: string }[] {
  const { problemId, angles, canonicalUuid } = args;
  const seen = new Set([canonicalUuid]);
  const rows: { aliasUuid: string; canonicalUuid: string }[] = [{ aliasUuid: canonicalUuid, canonicalUuid }];

  const idBasedUuid = catalogClimbUuid({ id: problemId });
  if (!seen.has(idBasedUuid)) {
    rows.push({ aliasUuid: idBasedUuid, canonicalUuid });
    seen.add(idBasedUuid);
  }

  for (const angle of angles) {
    const legacyUuid = legacyCatalogClimbUuid({ id: problemId, angle });
    if (!seen.has(legacyUuid)) {
      rows.push({ aliasUuid: legacyUuid, canonicalUuid });
      seen.add(legacyUuid);
    }
  }

  return rows;
}

/**
 * The UUIDs this problem would already own from an earlier import: the
 * angle-agnostic id-based one, plus every legacy `moonboard:{id}:{angle}` one
 * for its graded angles. Returns only those that are already climb ROWS.
 *
 * A hold-match miss (`matched: false`) normally means "new problem, insert it".
 * But if any of these UUIDs already exists as a climb, the miss instead means
 * the problem's holds drifted — an upstream hold edit, or a change to
 * parseMovesString/fingerprintFromHolds — and inserting would be destructive:
 * the fresh `moonboard:{id}` row lands alongside the still-listed old rows,
 * and then `catalogAliasRows` writes `moonboard:{id}:{angle}` aliases whose
 * alias_uuid IS one of those old rows. `catalogAliasConflictUpdate` overwrites
 * canonical_uuid unconditionally, so their self-aliases get repointed at the
 * empty new row and their ticks start redirecting there while both rows stay
 * listed. Callers should treat a non-empty result as "skip this problem
 * loudly" — same policy as `ambiguous` above.
 */
export function existingClimbUuidsForProblem(args: {
  problemId: number;
  angles: number[];
  existingClimbUuids: ReadonlySet<string>;
}): string[] {
  const { problemId, angles, existingClimbUuids } = args;
  const candidateUuids = new Set([
    catalogClimbUuid({ id: problemId }),
    ...angles.map((angle) => legacyCatalogClimbUuid({ id: problemId, angle })),
  ]);
  return [...candidateUuids].filter((uuid) => existingClimbUuids.has(uuid));
}

/**
 * The angles a problem may already own climb rows at: the ones the catalog
 * grades it at TODAY, plus every angle MoonBoard problems have ever been
 * imported at (`MOONBOARD_ANGLES`).
 *
 * The pre-rewrite importer minted one row per graded angle, and grades come and
 * go between snapshots. A problem graded at 25° in an older dump but only at
 * 40° now still owns a `moonboard:{id}:25` row, and checking only today's
 * graded angles would miss it — the exact case the drift guard exists to catch.
 */
export function ownedClimbAngles(gradedAngles: readonly number[]): number[] {
  return [...new Set([...gradedAngles, ...MOONBOARD_ANGLES])];
}

/**
 * The uuids this problem owns that merging it onto `resolvedUuid` would HIJACK.
 *
 * On the matched branch the problem's holds DID match an existing climb, so
 * "the problem already owns rows" is not by itself drift — the usual case is a
 * legacy import where the owned uuid IS the matched row, which must stay a
 * normal in-place merge. The destructive case is an owned uuid that is a live
 * climb row somewhere ELSE: `catalogAliasRows` would emit it as an alias of
 * `resolvedUuid`, and `catalogAliasConflictUpdate` overwrites canonical_uuid
 * unconditionally, so that row's own resolution (and its ticks) would start
 * redirecting at a climb it isn't, while it stays listed.
 *
 * Owned uuids already redirecting to `resolvedUuid` are fine: re-writing that
 * alias is a no-op. A cyclic alias chain resolves to undefined and counts as a
 * hijack — we refuse to write through a redirect we can't follow.
 */
export function hijackedClimbUuidsForProblem(args: {
  problemId: number;
  angles: number[];
  resolvedUuid: string;
  existingClimbUuids: ReadonlySet<string>;
  canonicalByAlias: ReadonlyMap<string, string>;
}): string[] {
  const { problemId, angles, resolvedUuid, existingClimbUuids, canonicalByAlias } = args;
  return existingClimbUuidsForProblem({ problemId, angles, existingClimbUuids }).filter(
    (uuid) => uuid !== resolvedUuid && terminalCanonicalUuid(uuid, canonicalByAlias) !== resolvedUuid,
  );
}

/**
 * Why a problem is not importable, or `null` when it is.
 *
 * `withdrawn` is split out from the rest because it is the only reason that
 * carries a positive instruction: upstream is telling us this problem is gone,
 * so a climb we already imported for it should stop being listed. Every other
 * reason is "we can't map this", which says nothing about rows we already have.
 *
 * MoonBoard marks a withdrawn problem two ways at once — `dateDeleted` is set
 * AND the setter is rewritten to `MoonBoardSystem` — while still returning the
 * row from the API. `Active === false` has never been observed in a capture;
 * it is treated as withdrawn too on the same reasoning.
 */
export type ProblemSkipReason = 'withdrawn' | 'no-holds' | 'no-configurations';

export function problemSkipReason(problem: MoonBoardCatalogProblem): ProblemSkipReason | null {
  if (problem.dateDeleted) return 'withdrawn';
  if (problem.Active === false) return 'withdrawn';
  if (!problem.moves || problem.moves.trim().length === 0) return 'no-holds';
  if (!problem.configurations || problem.configurations.length === 0) return 'no-configurations';
  return null;
}

/** A problem is importable if it isn't soft-deleted and has holds + configs. */
export function isImportableProblem(problem: MoonBoardCatalogProblem): boolean {
  return problemSkipReason(problem) === null;
}

/**
 * The canonical climb uuid a withdrawn problem's rows live under, or undefined
 * when it never had any (withdrawn before we ever imported it — the common case
 * for a problem deleted long ago).
 *
 * Resolution goes through the alias table rather than assuming the id-based
 * uuid IS the climb: the non-destructive merge routinely parks a problem on a
 * pre-existing uuid, and `catalogAliasRows` records that with an alias. Reusing
 * `existingClimbUuidsForProblem` keeps the "which uuids does this problem own"
 * question in one place, so the unlist pass and the drift guard can never
 * disagree about it.
 *
 * `ownedClimbAngles` is applied by the caller: a withdrawn problem's
 * configurations may be soft-deleted too, so today's graded angles are not a
 * reliable list of the angles it once owned rows at.
 */
export function withdrawnCanonicalUuids(args: {
  problemId: number;
  angles: number[];
  existingClimbUuids: ReadonlySet<string>;
  canonicalByAlias: ReadonlyMap<string, string>;
}): string[] {
  const { problemId, angles, existingClimbUuids, canonicalByAlias } = args;
  const owned = existingClimbUuidsForProblem({ problemId, angles, existingClimbUuids });
  const resolved = new Set<string>();
  for (const uuid of owned) {
    // A cyclic alias chain resolves to undefined. Same stance as the hijack
    // guard: refuse to act on a redirect we cannot follow.
    const canonicalUuid = terminalCanonicalUuid(uuid, canonicalByAlias);
    if (canonicalUuid && existingClimbUuids.has(canonicalUuid)) resolved.add(canonicalUuid);
  }
  return [...resolved];
}

/** A configuration is importable if it isn't soft-deleted and the setter graded it. */
export function isImportableConfig(config: MoonBoardCatalogConfiguration): boolean {
  if (config.dateDeleted) return false;
  if (!config.grade || config.grade.trim().length === 0) return false;
  return true;
}

/** Map the angle-agnostic structural fields of a problem (holds, name, setter, …). */
export function mapCatalogProblemStructural(
  problem: MoonBoardCatalogProblem,
  layoutId: number,
): Omit<MappedCatalogClimb, 'stats'> {
  const holds = parseMovesString(problem.moves ?? '');
  const frames = holdsToFrames(holds);
  const method = problem.climbMethod ?? undefined;
  const characteristic = moonBoardMethodToCharacteristic(method);
  return {
    uuid: catalogClimbUuid({ id: problem.id }),
    layoutId,
    name: problem.name,
    setterUsername: problem.setter ?? null,
    frames,
    holdFingerprint: fingerprintFromHolds(holds),
    createdAt: problem.dateInserted ?? null,
    holds,
    characteristics: characteristic ? [characteristic] : null,
    description: methodDescription(method, characteristic, problem.name),
  };
}

/** Map a single graded configuration into its per-angle stats payload. */
export function mapCatalogConfigStats(config: MoonBoardCatalogConfiguration, angle: number): MappedCatalogClimbStats {
  const rating = config.userRating ?? 0;
  return {
    angle,
    difficultyId: moonBoardGradeToDifficultyId(config.grade),
    sourceGrade: config.grade ?? '',
    isBenchmark: Boolean(config.isBenchmark),
    ascensionistCount: config.repeats ?? 0,
    qualityAverage: rating > 0 ? rating : null,
  };
}

/**
 * Map a problem into one climb (angle-agnostic identity + holds) carrying one
 * stats entry per graded, non-deleted configuration. Returns null for a
 * problem we skip entirely (unimportable, or every configuration ungraded).
 */
export function catalogProblemToClimbs(problem: MoonBoardCatalogProblem, layoutId: number): MappedCatalogClimb | null {
  if (!isImportableProblem(problem)) return null;
  const stats: MappedCatalogClimbStats[] = [];
  for (const config of problem.configurations ?? []) {
    if (!isImportableConfig(config)) continue;
    const angle = angleFromConfiguration(config.configuration);
    if (angle === undefined) continue;
    stats.push(mapCatalogConfigStats(config, angle));
  }
  if (stats.length === 0) return null;
  return { ...mapCatalogProblemStructural(problem, layoutId), stats };
}

/**
 * Two distinct catalog problems can share the exact same holds at the same
 * layout (e.g. the real "birthday cake trail mix", 38,683 repeats, and a junk
 * duplicate literally named "name" with 19 repeats). They collapse onto one
 * Boardsesh climb (same hold fingerprint → same merged UUID), so the importer
 * must decide which PROBLEM's entire stats set wins instead of taking
 * whichever it processed last.
 *
 * Prefer the stronger community signal: more total ascents (summed across all
 * graded angles) wins; on a tie, a problem with any benchmark angle beats one
 * with none; otherwise keep the incumbent (stable, so a re-run is
 * deterministic). Returns true if `candidate` should replace `incumbent`.
 */
export function isBetterCatalogClimb(candidate: MappedCatalogClimb, incumbent: MappedCatalogClimb): boolean {
  const candidateAscents = candidate.stats.reduce((sum, stat) => sum + stat.ascensionistCount, 0);
  const incumbentAscents = incumbent.stats.reduce((sum, stat) => sum + stat.ascensionistCount, 0);
  if (candidateAscents !== incumbentAscents) {
    return candidateAscents > incumbentAscents;
  }
  const candidateBenchmark = candidate.stats.some((stat) => stat.isBenchmark);
  const incumbentBenchmark = incumbent.stats.some((stat) => stat.isBenchmark);
  if (candidateBenchmark !== incumbentBenchmark) {
    return candidateBenchmark;
  }
  return false;
}

export type IncumbentReplacementDecision =
  | { accept: false }
  | { accept: true; staleStatKeys: string[]; staleHoldKeys: string[] };

/**
 * Decide whether `candidate` should replace `incumbent` for the same resolved
 * `uuid` within one import batch (see isBetterCatalogClimb), and — when it
 * does — which of the incumbent's previously-staged stats/holds batch-map
 * keys must be cleared first. The winner's graded angles can differ from the
 * loser's (e.g. incumbent graded at 25°+40°, winner only at 40°), so without
 * clearing, a stale per-angle stats entry from the loser would silently
 * survive into the DB under the winning uuid.
 */
export function resolveIncumbentReplacement(
  uuid: string,
  candidate: MappedCatalogClimb,
  incumbent: MappedCatalogClimb | undefined,
): IncumbentReplacementDecision {
  if (incumbent && !isBetterCatalogClimb(candidate, incumbent)) {
    return { accept: false };
  }
  return {
    accept: true,
    staleStatKeys: (incumbent?.stats ?? []).map((stat) => statsBatchKey(uuid, stat.angle)),
    staleHoldKeys: (incumbent?.holds ?? []).map((hold) => holdsBatchKey(uuid, hold.holdId)),
  };
}
