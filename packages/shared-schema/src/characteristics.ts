/**
 * Structured climb characteristics — the replacement for the magic strings that
 * used to encode climb metadata in free-text fields:
 *   - the Aurora "No match" convention (a `No match\n` prefix on the climb
 *     description; see {@link isNoMatchClimb} / {@link withNoMatch} in ./utils);
 *   - MoonBoard problem "method" (footless / footless+kickboard / no-kickboard),
 *     which the importer parsed and then dropped on the floor.
 *
 * Characteristics live in `board_climbs.characteristics` (a `text[]` column).
 * Internal code reads these tokens as the source of truth. The description
 * prefix is kept only as the Aurora wire format on ingest/round-trip.
 */

export const CLIMB_CHARACTERISTICS = {
  /** Matching (both hands on the same hold) is disallowed. Aurora convention. */
  NO_MATCH: 'no_match',
  /** Feet may be used, but not the kickboard. Independent toggle — any board type. */
  NO_KICKBOARD: 'no_kickboard',
  /** No feet allowed at all (hands only). Independent toggle — any board type. */
  CAMPUS: 'campus',
  /**
   * Any hold on the wall may be used as a foot, not just the ones the setter lit
   * as feet. The Woods app calls this "open feet"; it is the default on that
   * board and the reason a Woods problem often lights no foot holds at all.
   *
   * Board-agnostic as a token (nothing about it is Woods-specific), but it is
   * only authored on Woods today. It contradicts {@link CLIMB_CHARACTERISTICS.CAMPUS}
   * and the two footless MoonBoard methods — see {@link ANY_FEET_CONFLICTS}.
   */
  ANY_FEET: 'any_feet',
  /** MoonBoard "Footless": no foot holds, kickboard not used. */
  METHOD_FOOTLESS: 'method_footless',
  /** MoonBoard "Footless + kickboard": no foot holds, the kickboard may be used. */
  METHOD_FOOTLESS_KICKBOARD: 'method_footless_kickboard',
  /** MoonBoard "No kickboard": feet follow hands but the kickboard is off-limits. */
  METHOD_NO_KICKBOARD: 'method_no_kickboard',
} as const;

export type ClimbCharacteristic = (typeof CLIMB_CHARACTERISTICS)[keyof typeof CLIMB_CHARACTERISTICS];

/**
 * MoonBoard "method" tokens are mutually exclusive — a problem has at most one.
 * The default ("Feet follow hands" / any marked holds) is the *absence* of a
 * method token, which keeps the stored array sparse.
 */
const METHOD_CHARACTERISTICS: ReadonlySet<string> = new Set<string>([
  CLIMB_CHARACTERISTICS.METHOD_FOOTLESS,
  CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD,
  CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD,
]);

/** Whether a token is one of the mutually-exclusive MoonBoard method tokens. */
export function isMethodCharacteristic(token: string): token is ClimbCharacteristic {
  return METHOD_CHARACTERISTICS.has(token);
}

export function hasCharacteristic(
  characteristics: readonly string[] | null | undefined,
  token: ClimbCharacteristic,
): boolean {
  return !!characteristics && characteristics.includes(token);
}

/** Whether this climb disallows matching. */
export function isNoMatch(characteristics: readonly string[] | null | undefined): boolean {
  return hasCharacteristic(characteristics, CLIMB_CHARACTERISTICS.NO_MATCH);
}

/** Whether this climb disallows the kickboard as a foot hold. */
export function isNoKickboard(characteristics: readonly string[] | null | undefined): boolean {
  return hasCharacteristic(characteristics, CLIMB_CHARACTERISTICS.NO_KICKBOARD);
}

/** Whether this climb is campus-only (no feet at all). */
export function isCampus(characteristics: readonly string[] | null | undefined): boolean {
  return hasCharacteristic(characteristics, CLIMB_CHARACTERISTICS.CAMPUS);
}

/** Whether any hold on the wall counts as a foot on this climb. */
export function isAnyFeet(characteristics: readonly string[] | null | undefined): boolean {
  return hasCharacteristic(characteristics, CLIMB_CHARACTERISTICS.ANY_FEET);
}

/**
 * Tokens that are freely toggleable and independent of each other (unlike the
 * mutually-exclusive METHOD_* group). A client sends the full desired boolean
 * state of each of these; the server merges them in without touching any other
 * characteristic (no_match, MoonBoard method) already on the row.
 *
 * Deliberately still just no_kickboard + campus. `no_match` and `any_feet` ride
 * their own dedicated boolean input fields (`noMatch` / `anyFeet`), so adding
 * them here would let an old client — which sends this array as the FULL desired
 * state of every token in the list — silently clear a flag it has never heard of.
 */
export const TOGGLEABLE_CLIMB_CHARACTERISTICS = [
  CLIMB_CHARACTERISTICS.NO_KICKBOARD,
  CLIMB_CHARACTERISTICS.CAMPUS,
] as const;

/**
 * Tokens that cannot be true at the same time as `any_feet`.
 *
 * `campus` is "no feet at all" and `any_feet` is "every hold is a foot" — a climb
 * cannot be both. The two footless MoonBoard methods say the same thing in the
 * MoonBoard vocabulary. `method_no_kickboard` and `no_kickboard` are NOT in here:
 * "use any hold as a foot, except the kickboard" is a coherent rule and a real
 * one on boards with a kickboard.
 */
