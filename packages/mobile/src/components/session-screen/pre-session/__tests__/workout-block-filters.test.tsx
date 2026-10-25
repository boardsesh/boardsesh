// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardName } from '@boardsesh/shared-schema';
import { DEFAULT_WORKOUT_FILTERS, type WorkoutFilters } from '../workout-blocks';

const auth = vi.hoisted(() => ({ isAuthenticated: true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) =>
      options ? `${key}(${Object.values(options).join(',')})` : key,
  }),
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
}));
vi.mock('@boardsesh/board-constants', () => ({ getTallWideScope: () => null }));
vi.mock('../../../../theme/tokens', () => ({ spacing: {} }));
vi.mock('../../../../theme/variants', () => ({
  selectByVariant: (_variant: string, values: { liquidGlass: unknown }) => values.liquidGlass,
}));
// Draws the closed header the section would show: the summary in the title's
// place when it asks for that, else the title.
vi.mock('../../../CollapsibleSection', () => ({
  CollapsibleSection: ({
    title,
    summary,
    hideTitleWhenCollapsed,
    children,
  }: {
    title: string;
    summary?: ReactNode;
    hideTitleWhenCollapsed?: boolean;
    children?: ReactNode;
  }) =>
    createElement(
      'section',
      { 'data-testid': 'filters' },
      createElement('header', { 'data-testid': 'collapsed-header' }, hideTitleWhenCollapsed ? summary : title),
      children,
    ),
}));
vi.mock('../../../StarRating', () => ({ StarRating: () => null }));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
// A checkbox per switch, so a test can read and flip it by its label.
vi.mock('../../../SwitchRow', () => ({
  SwitchRow: ({
    label,
    description,
    value,
    disabled,
    onValueChange,
  }: {
    label: string;
    description?: string;
    value: boolean;
    disabled?: boolean;
    onValueChange: (next: boolean) => void;
  }) =>
    createElement('input', {
      type: 'checkbox',
      'aria-label': label,
      'aria-description': description,
      checked: value,
      disabled,
      onChange: () => onValueChange(!value),
    }),
}));
vi.mock('../generator-controls', () => ({
  Chip: () => null,
  generatorControlStyles: { chipRow: {}, groupedCard: {}, groupDivider: {} },
}));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, variant: 'liquidGlass', m3: {} }),
}));

import { WorkoutBlockFilters, blockFiltersSummary, offersBenchmarksOnly } from '../WorkoutBlockFilters';

const SKIP_SENT = 'mobile.session.preGeneratorSkipSentLabel';
const BENCHMARKS = 'mobile.session.preGeneratorOnlyBenchmarksLabel';
const t = (key: string, options?: Record<string, string | number>) =>
  options ? `${key}(${Object.values(options).join(',')})` : key;

const onFiltersChange = vi.fn<(patch: Partial<WorkoutFilters>) => void>();

function renderFilters(filters: WorkoutFilters = DEFAULT_WORKOUT_FILTERS, boardName: BoardName | null = 'kilter') {
  return render(
    createElement(WorkoutBlockFilters, {
      filters,
      boardName,
      sizeFilters: { tall: false, wide: false },
      onFiltersChange,
    }),
  );
}

const switchNamed = (label: string) => screen.queryByRole('checkbox', { name: label }) as HTMLInputElement | null;

beforeEach(() => {
  auth.isAuthenticated = true;
  onFiltersChange.mockClear();
});

describe('WorkoutBlockFilters', () => {
  it('turns Skip what I have sent and Benchmarks only on for the block', () => {
    renderFilters();

    fireEvent.click(switchNamed(SKIP_SENT) as HTMLInputElement);
    fireEvent.click(switchNamed(BENCHMARKS) as HTMLInputElement);

    expect(onFiltersChange).toHaveBeenNthCalledWith(1, { skipSent: true });
    expect(onFiltersChange).toHaveBeenNthCalledWith(2, { onlyBenchmarks: true });
  });

  it('shows the switches the block has on', () => {
    renderFilters({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true, onlyBenchmarks: true });

    expect(switchNamed(SKIP_SENT)?.checked).toBe(true);
    expect(switchNamed(BENCHMARKS)?.checked).toBe(true);
  });

  it('disables Skip what I have sent signed out, says why, and shows it off', () => {
    auth.isAuthenticated = false;
    renderFilters({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true });

    const skip = switchNamed(SKIP_SENT);
    expect(skip?.disabled).toBe(true);
    expect(skip?.checked).toBe(false);
    expect(skip?.getAttribute('aria-description')).toBe('mobile.session.preGeneratorSkipSentSignedOut');
    expect(screen.getByTestId('collapsed-header').textContent).not.toContain(
      'mobile.session.preGeneratorSkipSentSummary',
    );
  });

  it('shows the title and the whole filter line under it while closed', () => {
    renderFilters({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true, onlyBenchmarks: true });

    const header = screen.getByTestId('collapsed-header');
    expect(header.textContent).toBe(
      'mobile.session.preGeneratorClimbFilters' +
        blockFiltersSummary({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true, onlyBenchmarks: true }, t, true),
    );
    expect(header.textContent).toContain('mobile.session.preGeneratorSkipSentSummary');
    expect(header.textContent).toContain('mobile.session.preGeneratorOnlyBenchmarksSummary');
  });

  it('keeps Benchmarks only usable signed out: benchmarks need no account', () => {
    auth.isAuthenticated = false;
    renderFilters();

    expect(switchNamed(BENCHMARKS)?.disabled).toBeFalsy();
  });

  it('hides Benchmarks only on a spray wall and on Woods', () => {
    renderFilters(DEFAULT_WORKOUT_FILTERS, 'spray');
    expect(switchNamed(BENCHMARKS)).toBeNull();
    expect(switchNamed(SKIP_SENT)).not.toBeNull();
  });

  it('keeps Benchmarks only on screen while it is on, so it can be turned off', () => {
    renderFilters({ ...DEFAULT_WORKOUT_FILTERS, onlyBenchmarks: true }, 'woods');

    fireEvent.click(switchNamed(BENCHMARKS) as HTMLInputElement);

    expect(onFiltersChange).toHaveBeenCalledWith({ onlyBenchmarks: false });
  });
});

