// @vitest-environment jsdom
//
// The holds chips: a resting chip is a fill capsule with a transparent 1 pt
// border, a picked one the selection wash with a visible 1 pt ring, so the
// chip keeps its size and its label stays put when it is tapped
// (docs/design/mobile-chrome.md).
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type ChipStyle = { borderWidth?: number; borderColor?: string; backgroundColor?: string };
const chips = vi.hoisted(() => ({ styles: new Map<string, ChipStyle>() }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    style,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    style: (ChipStyle | false | undefined)[];
    accessibilityLabel: string;
  }) => {
    chips.styles.set(accessibilityLabel, Object.assign({}, ...style.filter(Boolean)));
    return createElement('button', { type: 'button' }, children);
  },
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { fill: 'FILL', separator: 'SEPARATOR' },
    selection: { checkmark: 'RING', fill: 'WASH', text: 'LABEL' },
  }),
}));
vi.mock('../../../theme/tokens', () => ({
  opacity: { disabled: 0.5 },
  spacing: { 1: 4, 2: 8, 3: 12 },
  borderRadius: { full: 999 },
}));

const { BoardConfigChips } = await import('../BoardConfigChips');

describe('BoardConfigChips', () => {
  it('draws resting as a fill capsule and picked as a ringed wash, both with a 1 pt border', () => {
    render(
      createElement(BoardConfigChips<number>, {
        groupLabel: 'Holds',
        options: [
          { key: 1, label: 'Bolt-ons', value: 1, selected: true },
          { key: 2, label: 'Screw-ons', value: 2, selected: false },
        ],
        onSelect: vi.fn(),
      }),
    );
    expect(chips.styles.get('Holds: Bolt-ons')).toMatchObject({
      borderWidth: 1,
      borderColor: 'RING',
      backgroundColor: 'WASH',
    });
    expect(chips.styles.get('Holds: Screw-ons')).toMatchObject({
      borderWidth: 1,
      borderColor: 'transparent',
      backgroundColor: 'FILL',
    });
  });
});
