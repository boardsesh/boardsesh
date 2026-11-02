import type { TFunction } from 'i18next';
import {
  CLIMB_CHARACTERISTICS,
  getMoonBoardMethod,
  isAnyFeet,
  isCampus,
  isNoKickboard,
  isNoMatch,
} from '@boardsesh/shared-schema';

export type ClimbAttributeInput = {
  /** Raw benchmark difficulty; > 0 marks a benchmark/classic climb. */
  benchmarkDifficulty?: string | number | null;
  /**
   * Climb characteristics; preferred source for no-match + MoonBoard method_* tokens.
   * When present, the no-match status is derived from it and `isNoMatch` is ignored.
   */
  characteristics?: readonly string[] | null;
  /**
   * Fallback no-match flag for surfaces that carry the bool but not characteristics
   * (e.g. session-tick rows). Ignored when `characteristics` is provided.
   */
  isNoMatch?: boolean | null;
};

export type ClimbAttributes = {
  isBenchmark: boolean;
  isNoMatchClimb: boolean;
  /** The MoonBoard method, translated; null when the climb names none. */
  method: string | null;
  /** Any feet / campus and no kickboard, translated, in the order they are drawn. */
  extraLabels: string[];
};

// Resolve the translated method label. Each branch uses a string-literal key so
// the i18n orphan/key analyzer can verify the catalog entries.
function methodLabel(characteristics: readonly string[] | null | undefined, t: TFunction<'climbs'>): string | null {
  switch (getMoonBoardMethod(characteristics)) {
    case CLIMB_CHARACTERISTICS.METHOD_FOOTLESS:
      return t('mobile.climbRow.method.footless');
    case CLIMB_CHARACTERISTICS.METHOD_FOOTLESS_KICKBOARD:
      return t('mobile.climbRow.method.footlessKickboard');
    case CLIMB_CHARACTERISTICS.METHOD_NO_KICKBOARD:
      return t('mobile.climbRow.method.noKickboard');
    default:
      return null;
  }
}

/**
 * Text badges for the freely-toggleable any-feet / no-kickboard / campus
 * characteristics — same reasoning as `methodLabel` above: no clean SF-Symbol
 * exists for any of them, so they render as text rather than joining the
 * icon-map.
 *
 * Any-feet is a DEPARTURE from the default on every board (feet normally follow
 * the marked holds), so it earns a badge in a compact row the same way campus
 * does. The play drawer's Woods header says both rules in full instead — see
 * `explicitClimbRules` — and suppresses this cluster's characteristics so the
 * two don't repeat each other.
 */
function extraCharacteristicLabels(
  characteristics: readonly string[] | null | undefined,
  t: TFunction<'climbs'>,
): string[] {
  const labels: string[] = [];
  if (isCampus(characteristics)) labels.push(t('mobile.climbRow.campus'));
  else if (isAnyFeet(characteristics)) labels.push(t('mobile.climbRow.anyFeet'));
  if (isNoKickboard(characteristics)) labels.push(t('mobile.climbRow.noKickboard'));
  return labels;
}

/** What `ClimbAttributeIcons` draws for a climb, before any of it is drawn. */
export function resolveClimbAttributes(
  { benchmarkDifficulty, characteristics, isNoMatch: isNoMatchFallback }: ClimbAttributeInput,
  t: TFunction<'climbs'>,
): ClimbAttributes {
  const benchmarkValue = benchmarkDifficulty != null ? Number(benchmarkDifficulty) : null;
  const isBenchmark = benchmarkValue !== null && benchmarkValue > 0 && !Number.isNaN(benchmarkValue);
  // Prefer the structured characteristics array; fall back to the legacy bool for
  // tick-sourced rows that carry the flag but not the full characteristics array.
  const isNoMatchClimb = characteristics != null ? isNoMatch(characteristics) : (isNoMatchFallback ?? false);
  return {
    isBenchmark,
    isNoMatchClimb,
    method: methodLabel(characteristics, t),
    extraLabels: extraCharacteristicLabels(characteristics, t),
  };
}

/**
 * The same attributes as the words a screen reader hears for them, in the order
 * they are drawn: the benchmark and no-match glyphs' labels, then the method
 * and the other text badges. For a view that speaks for the glyphs instead of
 * exposing them (the play drawer's header stand-in).
 */
export function describeClimbAttributes(input: ClimbAttributeInput, t: TFunction<'climbs'>): string[] {
  const { isBenchmark, isNoMatchClimb, method, extraLabels } = resolveClimbAttributes(input, t);
  return [
    ...(isBenchmark ? [t('mobile.climbRow.benchmark')] : []),
    ...(isNoMatchClimb ? [t('mobile.climbRow.noMatch')] : []),
    ...(method ? [method] : []),
    ...extraLabels,
  ];
}
