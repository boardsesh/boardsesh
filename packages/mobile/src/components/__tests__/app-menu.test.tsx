import { describe, it, expect } from 'vitest';
import { resolveMenuAction, resolveMenuActions } from '../AppMenu.logic';
import type { AppMenuAction } from '../AppMenu.types';

// AppMenu's per-platform rendering is native (@expo/ui SwiftUI `Menu` / Compose
// `DropdownMenu`) and can't mount under vitest's node env, so the testable contract
// is the pure resolver every impl shares: how an action maps to its iOS SF Symbol /
// Android check / destructive flag, and that order (= the tapped index) is preserved.

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
