// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The hairline and the disclosure chevron are shared by every grouped list, so
// they must follow the theme (dark mode, Increase Contrast) rather than a fixed
// light-mode gray. The mocked theme uses distinct values per role so a test can
// tell which role a primitive picked.
const THEME_SEPARATOR = '#separator';
const THEME_TERTIARY_LABEL = '#tertiary-label';

type StyleInput = Record<string, unknown> | false | null | undefined | StyleInput[];

function flattenStyle(style: StyleInput): Record<string, unknown> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style;
}

vi.mock('react-native', () => ({
  View: ({ children, style }: { children?: ReactNode; style?: StyleInput }) =>
    createElement(
      'div',
      { 'data-background': flattenStyle(style ?? null).backgroundColor as string | undefined },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      separator: THEME_SEPARATOR,
      tertiaryLabel: THEME_TERTIARY_LABEL,
      secondaryLabel: '#secondary-label',
    },
  }),
}));
vi.mock('../../lib/haptics', () => ({ hapticLight: vi.fn() }));
vi.mock('../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) =>
    createElement('i', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children }: { children?: ReactNode }) => createElement('button', null, children),
}));

import { Separator } from '../Separator';
import { ListRow } from '../ListRow';

afterEach(() => {
  cleanup();
});

describe('shared list primitives follow the theme', () => {
  it('draws the Separator hairline in the theme separator colour', () => {
    const { container } = render(createElement(Separator, { inset: 16 }));
    expect(container.querySelector('[data-background]')?.getAttribute('data-background')).toBe(THEME_SEPARATOR);
  });

  it('draws the ListRow chevron in tertiaryLabel and its hairline in the theme separator', () => {
    const { container } = render(createElement(ListRow, { title: 'Row', showChevron: true, onPress: vi.fn() }));

    const chevron = container.querySelector('[data-icon="chevron.right"]');
    expect(chevron?.getAttribute('data-color')).toBe(THEME_TERTIARY_LABEL);

    const backgrounds = Array.from(container.querySelectorAll('[data-background]'), (node) =>
      node.getAttribute('data-background'),
    );
    expect(backgrounds).toContain(THEME_SEPARATOR);
  });
});
