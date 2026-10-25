// The one-line summary on a closed block card: the timed types, whose cards are
// not offered yet so nothing else renders these lines, and the warm-up's ramp.
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FOUR_BY_FOUR_OPTIONS,
  DEFAULT_GRADE_FOCUS_OPTIONS,
  DEFAULT_LADDER_OPTIONS,
  DEFAULT_LIMIT_BOULDERING_OPTIONS,
  DEFAULT_ON_THE_MINUTE_OPTIONS,
  type GeneratorOptions,
  type WorkoutBlockSpec,
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

  it('says a 4x4’s reps and sets (reps first), its set rest, and its rest between reps only when there is one', () => {
    expect(summaryOf({ ...DEFAULT_FOUR_BY_FOUR_OPTIONS, targetGrade: 6 })).toBe('V6 · RepsBySets(4,4) · SetRest(3:00)');
    expect(
      summaryOf({
        ...DEFAULT_FOUR_BY_FOUR_OPTIONS,
        targetGrade: 6,
        repsPerSet: 3,
        restBetweenRepsSeconds: 30,
        restBetweenSetsSeconds: 0,
      }),
    ).toBe('V6 · RepsBySets(3,4) · RepRest(0:30)');
  });

  it('says no rest at all for a 4x4 with both rests at zero', () => {
    expect(
      summaryOf({
        ...DEFAULT_FOUR_BY_FOUR_OPTIONS,
        targetGrade: 6,
        restBetweenRepsSeconds: 0,
        restBetweenSetsSeconds: 0,
      }),
    ).toBe('V6 · RepsBySets(4,4)');
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

describe('blockSummary for warm-ups', () => {
  const warmUpBlock: WorkoutBlockSpec = { kind: 'warmUp', warmUpType: 'standard' };

  it('says which grade a warm-up ramps up to', () => {
    expect(blockSummary(warmUpBlock, formatGrade, { direction: 'up', grade: 6 }, t)).toBe(
      'warm-up · mobile.session.preGeneratorWarmUpSummaryRamps(V6)',
    );
  });

  it('says a warm-up after the last block eases off from that block’s grade', () => {
    expect(blockSummary(warmUpBlock, formatGrade, { direction: 'down', grade: 5 }, t)).toBe(
      'warm-up · mobile.session.preGeneratorCoolDownSummaryEasesOff(V5)',
    );
  });

  it('says a warm-up with no workout block on either side needs one', () => {
    expect(blockSummary(warmUpBlock, formatGrade, null, t, true)).toBe(
      'warm-up · mobile.session.preGeneratorWarmUpSummaryNoTarget · mobile.session.preGeneratorBlockSummaryFiltered',
    );
  });
});
