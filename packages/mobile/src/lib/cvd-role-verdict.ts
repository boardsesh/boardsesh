/**
 * "Can I still tell my four hold roles apart?", answered in words.
 *
 * The colour-vision rail answers that question as four pictures, which is worth
 * nothing to a blind climber and may be unreadable at 168pt to a low-vision one.
 * So the rail is never the only channel: this module computes the same verdict
 * as text, from the climber's four EFFECTIVE role colours.
 *
 * Pure — no React, no storage, no board catalogue — so it is unit-testable
 * without a renderer, which is the whole reason it lives outside the section
 * that renders it.
 *
 * Uses `color-contrast-oracle.ts` (LINEAR light), not the gamma-domain
 * simulator the rail draws with. The two deliberately disagree: this is a
 * contrast DECISION and wants the colorimetrically defensible numbers, while a
 * preview wants what a climber would see in a web simulator. Both files' headers
 * cross-reference each other.
 *
 * Thresholds and CVD matrices are the ones `__tests__/cvd-palette-presets.test.ts`
 * already validates every shipped palette against, so a palette that passes that
 * suite is a palette this module calls clear.
 */

import { BOARD_FIELD_COLORS } from './board-render-settings';
import { contrastRatioHex, deltaEHex, type CvdTransformKey, type CvdType } from './color-contrast-oracle';
import { HOLD_COLOR_OVERRIDE_ROLES, type HoldColorOverrideRole } from './hold-color-overrides';

/** Two roles closer than this under a dichromacy read as the same colour. */
export const MIN_ROLE_PAIR_DELTA_E00 = 8;

/** A role below this against the play field washes into the wall. */
export const MIN_FIELD_CONTRAST = 3;

/**
 * Which oracle matrix stands in for each vision type. Machado 2009 severity 1.0
 * for all three: it is peer-reviewed for tritan, where the "simple" matrix
 * usually shipped beside Viénot's pair is not trustworthy.
 */
const VISION_TRANSFORMS: readonly (readonly [CvdType, CvdTransformKey])[] = [
  ['deuteranopia', 'machado.deutan'],
  ['protanopia', 'machado.protan'],
  ['tritanopia', 'machado.tritan'],
];

export type CvdRoleColors = Readonly<Partial<Record<HoldColorOverrideRole, string>>>;

export type CvdRoleVerdict =
  /** Every pair clears the ΔE00 bar under every dichromacy, and every role is visible against the field. */
  | { kind: 'clear' }
  /** Two roles collapse into each other. The worst offender across all three vision types. */
  | {
      kind: 'close';
      vision: CvdType;
      roles: readonly [HoldColorOverrideRole, HoldColorOverrideRole];
      deltaE00: number;
    }
  /** Every pair is distinct, but one role barely shows against the board at all. */
  | { kind: 'faint'; role: HoldColorOverrideRole; contrastRatio: number }
  /**
   * A colour this module cannot parse — say, an override written by a future
   * build in a format the oracle does not read. Says nothing rather than
   * guessing; the caller renders no line.
   */
  | { kind: 'unknown' };

const HEX_PATTERN = /^#?[0-9a-f]{6}$/i;

function rolePairs(): readonly (readonly [HoldColorOverrideRole, HoldColorOverrideRole])[] {
  const pairs: (readonly [HoldColorOverrideRole, HoldColorOverrideRole])[] = [];
  for (let first = 0; first < HOLD_COLOR_OVERRIDE_ROLES.length; first += 1) {
    for (let second = first + 1; second < HOLD_COLOR_OVERRIDE_ROLES.length; second += 1) {
      pairs.push([HOLD_COLOR_OVERRIDE_ROLES[first], HOLD_COLOR_OVERRIDE_ROLES[second]]);
    }
  }
  return pairs;
}

const ROLE_PAIRS = rolePairs();

/**
 * The verdict for one set of role colours.
 *
 * A pair collapse outranks a faint role: two roles a climber cannot tell apart
 * is the failure this screen exists to catch, and pointing at a third problem
 * first would bury it.
 *
 * `fieldColor` defaults to the DARK play field — the same one every shipped
 * palette is validated against. Light mode's field is white, brighter than any
 * board's wall, so the veil barely bites there and a light-field number would
 * fail roles that read perfectly well over the photo.
 */
export function evaluateRoleSeparation(
  roleColors: CvdRoleColors,
  fieldColor: string = BOARD_FIELD_COLORS.dark,
): CvdRoleVerdict {
  const colors: Partial<Record<HoldColorOverrideRole, string>> = {};
  for (const role of HOLD_COLOR_OVERRIDE_ROLES) {
    const hex = roleColors[role];
    if (!hex || !HEX_PATTERN.test(hex.trim())) return { kind: 'unknown' };
    colors[role] = hex;
  }
  if (!HEX_PATTERN.test(fieldColor.trim())) return { kind: 'unknown' };

  let worstPair: {
    vision: CvdType;
    roles: readonly [HoldColorOverrideRole, HoldColorOverrideRole];
    deltaE00: number;
  } | null = null;
  for (const [vision, transform] of VISION_TRANSFORMS) {
    for (const pair of ROLE_PAIRS) {
      const deltaE00 = deltaEHex(colors[pair[0]] as string, colors[pair[1]] as string, transform);
      if (deltaE00 >= MIN_ROLE_PAIR_DELTA_E00) continue;
      if (worstPair === null || deltaE00 < worstPair.deltaE00) worstPair = { vision, roles: pair, deltaE00 };
    }
  }
  if (worstPair) return { kind: 'close', ...worstPair };

  let faintest: { role: HoldColorOverrideRole; contrastRatio: number } | null = null;
  for (const role of HOLD_COLOR_OVERRIDE_ROLES) {
    const contrastRatio = contrastRatioHex(colors[role] as string, fieldColor);
    if (contrastRatio >= MIN_FIELD_CONTRAST) continue;
    if (faintest === null || contrastRatio < faintest.contrastRatio) faintest = { role, contrastRatio };
  }
  if (faintest) return { kind: 'faint', ...faintest };

  return { kind: 'clear' };
}