describe('offersBenchmarksOnly', () => {
  it('offers it on boards with benchmarks, not on spray walls, Woods, SoILL, Touchstone or an unknown board', () => {
    expect(offersBenchmarksOnly('kilter', DEFAULT_WORKOUT_FILTERS)).toBe(true);
    expect(offersBenchmarksOnly('moonboard', DEFAULT_WORKOUT_FILTERS)).toBe(true);
    expect(offersBenchmarksOnly('spray', DEFAULT_WORKOUT_FILTERS)).toBe(false);
    expect(offersBenchmarksOnly('woods', DEFAULT_WORKOUT_FILTERS)).toBe(false);
    expect(offersBenchmarksOnly('soill', DEFAULT_WORKOUT_FILTERS)).toBe(false);
    expect(offersBenchmarksOnly('touchstone', DEFAULT_WORKOUT_FILTERS)).toBe(false);
    expect(offersBenchmarksOnly(null, DEFAULT_WORKOUT_FILTERS)).toBe(false);
  });
});

describe('blockFiltersSummary', () => {
  it('names the switches that are on, after the climb bias', () => {
    expect(blockFiltersSummary(DEFAULT_WORKOUT_FILTERS, t, true)).toBe(
      'mobile.session.preGeneratorMinAscentsOption(5) · ★★ · mobile.session.preGeneratorClimbBiasUnfamiliar',
    );
    expect(blockFiltersSummary({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true, onlyBenchmarks: true }, t, true)).toBe(
      'mobile.session.preGeneratorMinAscentsOption(5) · ★★ · mobile.session.preGeneratorClimbBiasUnfamiliar · ' +
        'mobile.session.preGeneratorSkipSentSummary · mobile.session.preGeneratorOnlyBenchmarksSummary',
    );
  });
});

describe("Skip what I've tried", () => {
  const SKIP_TRIED = 'mobile.session.preGeneratorSkipTriedLabel';

  it('turns on for the block', () => {
    renderFilters();
    fireEvent.click(switchNamed(SKIP_TRIED) as HTMLInputElement);
    expect(onFiltersChange).toHaveBeenCalledWith({ skipTried: true });
  });

  it('shows on when the block has it on', () => {
    renderFilters({ ...DEFAULT_WORKOUT_FILTERS, skipTried: true });
    expect(switchNamed(SKIP_TRIED)?.checked).toBe(true);
    expect(switchNamed(SKIP_TRIED)?.getAttribute('aria-description')).toBe(
      'mobile.session.preGeneratorSkipTriedDescription',
    );
  });

  it('is disabled signed out, says why, and shows off', () => {
    auth.isAuthenticated = false;
    renderFilters({ ...DEFAULT_WORKOUT_FILTERS, skipTried: true });

    const skip = switchNamed(SKIP_TRIED);
    expect(skip?.disabled).toBe(true);
    expect(skip?.checked).toBe(false);
    expect(skip?.getAttribute('aria-description')).toBe('mobile.session.preGeneratorSkipTriedSignedOut');
    expect(screen.getByTestId('collapsed-header').textContent).not.toContain(
      'mobile.session.preGeneratorSkipTriedSummary',
    );
  });

  it('is disabled under Attempted, which picks climbs you have tried, and says why', () => {
    renderFilters({ ...DEFAULT_WORKOUT_FILTERS, climbBias: 'attempted', skipTried: true });

    const skip = switchNamed(SKIP_TRIED);
    expect(skip?.disabled).toBe(true);
    expect(skip?.checked).toBe(false);
    expect(skip?.getAttribute('aria-description')).toBe('mobile.session.preGeneratorSkipTriedAttempted');
  });

  it('stands in for Skip sent on the closed line, since it leaves sent climbs out too', () => {
    expect(blockFiltersSummary({ ...DEFAULT_WORKOUT_FILTERS, skipSent: true, skipTried: true }, t, true)).toBe(
      'mobile.session.preGeneratorMinAscentsOption(5) · ★★ · mobile.session.preGeneratorClimbBiasUnfamiliar · ' +
        'mobile.session.preGeneratorSkipTriedSummary',
    );
    expect(
      blockFiltersSummary(
        { ...DEFAULT_WORKOUT_FILTERS, climbBias: 'attempted', skipSent: true, skipTried: true },
        t,
        true,
      ),
    ).toBe(
      'mobile.session.preGeneratorMinAscentsOption(5) · ★★ · mobile.session.preGeneratorClimbBiasAttempted · ' +
        'mobile.session.preGeneratorSkipSentSummary',
    );
  });
});
