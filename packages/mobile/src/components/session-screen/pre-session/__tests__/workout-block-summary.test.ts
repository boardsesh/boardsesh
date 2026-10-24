// The one-line summary on a closed block card, for the timed types. Their cards
// are not offered yet, so nothing else renders these lines.
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  type GeneratorOptions,
} from '@boardsesh/playlist-generator';

vi.mock('react-native', () => ({
  DynamicColorIOS: (colors: unknown) => colors,
  Platform: { OS: 'ios', select: (choices: { ios?: unknown }) => choices.ios },
  PlatformColor: (name: string) => name,
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  View: () => null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../AppMenu', () => ({ AppMenu: () => null }));
vi.mock('../../../Card', () => ({ Card: () => null }));
vi.mock('../../../PressableSurface', () => ({ PressableSurface: () => null }));
vi.mock('../../../SectionDisclosureChevron', () => ({ SectionDisclosureChevron: () => null }));
vi.mock('../../../Text', () => ({ Text: () => null }));
vi.mock('../../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({}) }));
vi.mock('../../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));
vi.mock('../../../../providers/theme-provider', () => ({ useTheme: () => ({}) }));
vi.mock('../WorkoutBlockFields', () => ({ WorkoutBlockFields: () => null, warmUpLengthLabel: () => 'warm-up' }));

import { blockSummary } from '../WorkoutBlockCard';

// Echoes the key and its options so the assertions read the inputs directly.
const t = (key: string, options?: Record<string, string | number>) =>
  options ? `${key.replace('mobile.session.preGeneratorBlockSummary', '')}(${Object.values(options).join(',')})` : key;
const formatGrade = (difficultyId: number) => `V${difficultyId}`;
const summaryOf = (options: GeneratorOptions) => blockSummary({ kind: 'workout', options }, formatGrade, null, t);

describe('blockSummary for timed blocks', () => {
  it('says how many climbs and how often on the minute', () => {
    expect(summaryOf({ ...DEFAULT_ON_THE_MINUTE_OPTIONS, targetGrade: 5, intervalSeconds: 75 })).toBe(
      'V5 · Climbs(10) · Every(1:15)',
    );
  });

  it('says a 4x4’s climbs, rounds and round rest, and its climb rest only when there is one', () => {
    expect(summaryOf({ ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 6 })).toBe(
      'V6 · Climbs(4) · Rounds(4) · RoundRest(3:00)',
    );
    expect(
      summaryOf({
        ...DEFAULT_FOUR_BY_FOUR_OPTIONS,
        targetGrade: 6,
        restBetweenClimbsSeconds: 30,
        restBetweenRoundsSeconds: 0,
      }),
    ).toBe('V6 · Climbs(4) · Rounds(4) · ClimbRest(0:30)');
  });

  it('says no rest at all for a 4x4 with both rests at zero', () => {
    expect(
      summaryOf({
        ...DEFAULT_FOUR_BY_FOUR_OPTIONS,
        targetGrade: 6,
        restBetweenClimbsSeconds: 0,
        restBetweenRoundsSeconds: 0,
      }),
    ).toBe('V6 · Climbs(4) · Rounds(4)');
  });

  it('says how many limit climbs and the rest after each attempt', () => {
    expect(summaryOf({ ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 8 })).toBe('V8 · Climbs(3) · Rest(3:00)');
    expect(summaryOf({ ...DEFAULT_LIMIT_BOULDERING_OPTIONS, targetGrade: 8, restSeconds: 0 })).toBe('V8 · Climbs(3)');
  });

  it('leaves the untimed summaries as they were', () => {
    expect(summaryOf({ ...DEFAULT_GRADE_FOCUS_OPTIONS, targetGrade: 4 })).toBe('V4 · Climbs(15)');
  });
});

describe('blockSummary for a ladder', () => {
  it('adds hardest first only when the ladder runs down', () => {
    expect(summaryOf({ ...DEFAULT_LADDER_OPTIONS, targetGrade: 5 })).toBe('V5 · Steps(5) · PerStep(2)');
    expect(summaryOf({ ...DEFAULT_LADDER_OPTIONS, targetGrade: 5, descending: true })).toBe(
      'V5 · Steps(5) · PerStep(2) · mobile.session.preGeneratorBlockSummaryHardestFirst',
    );
  });
});
