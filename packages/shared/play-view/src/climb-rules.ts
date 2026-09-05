import { isAnyFeet, isCampus, isNoMatch } from '@boardsesh/shared-schema';

/**
 * The two rules a climb is set under, decoded from `board_climbs.characteristics`.
 *
 * Every board has always carried both rules; what differs is how they are shown.
 * Aurora and MoonBoard state only the EXCEPTIONS (a no-match glyph, a method
 * badge) and leave the default implied. The Woods app states both rules on every
 * problem, and Woods climbers read them that way — so the play drawer says both
 * out loud for a board whose `explicitClimbRules` capability is true.
 *
 * `unknown` is a real answer, not a fallback. Woods rows imported before the
 * catalogue carried rule metadata have `characteristics = null`, which means "we
 * were never told", and is different from `[]` — the array a Woods problem set
 * under the defaults (matching allowed, marked holds only) stores. Guessing the
 * defaults for a null row would put a rule on screen that nobody authored.
 */
export type ClimbMatchingRule = 'allowed' | 'not_allowed' | 'unknown';

/**
 * `no_feet` is the campus rule (hands only) — reported separately from
 * `marked_holds_only` because rendering a campus problem as "marked holds only"
 * describes feet the setter forbade entirely.
 */
export type ClimbFeetRule = 'any_feet' | 'marked_holds_only' | 'no_feet' | 'unknown';

export type ClimbRules = {
  matching: ClimbMatchingRule;
  feet: ClimbFeetRule;
};

/**
 * Decode a climb's characteristics array into its matching + feet rules.
 *
 * A null/undefined array is unknown on BOTH rules: the column is written as a
 * whole, so an absent array carries no information about either. An array that
 * is present but empty is the fully-default climb — matching allowed, feet on
 * the marked holds only.
 *
 * Campus wins over any-feet when both tokens are somehow on the row (the editor
 * makes them mutually exclusive, but a hand-written or legacy row need not be):
 * "no feet" is the stricter reading, so an ambiguous row can only ever
 * under-promise.
 */
export function decodeClimbRules(characteristics: readonly string[] | null | undefined): ClimbRules {
  if (characteristics == null) return { matching: 'unknown', feet: 'unknown' };
  return {
    matching: isNoMatch(characteristics) ? 'not_allowed' : 'allowed',
    feet: isCampus(characteristics) ? 'no_feet' : isAnyFeet(characteristics) ? 'any_feet' : 'marked_holds_only',
  };
}
