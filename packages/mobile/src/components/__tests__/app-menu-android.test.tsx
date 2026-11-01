// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The Compose tree can't mount under vitest, so each Compose primitive renders as
// a tagged DOM node: enough to tell an IconButton from a Text.
vi.mock('@expo/ui', () => ({
  Host: ({
    children,
    accessibilityLabel,
    accessible,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessible?: boolean;
  }) =>
    createElement(
      'div',
      { 'data-host': true, 'aria-label': accessibilityLabel, 'data-host-accessible': String(accessible) },
      children,
    ),
}));
vi.mock('@expo/ui/jetpack-compose', () => {
  const DropdownMenu = ({ children, expanded }: { children?: ReactNode; expanded?: boolean }) =>
    createElement('div', { 'data-expanded': String(Boolean(expanded)) }, children);
  DropdownMenu.Trigger = ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-trigger': true }, children);
  DropdownMenu.Items = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const DropdownMenuItem = ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
    createElement('div', { 'data-item': true, onClick }, children);
  DropdownMenuItem.LeadingIcon = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  DropdownMenuItem.Text = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    DropdownMenu,
    DropdownMenuItem,
    Row: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-row': true }, children),
    Column: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-column': true }, children),
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
  clickable: () => ({}),
  padding: () => ({}),
}));
vi.mock('react-native', () => ({
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
  it('opens a custom row only on long press, keeping row taps and accessibility with the child', () => {
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
    const menu = () => container.querySelector('[data-expanded]')?.getAttribute('data-expanded');
    const anchor = container.querySelector('[data-long-press-anchor]') as Element;
    expect(anchor.getAttribute('data-accessible')).toBe('false');
    expect(anchor.getAttribute('data-focusable')).toBe('false');
    expect(container.querySelector('[data-host]')?.getAttribute('data-host-accessible')).toBe('false');
    expect(container.querySelector('[data-host]')?.hasAttribute('aria-label')).toBe(false);
    expect(container.querySelector('[data-rn-match-contents="true"]')).not.toBeNull();
    fireEvent.click(getByText('Climb row'));
    expect(onRowPress).toHaveBeenCalledOnce();
    expect(menu()).toBe('false');
    fireEvent.contextMenu(anchor);
    expect(menu()).toBe('true');
    fireEvent.click(getByText('Blocked'));
    expect(onSelectIndex).not.toHaveBeenCalled();
    fireEvent.click(getByText('Share'));
    expect(onSelectIndex).toHaveBeenCalledWith(1);
    expect(menu()).toBe('false');
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
