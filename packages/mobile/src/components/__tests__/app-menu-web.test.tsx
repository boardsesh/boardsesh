// @vitest-environment jsdom
// The browser AppMenu's glyph anchor: a 44pt circle by default, or the caller's
// toolbar slot when it passes `anchorSize`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T): T => styles },
  View: ({
    children,
    style: _style,
    accessible: _accessible,
    ...props
  }: {
    children?: ReactNode;
    style?: unknown;
    accessible?: boolean;
  }) => createElement('div', props, children),
}));
vi.mock('react-native-paper', () => ({
  Menu: Object.assign(
    ({ anchor, children, visible }: { anchor: ReactNode; children?: ReactNode; visible?: boolean }) =>
      createElement('div', { 'data-menu-visible': String(Boolean(visible)) }, anchor, children),
    {
      Item: ({ title, onPress }: { title: string; onPress?: () => void }) =>
        createElement('button', { onClick: onPress }, title),
    },
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
  PressableSurface: ({ children, style, onPress }: { children?: ReactNode; style?: unknown; onPress?: () => void }) =>
    createElement(
      'button',
      { 'data-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))), onClick: onPress },
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

describe('AppMenu (web) long-press anchor', () => {
  afterEach(() => vi.useRealTimers());

  const renderRowMenu = () => {
    const onRowPress = vi.fn();
    const onSelectIndex = vi.fn();
    const result = render(
      createElement(AppMenu, {
        trigger: 'longPress',
        children: createElement('button', { onClick: onRowPress }, 'Climb row'),
        actions: [{ label: 'Share' }],
        onSelectIndex,
      }),
    );
    const row = result.getByText('Climb row');
    return { ...result, row, anchor: row.parentElement!, onRowPress, onSelectIndex };
  };

  it('opens on right click and prevents the browser menu without activating the row', () => {
    const { container, anchor, onRowPress, getByText, onSelectIndex } = renderRowMenu();
    const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(anchor, contextEvent);
    expect(contextEvent.defaultPrevented).toBe(true);
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('true');
    expect(onRowPress).not.toHaveBeenCalled();
    fireEvent.click(getByText('Share'));
    expect(onSelectIndex).toHaveBeenCalledWith(0);
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('false');
  });

  it('leaves the browser context menu available when no app actions exist', () => {
    const { getByText, container } = render(
      createElement(AppMenu, {
        trigger: 'longPress',
        children: createElement('button', null, 'Unavailable climb'),
        actions: [],
        onSelectIndex: vi.fn(),
      }),
    );
    const contextEvent = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(getByText('Unavailable climb'), contextEvent);
    expect(contextEvent.defaultPrevented).toBe(false);
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('false');
  });

  it('opens after a hold and consumes its release click, while the next short tap still activates the row', () => {
    vi.useFakeTimers();
    const { container, anchor, row, onRowPress } = renderRowMenu();
    fireEvent(anchor, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('true');
    fireEvent(anchor, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    fireEvent.click(row);
    expect(onRowPress).not.toHaveBeenCalled();
    fireEvent(anchor, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fireEvent(anchor, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    fireEvent.click(row);
    expect(onRowPress).toHaveBeenCalledOnce();
  });

  it('cancels a hold when a scroll or swipe moves beyond the tap tolerance', () => {
    vi.useFakeTimers();
    const { container, anchor } = renderRowMenu();
    fireEvent(anchor, new MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    fireEvent(anchor, new MouseEvent('pointermove', { bubbles: true, clientX: 40, clientY: 10 }));
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(container.querySelector('[data-menu-visible]')?.getAttribute('data-menu-visible')).toBe('false');
  });
});
