// @vitest-environment jsdom
// The browser AppMenu's glyph anchor: a 44pt circle by default, or the caller's
// toolbar slot when it passes `anchorSize`.
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({ StyleSheet: { create: <T,>(styles: T): T => styles } }));
vi.mock('react-native-paper', () => ({
  Menu: Object.assign(
    ({ anchor, children }: { anchor: ReactNode; children?: ReactNode }) => createElement('div', null, anchor, children),
    { Item: ({ title }: { title: string }) => createElement('span', null, title) },
  ),
  Divider: () => createElement('hr'),
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    m3: { error: 'error' },
    systemColors: { label: 'label', secondaryLabel: 'secondaryLabel', tertiaryLabel: 'tertiaryLabel', fill: 'fill' },
  }),
}));
vi.mock('../../hooks/use-typography-styles', () => ({
  useTypographyStyles: <T,>(create: (textStyles: { body: { fontSize: number } }) => T): T =>
    create({ body: { fontSize: 17 } }),
}));
vi.mock('../../theme/tokens', () => ({ spacing: { 1: 4, 2: 8 } }));
vi.mock('../Text', () => ({ Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children) }));
vi.mock('../PressableSurface', () => ({
  PressableSurface: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement(
      'button',
      { 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))) },
      children,
    ),
}));

import { AppMenu } from '../AppMenu.web';
import type { AppMenuProps } from '../AppMenu.types';

const anchorStyle = (container: HTMLElement) =>
  JSON.parse(container.querySelector('button')?.getAttribute('data-style') ?? '{}') as Record<string, unknown>;

describe('AppMenu (web) glyph anchor', () => {
  const props: AppMenuProps = {
    iconName: 'more',
    iconAppearance: 'plain',
    accessibilityLabel: 'More',
    actions: [],
    onSelectIndex: vi.fn(),
  };

  it('keeps the 44pt circle by default', () => {
    const { container } = render(createElement(AppMenu, props));
    expect(anchorStyle(container)).toMatchObject({ width: 44, height: 44, borderRadius: 22 });
  });

  it('takes the toolbar slot it is given', () => {
    const { container } = render(createElement(AppMenu, { ...props, anchorSize: 38 }));
    expect(anchorStyle(container)).toMatchObject({ width: 38, height: 38, borderRadius: 19 });
  });
});
