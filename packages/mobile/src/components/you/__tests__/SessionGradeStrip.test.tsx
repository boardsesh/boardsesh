// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionGradeDistributionItem } from '@boardsesh/shared-schema';

type Bar = { key: string; label: string; segments: Array<{ value: number; color: string }> };

const state = vi.hoisted(() => ({ bars: null as Bar[] | null }));

vi.mock('react-native', () => ({
  View: ({ style, children }: { style?: unknown; children?: ReactNode }) => {
    const flat = Array.isArray(style)
      ? Object.assign({}, ...style.filter(Boolean))
      : ((style as Record<string, unknown>) ?? {});
    return createElement(
      'div',
      {
        'data-h': flat.height != null ? String(flat.height) : '',
        'data-bg': typeof flat.backgroundColor === 'string' ? flat.backgroundColor : '',
      },
      children,
    );
  },
  StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../profile-chart-colors', () => ({
  buildSessionGradeBars: () => state.bars,
  gradeChartColor: (g: string) => `color-${g}`,
}));
vi.mock('../../../hooks/use-grade-format', () => ({ useGradeFormat: () => ({ formatGrade: (g: string) => g }) }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { tertiaryLabel: '#999', secondaryLabel: '#666' }, colorScheme: 'light' }),
}));
vi.mock('../../../theme/tokens', () => ({
  spacing: { 1: 4, 2: 8 },
  borderRadius: { sm: 4 },
  opacity: { peek: 0.62 },
}));

import { SessionGradeStrip } from '../SessionGradeStrip';

const distribution: SessionGradeDistributionItem[] = [];

function bars(values: Array<[string, number, string]>): Bar[] {
  return values.map(([key, value, color]) => ({ key, label: key, segments: [{ value, color }] }));
}

function barEls(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-bg]')).filter((node) => node.getAttribute('data-bg'));
}

describe('SessionGradeStrip', () => {
  it('renders nothing when fewer than 2 grades', () => {
    state.bars = bars([['V5', 4, 'color-V5']]);
    const { container } = render(createElement(SessionGradeStrip, { distribution, totalSends: 4 }));
    expect(barEls(container)).toHaveLength(0);

    state.bars = null;
    const { container: empty } = render(createElement(SessionGradeStrip, { distribution, totalSends: 0 }));
    expect(barEls(empty)).toHaveLength(0);
  });

  it('renders one grade-coloured bar per grade with height proportional to count (8px floor, 20px max)', () => {
    state.bars = bars([
      ['V3', 2, 'color-V3'],
      ['V5', 4, 'color-V5'],
      ['V6', 1, 'color-V6'],
    ]);
    const { container } = render(createElement(SessionGradeStrip, { distribution, totalSends: 7 }));
    const els = barEls(container);
    expect(els).toHaveLength(3);
    // maxCount = 4 → V5 = 20; V3 = round(2/4*20)=10; V6 = max(8, round(1/4*20)=5)=8 (floor).
    expect(els.map((node) => node.getAttribute('data-h'))).toEqual(['10', '20', '8']);
    expect(els.map((node) => node.getAttribute('data-bg'))).toEqual(['color-V3', 'color-V5', 'color-V6']);
  });
});
