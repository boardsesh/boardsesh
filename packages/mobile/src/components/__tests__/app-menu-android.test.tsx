// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// The Compose tree can't mount under vitest, so each Compose primitive renders as
// a tagged DOM node: enough to tell an IconButton from a Text.
vi.mock('@expo/ui', () => ({
  Host: ({ children, accessibilityLabel }: { children?: ReactNode; accessibilityLabel?: string }) =>
    createElement('div', { 'data-host': true, 'aria-label': accessibilityLabel }, children),
}));
vi.mock('@expo/ui/jetpack-compose', () => {
  const DropdownMenu = ({ children, expanded }: { children?: ReactNode; expanded?: boolean }) =>
    createElement('div', { 'data-expanded': String(Boolean(expanded)) }, children);
  DropdownMenu.Trigger = ({ children }: { children?: ReactNode }) =>
    createElement('div', { 'data-trigger': true }, children);
  DropdownMenu.Items = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  const DropdownMenuItem = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  DropdownMenuItem.LeadingIcon = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  DropdownMenuItem.Text = ({ children }: { children?: ReactNode }) => createElement('div', null, children);
  return {
    DropdownMenu,
    DropdownMenuItem,
    Row: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-row': true }, children),
    Text: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-compose-text': true }, children),
    IconButton: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) =>
      createElement('button', { 'data-icon-button': true, onClick }, children),
    Icon: ({ size, tint }: { size?: number; tint?: string }) =>
      createElement('i', { 'data-compose-icon': true, 'data-size': size, 'data-tint': tint }),
  };
});
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({
  clickable: () => ({}),
  padding: () => ({}),
}));
vi.mock('react-native', () => ({
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
});
