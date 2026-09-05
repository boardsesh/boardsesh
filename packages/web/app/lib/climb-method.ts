import type { TFunction } from 'i18next';
import { getMoonBoardMethod, isAnyFeet, isCampus, CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';

/**
 * Resolve the translated short label for a climb's MoonBoard method
 * characteristic, or null for the "feet follow hands" default. Each branch uses
 * a string-literal key so the i18n linter can verify the catalog entries.
 */
export function resolveMoonBoardMethodLabel(
  characteristics: string[] | null | undefined,
  t: TFunction<'climbs'>,
): string | null {
  switch (getMoonBoardMethod(characteristics)) {
    case CLIMB_CHARACTERISTICS.METHOD_FOOTLESS:
      return t('card.method.footless');
    case CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD:
      return t('card.method.footlessKickboard');
    case CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD:
      return t('card.method.noKickboard');
    default:
      return null;
  }
}

/**
 * The short "any feet" badge for a climb whose feet may use any hold, not only
 * the marked ones — a departure from the default on every board, so it earns a
 * label next to the climb name the way the MoonBoard method does.
 *
 * Campus (no feet at all) suppresses it: the two are opposite answers to the same
 * question and the editor keeps them exclusive, so a row carrying both is
 * malformed and the stricter rule is the safe read.
 */
export function resolveAnyFeetLabel(
  characteristics: string[] | null | undefined,
  t: TFunction<'climbs'>,
): string | null {
  if (isCampus(characteristics) || !isAnyFeet(characteristics)) return null;
  return t('card.anyFeet');
}
