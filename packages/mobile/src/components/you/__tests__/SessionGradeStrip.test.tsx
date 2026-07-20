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

  it('anchors the axis at V0: prepends empty floor bars below the lowest send', () => {
    state.bars = bars([
      ['V3', 2, 'color-V3'],
      ['V5', 4, 'color-V5'],
      ['V6', 1, 'color-V6'],
    ]);
    const { container } = render(createElement(SessionGradeStrip, { distribution, totalSends: 7 }));
    const els = barEls(container);
    // V0, V1, V2 floor bars are synthesized in front of the three real grades.
    expect(els).toHaveLength(6);
    // Floor bars carry count 0 → the 8px minimum height; the real bars keep their
    // count-proportional heights (maxCount = 4 → V5 = 20; V3 = round(2/4*20)=10;
    // V6 = max(8, round(1/4*20)=5)=8).
    expect(els.map((node) => node.getAttribute('data-h'))).toEqual(['8', '8', '8', '10', '20', '8']);
    // Floor bars have no explicit segment colour → fall back to gradeChartColor(key).
    expect(els.map((node) => node.getAttribute('data-bg'))).toEqual([
      'color-V0',
      'color-V1',
      'color-V2',
      'color-V3',
      'color-V5',
      'color-V6',
    ]);
  });

  it('leaves the axis untouched when the lowest send is already V0', () => {
    state.bars = bars([
      ['V0', 2, 'color-V0'],
      ['V2', 1, 'color-V2'],
    ]);
    const { container } = render(createElement(SessionGradeStrip, { distribution, totalSends: 3 }));
    const els = barEls(container);
    expect(els).toHaveLength(2);
    expect(els.map((node) => node.getAttribute('data-bg'))).toEqual(['color-V0', 'color-V2']);
  });
});
