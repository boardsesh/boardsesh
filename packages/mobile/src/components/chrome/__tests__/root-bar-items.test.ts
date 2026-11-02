import { describe, it, expect, vi } from 'vitest';
import {
  ACCOUNT_RAIL_SYMBOL,
  accountRailItem,
  barItemsFactory,
  menuBarItem,
  symbolBarItem,
  titleBarItem,
  unreadBadgeValue,
} from '../root-bar-items';

describe('symbolBarItem', () => {
  it('carries both an SF Symbol and a title, so iPhone Duo can put it on the rail', () => {
    const onPress = vi.fn();
    const item = symbolBarItem({ label: 'Find climbers', symbol: 'person.badge.plus', onPress, identifier: 'x' });
    expect(item).toMatchObject({
      type: 'button',
      label: 'Find climbers',
      icon: { type: 'sfSymbol', name: 'person.badge.plus' },
      accessibilityLabel: 'Find climbers',
      identifier: 'x',
    });
    item.onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('sets a visibility priority, a badge and a tint only when given', () => {
    const plain = symbolBarItem({ label: 'a', symbol: 'bell', onPress: vi.fn(), identifier: 'a' });
    expect(plain).not.toHaveProperty('visibilityPriority');
    expect(plain).not.toHaveProperty('badge');
    expect(plain).not.toHaveProperty('tintColor');

    const badged = symbolBarItem({
      label: 'Notifications',
      symbol: 'bell',
      onPress: vi.fn(),
      identifier: 'n',
      visibilityPriority: 'high',
      badge: '3',
      badgeColor: '#8B5CF6',
      tintColor: '#FF9500',
      accessibilityLabel: 'Notifications (3)',
    });
    expect(badged).toMatchObject({
      visibilityPriority: 'high',
      badge: { value: '3', style: { backgroundColor: '#8B5CF6' } },
      tintColor: '#FF9500',
      accessibilityLabel: 'Notifications (3)',
    });
  });

  it('draws an empty badge for the onboarding cue rather than none', () => {
    const item = symbolBarItem({ label: 'b', symbol: 'square.grid.2x2', onPress: vi.fn(), identifier: 'b', badge: '' });
    expect(item.badge).toEqual({ value: '' });
  });
});

describe('accountRailItem', () => {
  it('is a symbol with the drawer title, never a photo, and not the Profile tab icon', () => {
    const item = accountRailItem({ label: 'User menu', onPress: vi.fn() });
    expect(item).toMatchObject({
      type: 'button',
      label: 'User menu',
      accessibilityLabel: 'User menu',
      icon: { type: 'sfSymbol', name: 'person.crop.circle.badge.ellipsis' },
      identifier: 'root.account',
    });
    expect(ACCOUNT_RAIL_SYMBOL).not.toBe('person.crop.circle');
  });

  it('opens what it is given', () => {
    const onPress = vi.fn();
    accountRailItem({ label: 'User menu', onPress }).onPress();
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe('unreadBadgeValue', () => {
  it.each([
    [0, null],
    [-1, null],
    [7, '7'],
    [99, '99'],
    [100, '99+'],
  ])('%i unread reads %s', (count, expected) => {
    expect(unreadBadgeValue(count)).toBe(expected);
  });
});

describe('menuBarItem', () => {
  it('is a native menu with a symbol and title, its rows firing their actions', () => {
    const openViewOptions = vi.fn();
    const openBoards = vi.fn();
    const item = menuBarItem({
      label: 'Climb list options',
      symbol: 'ellipsis',
      identifier: 'menu',
      rows: [
        { label: 'View options', symbol: 'slider.horizontal.3', onPress: openViewOptions },
        { label: 'Switch board', symbol: 'arrow.left.arrow.right', onPress: openBoards },
      ],
    });
    expect(item).toMatchObject({
      type: 'menu',
      label: 'Climb list options',
      icon: { type: 'sfSymbol', name: 'ellipsis' },
    });
    expect(item.menu.items.map((row) => row.label)).toEqual(['View options', 'Switch board']);
    const [first, second] = item.menu.items;
    if (first?.type === 'action') first.onPress();
    if (second?.type === 'action') second.onPress();
    expect(openViewOptions).toHaveBeenCalledTimes(1);
    expect(openBoards).toHaveBeenCalledTimes(1);
  });
});

describe('titleBarItem', () => {
  it('keeps the value as the visible title and has no icon', () => {
    const item = titleBarItem({ label: '40°', onPress: vi.fn(), accessibilityLabel: 'Angle 40°', identifier: 'angle' });
    expect(item.label).toBe('40°');
    expect(item.icon).toBeUndefined();
    expect(item.accessibilityLabel).toBe('Angle 40°');
  });
});

describe('barItemsFactory', () => {
  it('clears the slot for no items and returns the items otherwise', () => {
    expect(barItemsFactory([])).toBeUndefined();
    const item = symbolBarItem({ label: 'a', symbol: 'plus', onPress: vi.fn(), identifier: 'a' });
    expect(barItemsFactory([item])?.()).toEqual([item]);
  });
});
