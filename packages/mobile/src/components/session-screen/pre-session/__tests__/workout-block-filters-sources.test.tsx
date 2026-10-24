// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbBias } from '@boardsesh/playlist-generator';
import { DEFAULT_WORKOUT_FILTERS, type WorkoutFilters } from '../workout-blocks';

const auth = vi.hoisted(() => ({ isAuthenticated: true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string | number>) => {
      if (key === 'mobile.session.preGeneratorOptionAccessibilityLabel' && options) {
        return `${options.group}, ${options.value}`;
      }
      return options ? `${key}(${Object.values(options).join(',')})` : key;
    },
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
vi.mock('../../../CollapsibleSection', () => ({
  CollapsibleSection: ({ summary, children }: { summary?: ReactNode; children?: ReactNode }) =>
    createElement('section', null, createElement('header', { 'data-testid': 'collapsed-header' }, summary), children),
}));
vi.mock('../../../StarRating', () => ({
  StarRating: () => createElement('div', { 'data-testid': 'min-rating-stars' }),
}));
vi.mock('../../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
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
// A button per chip, named by its accessibility label and pressed state.
vi.mock('../generator-controls', () => ({
  Chip: ({
    selected,
    onPress,
    accessibilityLabel,
  }: {
    selected: boolean;
    onPress: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { onClick: onPress, 'aria-label': accessibilityLabel, 'aria-pressed': selected }),
  generatorControlStyles: { chipRow: {}, groupedCard: {}, groupDivider: {} },
}));
vi.mock('../../../../providers/auth-provider', () => ({ useAuth: () => auth }));
vi.mock('../../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: {}, variant: 'liquidGlass', m3: {} }),
}));

import { WorkoutBlockFilters, blockAppliesFloors, blockFiltersSummary } from '../WorkoutBlockFilters';

const BIAS_GROUP = 'mobile.session.preGeneratorClimbBias';
const SKIP_SENT = 'mobile.session.preGeneratorSkipSentLabel';
const SKIP_TRIED = 'mobile.session.preGeneratorSkipTriedLabel';
const NOT_WITH_SENT = 'mobile.session.preGeneratorSkipNotWithSent';
const t = (key: string, options?: Record<string, string | number>) =>
  options ? `${key}(${Object.values(options).join(',')})` : key;

const onFiltersChange = vi.fn<(patch: Partial<WorkoutFilters>) => void>();

function renderFilters(filters: WorkoutFilters) {
  return render(
    createElement(WorkoutBlockFilters, {
      filters,
      boardName: 'kilter',
      sizeFilters: { tall: false, wide: false },
      onFiltersChange,
    }),
  );
}

const withBias = (climbBias: ClimbBias, extra: Partial<WorkoutFilters> = {}): WorkoutFilters => ({
  ...DEFAULT_WORKOUT_FILTERS,
  climbBias,
  ...extra,
});
const biasChip = (labelKey: string) => screen.getByRole('button', { name: `${BIAS_GROUP}, ${labelKey}` });
const switchNamed = (label: string) => screen.getByRole('checkbox', { name: label }) as HTMLInputElement;
const minAscentsChips = () =>
  screen.queryAllByRole('button', { name: /^mobile\.session\.preGeneratorMinAscents, / }).length;

beforeEach(() => {
  auth.isAuthenticated = true;
  onFiltersChange.mockClear();
});

describe('the climb bias chips', () => {
  it('offers Sent and Liked beside the others and picks one for the block', () => {
    renderFilters(DEFAULT_WORKOUT_FILTERS);

    expect(biasChip('mobile.session.preGeneratorClimbBiasUnfamiliar').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(biasChip('mobile.session.preGeneratorClimbBiasSent'));
    fireEvent.click(biasChip('mobile.session.preGeneratorClimbBiasLiked'));

    expect(onFiltersChange).toHaveBeenNthCalledWith(1, { climbBias: 'sent' });
    expect(onFiltersChange).toHaveBeenNthCalledWith(2, { climbBias: 'liked' });
  });

  it('says under the chips which climbs the picked bias fills the block from', () => {
    renderFilters(withBias('liked'));

    expect(screen.getByText('mobile.session.preGeneratorClimbBiasLikedDescription')).toBeTruthy();
  });

  it('says signed out that any climb fills the block', () => {
    auth.isAuthenticated = false;
    renderFilters(withBias('sent'));

    expect(screen.getByText('mobile.session.preGeneratorClimbBiasSignedOut')).toBeTruthy();
    expect(screen.queryByText('mobile.session.preGeneratorClimbBiasSentDescription')).toBeNull();
  });
});

describe('min ascents and min rating under your own climbs', () => {
  it('shows them for the catalogue biases', () => {
    renderFilters(withBias('unfamiliar'));

    expect(minAscentsChips()).toBeGreaterThan(0);
    expect(screen.getByTestId('min-rating-stars')).toBeTruthy();
  });

  it('hides them under Sent and Liked, which do not apply them', () => {
    for (const climbBias of ['sent', 'liked'] as const) {
      const { unmount } = renderFilters(withBias(climbBias));
      expect(minAscentsChips()).toBe(0);
      expect(screen.queryByTestId('min-rating-stars')).toBeNull();
      unmount();
    }
  });

  it('shows them signed out, where the bias falls back to any climb and they apply', () => {
    auth.isAuthenticated = false;
    renderFilters(withBias('liked'));

    expect(minAscentsChips()).toBeGreaterThan(0);
    expect(blockAppliesFloors(withBias('liked'), false)).toBe(true);
  });
});

describe('the skip switches under Sent and Liked', () => {
  it('disables both under Sent, shows them off and says why', () => {
    renderFilters(withBias('sent', { skipSent: true, skipTried: true }));

    for (const label of [SKIP_SENT, SKIP_TRIED]) {
      const skip = switchNamed(label);
      expect(skip.disabled).toBe(true);
      expect(skip.checked).toBe(false);
      expect(skip.getAttribute('aria-description')).toBe(NOT_WITH_SENT);
    }
  });

  it('keeps both under Liked', () => {
    renderFilters(withBias('liked', { skipSent: true }));

    expect(switchNamed(SKIP_SENT).disabled).toBe(false);
    expect(switchNamed(SKIP_SENT).checked).toBe(true);
    fireEvent.click(switchNamed(SKIP_TRIED));
    expect(onFiltersChange).toHaveBeenCalledWith({ skipTried: true });
  });
});

describe('blockFiltersSummary under your own climbs', () => {
  it('leaves out the floors and the skip switches the bias does not apply', () => {
    expect(blockFiltersSummary(withBias('sent', { skipSent: true, skipTried: true }), t)).toBe(
      'mobile.session.preGeneratorClimbBiasSent',
    );
    expect(blockFiltersSummary(withBias('liked', { skipSent: true, onlyBenchmarks: true }), t)).toBe(
      'mobile.session.preGeneratorClimbBiasLiked · mobile.session.preGeneratorSkipSentSummary · ' +
        'mobile.session.preGeneratorOnlyBenchmarksSummary',
    );
  });

  it('shows the floors and no skip switch signed out', () => {
    expect(blockFiltersSummary(withBias('liked', { skipSent: true }), t, false)).toBe(
      'mobile.session.preGeneratorMinAscentsOption(5) · ★★ · mobile.session.preGeneratorClimbBiasLiked',
    );
  });

  it('is the closed header of the filters', () => {
    renderFilters(withBias('liked'));

    expect(screen.getByTestId('collapsed-header').textContent).toContain('mobile.session.preGeneratorClimbBiasLiked');
    expect(screen.getByTestId('collapsed-header').textContent).not.toContain(
      'mobile.session.preGeneratorMinAscentsOption',
    );
  });
});
