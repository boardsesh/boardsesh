// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { createElement, createRef, type ReactNode } from 'react';
import type { AppMenuHandle } from '../AppMenu.types';

// The Compose tree can't mount under vitest, so each Compose primitive renders as
// a tagged DOM node: enough to tell an IconButton from a Text.
vi.mock('@expo/ui', () => ({
  Host: ({
    children,
    accessibilityLabel,
    accessibilityRole,
    accessible,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessible?: boolean;
  }) =>
    createElement(
      'div',
      {
        'data-host': true,
        'aria-label': accessibilityLabel,
        'data-role': accessibilityRole,
        'data-host-accessible': String(accessible),
      },
      children,
    ),
}));
// Each ticked item's `selectable` handler and its own click, as one render drew them.
const selectableHandlers = vi.hoisted(() => [] as { select: () => void; click?: () => void }[]);
vi.mock('@expo/ui/jetpack-compose', () => {
  const DropdownMenu = ({ children, expanded }: { children?: ReactNode; expanded?: boolean }) =>
    createElement('div', { 'data-expanded': String(Boolean(expanded)) }, children);
  DropdownMenu.Trigger = ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-trigger': true }, children);
  DropdownMenu.Items = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const DropdownMenuItem = ({
    children,
    onClick,
    modifiers,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    modifiers?: { kind?: string; selected?: boolean; handler?: () => void }[];
  }) => {
    const selectable = modifiers?.find((modifier) => modifier.kind === 'selectable');
    if (selectable?.handler) selectableHandlers.push({ select: selectable.handler, click: onClick });
    return createElement('div', { 'data-item': true, 'data-selected': selectable?.selected, onClick }, children);
  };
  DropdownMenuItem.LeadingIcon = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  DropdownMenuItem.Text = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    DropdownMenu,
    DropdownMenuItem,
    Row: ({
      children,
      modifiers,
    }: {
      children?: ReactNode;
      modifiers?: { kind?: string; minHeight?: number; handler?: () => void }[];
    }) =>
      createElement(
        'div',
        {
          'data-row': true,
          'data-min-height': modifiers?.find((modifier) => modifier.kind === 'defaultMinSize')?.minHeight,
          onClick: modifiers?.find((modifier) => modifier.kind === 'clickable')?.handler,
        },
        children,
      ),
    Column: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-column': true }, children),
    Box: () => createElement('div', { 'data-compose-box': true }),
    Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-compose-text': true }, children),
    IconButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
      createElement('button', { 'data-icon-button': true, onClick }, children),
    Icon: ({ size, tint }: { size?: number; tint?: string }) =>
      createElement('i', { 'data-compose-icon': true, 'data-size': size, 'data-tint': tint }),
    HorizontalDivider: () => createElement('hr'),
    RNHostView: ({ children, matchContents }: { children?: ReactNode; matchContents?: boolean }) =>
      createElement('div', { 'data-rn-match-contents': String(Boolean(matchContents)) }, children),
  };
});
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({
  clickable: (handler: () => void) => ({ kind: 'clickable', handler }),
  defaultMinSize: ({ minHeight }: { minHeight?: number }) => ({ kind: 'defaultMinSize', minHeight }),
  fillMaxSize: () => ({}),
  padding: () => ({}),
  selectable: (selected: boolean, handler: () => void) => ({ kind: 'selectable', selected, handler }),
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  View: ({
    children,
    onLayout,
  }: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
  }) =>
    createElement(
      'div',
      {
        'data-measured-menu-anchor': onLayout ? true : undefined,
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { width: 326 } } }) : undefined,
      },
      children,
    ),
  Pressable: ({
    children,
    onLongPress,
    accessible,
    focusable,
  }: {
    children?: ReactNode;
    onLongPress?: () => void;
    accessible?: boolean;
    focusable?: boolean;
  }) =>
    createElement(
      'div',
      {
        onContextMenu: onLongPress,
        'data-long-press-anchor': true,
        'data-accessible': String(accessible),
        'data-focusable': String(focusable),
      },
      children,
    ),
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../providers/theme-provider', async () => {
  const { makeThemeMock } = await import('../../test/theme-mock');
  const theme = makeThemeMock({ variant: 'material' });
  return { useTheme: () => theme };
});

vi.mock('../AppMenu.icons.android', () => ({ MORE_VERT_ICON: 1 }));

import { AppMenu } from '../AppMenu.android';
import { makeThemeMock } from '../../test/theme-mock';

const ACTIONS = [{ label: 'Share' }, { label: 'Delete', destructive: true }];