export const ANY_FEET_CONFLICTS: readonly ClimbCharacteristic[] = [
  CLIMB_CHARACTERISTICS.CAMPUS,
  CLIMB_CHARACTERISTICS.METHOD_FOOTLESS,
  CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD,
];

/**
 * The first token in `characteristics` that contradicts another one in the same
 * array, or null when the set is coherent. Callers reject the write on a
 * non-null result rather than silently dropping one side of the contradiction.
 *
 * Runs over the FINAL merged array (client input plus whatever was already on
 * the row), so it also catches a conflict a client couldn't see — e.g. turning
 * on `any_feet` for a MoonBoard problem stored as `method_footless`.
 */
export function findCharacteristicConflict(
  characteristics: readonly string[] | null | undefined,
): { token: ClimbCharacteristic; conflictsWith: ClimbCharacteristic } | null {
  if (!characteristics || !characteristics.includes(CLIMB_CHARACTERISTICS.ANY_FEET)) return null;
  const conflict = ANY_FEET_CONFLICTS.find((token) => characteristics.includes(token));
  return conflict ? { token: CLIMB_CHARACTERISTICS.ANY_FEET, conflictsWith: conflict } : null;
}

/**
 * Whether a board's `no_match` can still be carried by the description alone.
 *
 * The `"No match\n"` prefix is an Aurora wire convention, backfilled into
 * `characteristics` by migration. A row synced between that backfill and a given
 * deploy can still carry it in prose only, so readers fall back to the
 * description when `characteristics` is NULL. The code-driven boards never had
 * the convention: on MoonBoard a description starting with "no match" is user
 * prose, and on Woods a NULL `characteristics` means "rules unknown until the
 * catalog repair fills them in", not "no rules the description forgot".
 */
export function usesAuroraNoMatchDescription(boardType: string): boolean {
  return boardType !== 'moonboard' && boardType !== 'woods';
}

/**
 * The canonical rule string for a climb: its characteristic tokens deduped,
 * sorted and comma-joined.
 *
 * This is duplicate-detection identity, not display. Two climbs with the same
 * holds but different rules ("no match" vs not, "any feet" vs not) are two
 * different problems on the wall, so the rule string is part of the key the
 * duplicate gate compares — see `findExactDuplicateMatch` in the backend, whose
 * SQL builds the same string from `board_climbs.characteristics`.
 *
 * Used for the advisory-lock key. SQL compares the corresponding arrays as
 * sets, so ordering and duplicate tokens do not change duplicate identity.
 * Unknown tokens remain part of the identity for compatibility with newer clients.
 */
export function buildRuleSignature(characteristics: readonly string[] | null | undefined): string {
  if (!characteristics || characteristics.length === 0) return '';
  return Array.from(new Set(characteristics)).sort().join(',');
}

/** The MoonBoard method token on a climb, or null for the "feet follow hands" default. */
export function getMoonBoardMethod(characteristics: readonly string[] | null | undefined): ClimbCharacteristic | null {
  if (!characteristics) return null;
  return (
    (characteristics.find((token) => METHOD_CHARACTERISTICS.has(token)) as ClimbCharacteristic | undefined) ?? null
  );
}

/**
 * Toggle a characteristic token, returning a new array. Enabling a `method_*`
 * token first removes any sibling method token (they're mutually exclusive);
 * order is otherwise preserved so the column stays stable across writes.
 */
export function withCharacteristic(
  characteristics: readonly string[] | null | undefined,
  token: ClimbCharacteristic,
  enabled: boolean,
): string[] {
  const current = characteristics ? [...characteristics] : [];
  if (!enabled) {
    return current.filter((existing) => existing !== token);
  }
  const withoutConflicts = isMethodCharacteristic(token)
    ? current.filter((existing) => !METHOD_CHARACTERISTICS.has(existing))
    : current;
  return withoutConflicts.includes(token) ? withoutConflicts : [...withoutConflicts, token];
}

/**
 * Map a raw MoonBoard problem `method` string (from the community dump or the
 * MoonBoard API) to a characteristic token. The default "Feet follow hands" —
 * and any unrecognized value — maps to null (no token; the array stays sparse).
 *
 * Matching is case- and punctuation-insensitive and substring-based so minor
 * label variants between the dump and the live API still resolve. The dump's
 * distinct `.data[].method` values are the authoritative source set — confirm
 * against them when extending this mapper.
 */
export function moonBoardMethodToCharacteristic(method: string | null | undefined): ClimbCharacteristic | null {
  if (!method) return null;
  const normalized = method.toLowerCase();
  const noKickboard = normalized.includes('no kickboard') || normalized.includes('no-kickboard');
  const footless = normalized.includes('footless');
  // A "no kickboard" qualifier negates the kickboard half, so it must not push a
  // footless problem into the kickboard-allowed token ("Footless, no kickboard"
  // is footless *without* the kickboard).
  const kickboard = normalized.includes('kickboard') && !noKickboard;
  if (footless && kickboard) return CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD;
  if (footless) return CLIMB_CHARACTERISTICS.METHOD_FOOTLESS;
  if (noKickboard) return CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD;
  // "Feet follow hands" (default) and anything else → no method token.
  return null;
}
