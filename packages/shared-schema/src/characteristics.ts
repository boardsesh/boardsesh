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
  const footless = normalized.includes('footless');
  const kickboard = normalized.includes('kickboard');
  if (footless && kickboard) return CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD;
  if (footless) return CLIMB_CHARACTERISTICS.METHOD_FOOTLESS;
  if (normalized.includes('no kickboard') || normalized.includes('no-kickboard')) {
    return CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD;
  }
  // "Feet follow hands" (default) and anything else → no method token.
  return null;
}
