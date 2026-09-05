import type { TFunction } from 'i18next';
import { decodeClimbRules, type ClimbRules } from '@boardsesh/play-view';

/**
 * The two rule labels a Woods climb shows under its subtitle, plus the sentence
 * a screen reader hears instead of the middot-joined line.
 *
 * Always two parts, never one: the point of the Woods rules line is that BOTH
 * rules are stated, so a climber never has to work out whether a missing label
 * meant "default" or "we didn't render it". `unknown` is a label of its own for
 * the same reason.
 *
 * Each branch uses a string-literal key so the i18n orphan/key analyzer can
 * verify the catalog entries (`t(variable)` is lint-blocked).
 */
export type ClimbRuleLabels = {
  parts: [string, string];
  accessibilityLabel: string;
};

function matchingLabel(rules: ClimbRules, t: TFunction<'climbs'>): string {
  switch (rules.matching) {
    case 'not_allowed':
      return t('mobile.climbRules.noMatching');
    case 'allowed':
      return t('mobile.climbRules.matchingAllowed');
    default:
      return t('mobile.climbRules.matchingUnknown');
  }
}

function feetLabel(rules: ClimbRules, t: TFunction<'climbs'>): string {
  switch (rules.feet) {
    case 'any_feet':
      return t('mobile.climbRules.anyFeet');
    case 'marked_holds_only':
      return t('mobile.climbRules.markedHoldsOnly');
    case 'no_feet':
      return t('mobile.climbRules.noFeet');
    default:
      return t('mobile.climbRules.feetUnknown');
  }
}

export function resolveClimbRuleLabels(
  characteristics: readonly string[] | null | undefined,
  t: TFunction<'climbs'>,
): ClimbRuleLabels {
  const rules = decodeClimbRules(characteristics);
  const parts: [string, string] = [matchingLabel(rules, t), feetLabel(rules, t)];
  return {
    parts,
    // Spoken as one phrase with the section named, so the rules don't arrive as
    // two bare fragments after the setter and the send count.
    accessibilityLabel: t('mobile.climbRules.spoken', { matching: parts[0], feet: parts[1] }),
  };
}