describe('AppMenu (Android) overflow anchor', () => {
  it('is an M3 IconButton with a 24dp onSurfaceVariant icon, not a "⋯" in text', () => {
    const { systemColors } = makeThemeMock({ variant: 'material' });
    const { container } = render(
      createElement(AppMenu, {
        iconName: 'more',
        actions: ACTIONS,
        onSelectIndex: vi.fn(),
        accessibilityLabel: 'More',
      }),
    );
    const trigger = container.querySelector('[data-trigger]');
    const iconButton = trigger?.querySelector('[data-icon-button]');
    expect(iconButton).not.toBeNull();
    const icon = iconButton?.querySelector('[data-compose-icon]');
    expect(icon?.getAttribute('data-size')).toBe('24');
    expect(icon?.getAttribute('data-tint')).toBe(systemColors.secondaryLabel);
    // No text glyph anywhere in the trigger.
    expect(trigger?.querySelector('[data-compose-text]')).toBeNull();
    expect(trigger?.textContent).not.toContain('⋯');
    expect(container.querySelector('[data-host]')?.getAttribute('aria-label')).toBe('More');
  });

  it('opens the menu from the IconButton', () => {
    const { container } = render(
      createElement(AppMenu, {
        iconName: 'more.vertical',
        actions: ACTIONS,
        onSelectIndex: vi.fn(),
        accessibilityLabel: 'More',
      }),
    );
    const menu = () => container.querySelector('[data-expanded]');
    expect(menu()?.getAttribute('data-expanded')).toBe('false');
    fireEvent.click(container.querySelector('[data-icon-button]') as Element);
    expect(menu()?.getAttribute('data-expanded')).toBe('true');
  });

  it('keeps a text anchor as text', () => {
    const { container } = render(
      createElement(AppMenu, { label: 'My crew', actions: ACTIONS, onSelectIndex: vi.fn() }),
    );
    expect(container.querySelector('[data-trigger] [data-icon-button]')).toBeNull();
    expect(container.querySelector('[data-trigger]')?.textContent).toContain('My crew');
  });

  // The board sheet's Keep lighting row and Settings › Board's select rows are
  // this anchor alone: Material's 48dp minimum, not a 32dp line of text.
  it('gives a text anchor a 48dp minimum touch height', () => {
    const { container } = render(
      createElement(AppMenu, { label: '45 seconds', actions: ACTIONS, onSelectIndex: vi.fn() }),
    );
    expect(container.querySelector('[data-trigger] > [data-row]')?.getAttribute('data-min-height')).toBe('48');
  });

  it('stacks a headline over the label as one title-menu and reads both', () => {
    const { container } = render(
      createElement(AppMenu, { label: 'My crew', headline: 'Home', actions: ACTIONS, onSelectIndex: vi.fn() }),
    );
    const column = container.querySelector('[data-trigger] > [data-column]');
    const texts = Array.from(column?.querySelectorAll('[data-compose-text]') ?? []).map((text) => text.textContent);
    expect(texts).toEqual(['Home', 'My crew', ' ▾']);
    expect(container.querySelector('[data-host]')?.getAttribute('aria-label')).toBe('Home, My crew');
  });
});

describe('AppMenu (Android) dividers', () => {
  it('keeps a custom row in React Native and mounts its menu host only on a hold', () => {
    const onRowPress = vi.fn();
    const onSelectIndex = vi.fn();
    const { container, getByText } = render(
      createElement(AppMenu, {
        trigger: 'longPress',
        children: createElement('button', { onClick: onRowPress }, 'Climb row'),
        accessibilityLabel: 'Climb actions',
        actions: [{ label: 'Blocked', disabled: true }, { label: 'Share' }],
        onSelectIndex,
      }),
    );
    // No Compose host for a row nobody held, and the row never sits inside one:
    // Compose RNHostView content can draw blank on Android.
    expect(container.querySelector('[data-host]')).toBeNull();
    expect(container.querySelector('[data-rn-match-contents]')).toBeNull();
    const anchor = container.querySelector('[data-long-press-anchor]') as Element;
    expect(anchor.getAttribute('data-accessible')).toBe('false');
    expect(anchor.getAttribute('data-focusable')).toBe('false');
    const row = getByText('Climb row');
    fireEvent.click(row);
    expect(onRowPress).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-host]')).toBeNull();

    fireEvent.contextMenu(anchor);
    const menu = () => container.querySelector('[data-expanded]')?.getAttribute('data-expanded');
    expect(menu()).toBe('true');
    const host = container.querySelector('[data-host]');
    expect(host?.getAttribute('data-host-accessible')).toBe('false');
    expect(host?.hasAttribute('aria-label')).toBe(false);
    expect(getByText('Climb row')).toBe(row);
    expect(row.closest('[data-host]')).toBeNull();
    fireEvent.click(getByText('Blocked'));
    expect(onSelectIndex).not.toHaveBeenCalled();
    fireEvent.click(getByText('Share'));
    expect(onSelectIndex).toHaveBeenCalledWith(1);
    expect(menu()).toBe('false');
  });

  it("opens from a ⋮ button's handle and closes, row intact, when its target changes", () => {
    const menuRef = createRef<AppMenuHandle>();
    const props = {
      trigger: 'longPress' as const,
      menuRef,
      children: createElement('span', null, 'Climb row'),
      actions: [{ label: 'Share' }],
      onSelectIndex: vi.fn(),
    };
    const { container, getByText, rerender } = render(createElement(AppMenu, { ...props, menuKey: 'climb-a' }));
    const row = getByText('Climb row');
    act(() => menuRef.current?.open());
    const menu = () => container.querySelector('[data-expanded]')?.getAttribute('data-expanded');
    expect(menu()).toBe('true');
    rerender(createElement(AppMenu, { ...props, menuKey: 'climb-b' }));
    expect(menu()).toBe('false');
    expect(getByText('Climb row')).toBe(row);
  });

  it('opens nothing from its handle without rows', () => {
    const menuRef = createRef<AppMenuHandle>();
    const { container } = render(
      createElement(AppMenu, {
        trigger: 'longPress',
        menuRef,
        children: createElement('span', null, 'Climb row'),
        actions: [],
        onSelectIndex: vi.fn(),
      }),
    );
    act(() => menuRef.current?.open());
    expect(container.querySelector('[data-host]')).toBeNull();
  });

  it('draws an M3 divider above a row that opens a group, without taking an index', () => {
    const onSelectIndex = vi.fn();
    const { container } = render(
      createElement(AppMenu, {
        iconName: 'more',
        accessibilityLabel: 'More',
        actions: [
          { label: 'Add to queue', dividerBefore: true },
          { label: 'Share' },
          { label: 'Report', dividerBefore: true },
        ],
        onSelectIndex,
      }),
    );
    const rows = [...container.querySelectorAll('[data-item], hr')].map((node) => node.tagName.toLowerCase());
    expect(rows).toEqual(['div', 'div', 'hr', 'div']);
    const items = container.querySelectorAll('[data-item]');
    fireEvent.click(items[2] as Element);
    expect(onSelectIndex).toHaveBeenCalledWith(2);
  });
});

