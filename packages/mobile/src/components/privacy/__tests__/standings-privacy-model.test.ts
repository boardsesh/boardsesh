import { describe, expect, it, vi } from 'vitest';
import {
  buildStandingsPrivacySections,
  effectiveGymVisibility,
  type StandingsPrivacyModelInput,
} from '../standings-privacy-model';

const translate = (key: string) => key;
function input(overrides: Partial<StandingsPrivacyModelInput> = {}): StandingsPrivacyModelInput {
  return {
    settings: { leaderboardVisibility: 'public', gymScreenVisibility: 'public' },
    loading: false,
    loadFailed: false,
    onRetry: vi.fn(),
    onSelect: vi.fn(),
    ...overrides,
  };
}

describe('standings within the privacy form', () => {
  it('offers both independent saved choices with descriptions of existing privacy precedence', () => {
    const onSelect = vi.fn();
    const model = input({ onSelect });
    const sections = buildStandingsPrivacySections(model, translate, false);
    const appRow = sections[0].rows[0];
    const gymRow = sections[1].rows[0];
    if (appRow.kind !== 'select' || gymRow.kind !== 'select') throw new Error('Missing standings selects');
    expect(appRow.options.map((option) => option.key)).toEqual(['public', 'anonymous', 'off']);
    expect(sections[0].footer).toContain('settings:standings.privacyPrecedence');
    appRow.onSelect('anonymous');
    gymRow.onSelect('off');
    expect(onSelect.mock.calls).toEqual([
      ['leaderboardVisibility', 'anonymous'],
      ['gymScreenVisibility', 'off'],
    ]);
  });

  it('keeps the saved gym choice but describes the stricter app ceiling', () => {
    const sections = buildStandingsPrivacySections(
      input({ settings: { leaderboardVisibility: 'off', gymScreenVisibility: 'public' } }),
      translate,
      false,
    );
    expect(sections[1].rows[0]).toMatchObject({ selectedKey: 'public' });
    expect(sections[1].footer).toContain('settings:standings.options.off.subtitle');
  });

  it('inherits the shared offline or pending-write lock', () => {
    const sections = buildStandingsPrivacySections(input(), translate, true);
    expect(sections.flatMap((section) => section.rows).every((row) => 'disabled' in row && row.disabled)).toBe(true);
  });

  it.each([
    ['public', 'public', 'public'],
    ['public', 'anonymous', 'anonymous'],
    ['public', 'off', 'off'],
    ['anonymous', 'public', 'anonymous'],
    ['anonymous', 'anonymous', 'anonymous'],
    ['anonymous', 'off', 'off'],
    ['off', 'public', 'off'],
    ['off', 'anonymous', 'off'],
    ['off', 'off', 'off'],
  ] as const)('app=%s and gym=%s describes %s', (leaderboardVisibility, gymScreenVisibility, effective) => {
    expect(effectiveGymVisibility({ leaderboardVisibility, gymScreenVisibility })).toBe(effective);
  });
});
