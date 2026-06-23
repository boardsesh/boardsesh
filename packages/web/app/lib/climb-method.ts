import type { TFunction } from 'i18next';
import { getMoonBoardMethod, CLIMB_CHARACTERISTICS } from '@boardsesh/shared-schema';

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
