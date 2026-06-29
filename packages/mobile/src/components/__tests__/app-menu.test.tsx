// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { resolveMenuAction, resolveMenuActions } from '../AppMenu.logic';
import type { AppMenuAction } from '../AppMenu.types';

// AppMenu's per-platform rendering is native (@expo/ui SwiftUI `Menu` / Compose
// `DropdownMenu`) and can't mount under vitest. Two complementary suites:
//   1. the pure resolver every impl shares (icon / check / destructive / index order);
//   2. the interaction contract, exercised through the faithful test stub.

describe('AppMenu.logic — resolveMenuAction', () => {
  it('marks the selected row with a checkmark (the active marker replaces its scope glyph) and a check on Android', () => {
    const resolved = resolveMenuAction({ label: 'My crew', selected: true, systemIcon: 'person.2.fill' });
    expect(resolved.iosSystemImage).toBe('checkmark');
    expect(resolved.showCheck).toBe(true);
  });

  it("keeps an unselected row's own systemIcon on iOS and shows no check", () => {
    const resolved = resolveMenuAction({ label: 'Everyone', systemIcon: 'globe' });
    expect(resolved.iosSystemImage).toBe('globe');
    expect(resolved.showCheck).toBe(false);
  });

  it('leaves the iOS symbol undefined when an unselected row has no systemIcon', () => {
    expect(resolveMenuAction({ label: 'Find a gym' }).iosSystemImage).toBeUndefined();
  });

  it('treats an explicit selected: false the same as unselected (no check, keeps its icon)', () => {
    const resolved = resolveMenuAction({ label: 'Everyone', selected: false, systemIcon: 'globe' });
    expect(resolved.showCheck).toBe(false);
    expect(resolved.iosSystemImage).toBe('globe');
  });

  it('flags destructive rows and leaves normal rows unmarked', () => {
    expect(resolveMenuAction({ label: 'Delete', destructive: true }).isDestructive).toBe(true);
    expect(resolveMenuAction({ label: 'Keep' }).isDestructive).toBe(false);
  });
});

describe('AppMenu.logic — resolveMenuActions', () => {
  it('preserves order and length so the tapped index maps back to the action', () => {
    const actions: AppMenuAction[] = [
      { label: 'My crew', selected: true, systemIcon: 'person.2.fill' },
      { label: 'Everyone' },
      { label: 'Find a gym', systemIcon: 'mappin.and.ellipse' },
    ];
    const resolved = resolveMenuActions(actions);
    expect(resolved.map((action) => action.label)).toEqual(['My crew', 'Everyone', 'Find a gym']);
    expect(resolved.map((action) => action.showCheck)).toEqual([true, false, false]);
    expect(resolved[2].iosSystemImage).toBe('mappin.and.ellipse');
  });
});

// Map the stub's RN primitives onto DOM nodes so it renders under jsdom.
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
  Pressable: ({
    children,
    onPress,
    accessibilityRole,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityRole?: string;
    accessibilityLabel?: string;
  }) =>
    createElement(
      'button',
      { onClick: onPress, 'data-role': accessibilityRole, 'aria-label': accessibilityLabel },
      children,
    ),
}));

// Resolves to test/app-menu-stub.tsx via the vite alias — the same double every indirect
// screen test renders, so this guards its anchor + per-action wiring (label, button role,
// index → onSelectIndex) without a native env.
import { AppMenu } from '../AppMenu';

const ACTIONS: AppMenuAction[] = [
  { label: 'My crew', selected: true, systemIcon: 'person.2.fill' },
  { label: 'Everyone' },
  { label: 'Find a gym', systemIcon: 'mappin.and.ellipse' },
];

describe('AppMenu stub — interaction contract', () => {
  it('renders a labelled anchor button plus one button per action', () => {
    const { container, getByLabelText } = render(
      createElement(AppMenu, {
        label: 'My crew',
        actions: ACTIONS,
        onSelectIndex: () => {},
        accessibilityLabel: 'Scope: My crew',
      }),
    );
    // The anchor carries the explicit accessibility label.
    expect(getByLabelText('Scope: My crew')).toBeTruthy();
    // Anchor + one button per action.
    expect(container.querySelectorAll('button[data-role="button"]').length).toBe(ACTIONS.length + 1);
  });

  it('fires onSelectIndex with the tapped action index', () => {
    const onSelectIndex = vi.fn();
    const { getByText } = render(createElement(AppMenu, { label: 'My crew', actions: ACTIONS, onSelectIndex }));
    fireEvent.click(getByText('Everyone'));
    expect(onSelectIndex).toHaveBeenCalledWith(1);
    fireEvent.click(getByText('Find a gym'));
    expect(onSelectIndex).toHaveBeenCalledWith(2);
  });
});
