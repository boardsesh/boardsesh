import { describe, it, expect } from 'vitest';
import { CLIMB_ACTION_ORDER, type ClimbActionId } from '../climb-action-gating';
import {
  buildClimbContextMenu,
  CLIMB_CONTEXT_MENU_LAYOUT,
  PRIMARY_CLIMB_ACTION_IDS,
} from '../climb-context-menu-model';

const visibleIds = (offered: readonly ClimbActionId[]) =>
  buildClimbContextMenu(offered).flatMap((section) =>
    section.items.filter((item) => !item.hidden).map((item) => item.id),
  );

describe('buildClimbContextMenu', () => {
  it('places every climb action in exactly one section', () => {
    const placed = CLIMB_CONTEXT_MENU_LAYOUT.flatMap((section) => section.ids);
    expect([...placed].sort()).toEqual([...CLIMB_ACTION_ORDER].sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('opens with the overlay’s three quick actions as a compact row', () => {
    const [first, ...rest] = buildClimbContextMenu(CLIMB_ACTION_ORDER);
    expect(first).toMatchObject({ key: 'quick', compact: true });
    expect(first.items.map((item) => item.id)).toEqual(['tick', 'playlist', 'share']);
    expect(first.items.map((item) => item.id)).toEqual(PRIMARY_CLIMB_ACTION_IDS);
    expect(rest.every((section) => !section.compact)).toBe(true);
  });

  it('hides what the climber is not offered and shows the rest', () => {
    const offered: ClimbActionId[] = ['preview', 'queue', 'playlist', 'favorite', 'tick', 'share'];
    expect(visibleIds(offered).sort()).toEqual([...offered].sort());
  });

  it('keeps the same tree for every climb, so a recycled row only flips hidden flags', () => {
    const plain = buildClimbContextMenu(['preview', 'queue', 'tick']);
    const setter = buildClimbContextMenu(CLIMB_ACTION_ORDER);
    const shape = (menu: typeof plain) => menu.map((section) => section.items.map((item) => item.id));
    expect(shape(plain)).toEqual(shape(setter));
  });

  it('puts the destructive delete last, and nothing else destructive', () => {
    const items = buildClimbContextMenu(CLIMB_ACTION_ORDER).flatMap((section) => section.items);
    expect(items.at(-1)).toEqual({ id: 'delete', hidden: false, destructive: true });
    expect(items.filter((item) => item.destructive).map((item) => item.id)).toEqual(['delete']);
  });

  it('groups queue actions together and setter actions together', () => {
    const sections = Object.fromEntries(
      buildClimbContextMenu(CLIMB_ACTION_ORDER).map((section) => [section.key, section.items.map((item) => item.id)]),
    );
    expect(sections.play).toEqual(['preview', 'queue', 'playNext', 'openQueue']);
    expect(sections.setter).toEqual(['edit', 'fork', 'openInApp']);
    expect(sections.moderation).toEqual(['report', 'delete']);
  });
});