describe('AppMenu (Android) palette rows', () => {
  it('ignores palette and draws normal rows in order', () => {
    const onSelectIndex = vi.fn();
    const { container } = render(
      createElement(AppMenu, {
        iconName: 'more',
        accessibilityLabel: 'More',
        actions: [{ label: 'Favourite', palette: true }, { label: 'Share', palette: true }, { label: 'Queue' }],
        onSelectIndex,
      }),
    );
    const items = container.querySelectorAll('[data-item]');
    expect(items).toHaveLength(3);
    fireEvent.click(items[1] as Element);
    expect(onSelectIndex).toHaveBeenCalledWith(1);
  });
});

// TalkBack (spec B4): a value picker reads as a drop-down list, and its open
// menu gives the ticked choice the selected state as well as the ✓.
describe('AppMenu (Android) value pickers', () => {
  const CHOICES = [{ label: 'Off' }, { label: '45 seconds', selected: true }, { label: 'Until I stop' }];

  it('reads a text anchor over a ticked choice as a drop-down list, and an action menu as a button', () => {
    const picker = render(createElement(AppMenu, { label: '45 seconds', actions: CHOICES, onSelectIndex: vi.fn() }));
    expect(picker.container.querySelector('[data-host]')?.getAttribute('data-role')).toBe('dropdownlist');
    picker.unmount();
    const actions = render(createElement(AppMenu, { label: 'Review', actions: ACTIONS, onSelectIndex: vi.fn() }));
    expect(actions.container.querySelector('[data-host]')?.getAttribute('data-role')).toBe('button');
    actions.unmount();
    const overflow = render(
      createElement(AppMenu, {
        iconName: 'more',
        accessibilityLabel: 'More',
        actions: CHOICES,
        onSelectIndex: vi.fn(),
      }),
    );
    expect(overflow.container.querySelector('[data-host]')?.getAttribute('data-role')).toBe('button');
  });

  it('gives only the ticked choice the selected state, and one tap that reaches both picks once', () => {
    selectableHandlers.length = 0;
    const onSelectIndex = vi.fn();
    const { container } = render(createElement(AppMenu, { label: '45 seconds', actions: CHOICES, onSelectIndex }));
    const items = [...container.querySelectorAll('[data-item]')];
    expect(items.map((item) => item.getAttribute('data-selected'))).toEqual([null, 'true', null]);
    fireEvent.click(container.querySelector('[data-trigger] > [data-row]') as Element);
    expect(container.querySelector('[data-expanded]')?.getAttribute('data-expanded')).toBe('true');
    const ticked = selectableHandlers.at(-1);
    act(() => {
      ticked?.select();
      ticked?.click?.();
    });
    expect(onSelectIndex).toHaveBeenCalledExactlyOnceWith(1);
    expect(container.querySelector('[data-expanded]')?.getAttribute('data-expanded')).toBe('false');
  });
});
