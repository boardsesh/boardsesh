// @vitest-environment jsdom
// Descriptor → Compose chip mapping for the Android capsule row. The Compose
// tree can't mount under Vitest, so each primitive renders as a tagged DOM node:
// enough to tell a chip from a menu item and to drive the controlled menus.
import { fireEvent, render, within } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Capsule } from '../CapsuleRow.types';

type ChildrenProps = { children?: ReactNode };

vi.mock('@expo/ui', () => ({
  Host: ({ children }: ChildrenProps) => createElement('div', { 'data-host': true }, children),
}));
vi.mock('@expo/ui/jetpack-compose', () => {
  const slot = (name: string) => (props: ChildrenProps) =>
    createElement('div', { [`data-${name}`]: true }, props.children);
  const FilterChip = Object.assign(
    ({
      children,
      selected,
      onClick,
      colors,
      modifiers,
    }: ChildrenProps & {
      selected: boolean;
      onClick?: () => void;
      colors?: Record<string, string>;
      modifiers?: unknown;
    }) =>
      createElement(
        'button',
        {
          'data-chip': true,
          'data-selected': String(selected),
          'data-container': colors?.selectedContainerColor,
          'data-label-color': colors?.selectedLabelColor,
          'data-modifiers': JSON.stringify(modifiers),
          onClick,
        },
        children,
      ),
    { LeadingIcon: slot('leading-icon'), Label: slot('chip-label'), TrailingIcon: slot('trailing-icon') },
  );
  const DropdownMenu = Object.assign(
    ({ children, expanded }: ChildrenProps & { expanded?: boolean }) =>
      createElement('div', { 'data-menu': true, 'data-expanded': String(Boolean(expanded)) }, children),
    { Trigger: slot('trigger'), Items: slot('items') },
  );
  const DropdownMenuItem = Object.assign(
    ({ children, onClick }: ChildrenProps & { onClick?: () => void }) =>
      createElement('button', { 'data-menu-item': true, onClick }, children),
    { LeadingIcon: slot('item-icon'), Text: slot('item-text') },
  );
  return {
    FilterChip,
    DropdownMenu,
    DropdownMenuItem,
    Row: ({ children }: ChildrenProps) => createElement('div', { 'data-row': true }, children),
    Text: ({ children, color }: ChildrenProps & { color?: string }) =>
      createElement('span', { 'data-text-color': color }, children),
    Icon: ({ source }: { source?: unknown }) => createElement('i', { 'data-icon': String(source) }),
    Badge: ({
      children,
      containerColor,
      contentColor,
    }: ChildrenProps & { containerColor?: string; contentColor?: string }) =>
      createElement(
        'span',
        { 'data-badge': true, 'data-background': containerColor, 'data-color': contentColor },
        children,
      ),
    HorizontalDivider: () => createElement('hr'),
  };
});
vi.mock('@expo/ui/jetpack-compose/modifiers', () => ({
  fillMaxWidth: () => ({}),
  horizontalScroll: () => ({}),
  padding: () => ({}),
  semantics: (arg: unknown) => ({ modifier: 'semantics', arg }),
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T): T => styles },
  Platform: { OS: 'android', select: (options: { android?: unknown }) => options.android },
  PlatformColor: (name: string) => name,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primaryFill: '#7C3AED', onPrimary: '#FFFFFF', error: '#F87171' },
    systemColors: { label: '#EEEEEE' },
    colorScheme: 'dark',
  }),
}));
vi.mock('../capsule-icons.android', () => ({
  CAPSULE_ICON_SOURCE: { filters: 'tune', recent: 'history' },
  CHECK_ICON_SOURCE: 'check',
}));

const { CapsuleRow } = await import('../CapsuleRow.android');

function chips(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-chip]')];
}

function chipLabel(chip: Element) {
  return chip.querySelector('[data-chip-label]')?.textContent;
}

describe('CapsuleRow.android', () => {
  it.each([0, 1, 2, 12, 123])('uses a compact icon/count label with full TalkBack wording (%s filters)', (count) => {
    const onPress = vi.fn();
    const label = count ? `Filters · ${count}` : 'Filters';
    const { container } = render(
      createElement(CapsuleRow, {
        capsules: [
          { kind: 'sheet', key: 'filters', label, count, icon: 'filters', presentation: 'iconBadge', onPress },
        ],
      }),
    );
    const [chip] = chips(container);
    expect(chip.querySelector('[data-leading-icon]')).toBeNull();
    expect(chip.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('tune');
    expect(JSON.parse(chip.getAttribute('data-modifiers') ?? '[]')).toEqual([
      { modifier: 'semantics', arg: { contentDescription: label } },
    ]);
    const badge = chip.querySelector('[data-badge]');
    if (count === 0) expect(badge).toBeNull();
    else {
      expect(badge?.textContent).toBe(count > 99 ? '99+' : String(count));
      expect(badge?.getAttribute('data-background')).toBe('#FFFFFF');
      expect(badge?.getAttribute('data-color')).toBe('#7C3AED');
    }
    expect(chip.textContent).not.toContain('Filters');
    fireEvent.click(chip);
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('maps every kind to a FilterChip in order, filled with primaryFill + onPrimary when active', () => {
    const capsules: Capsule[] = [
      { kind: 'sheet', key: 'angle', label: '40°', onPress: vi.fn() },
      { kind: 'sheet', key: 'filters', label: 'Filters · 1', count: 1, icon: 'filters', onPress: vi.fn() },
      { kind: 'rail', key: 'grade', label: 'V4', active: true, expanded: true, onPress: vi.fn() },
      { kind: 'menu', key: 'sort', label: 'Sort', active: false, options: [], selected: undefined, onSelect: vi.fn() },
      { kind: 'toggle', key: 'beta', label: 'Beta', active: false, onPress: vi.fn() },
      { kind: 'toggleMenu', key: 'tall', label: 'Tall', active: true, onPress: vi.fn(), actions: [] },
    ];
    const { container } = render(createElement(CapsuleRow, { capsules }));
    expect(container.querySelectorAll('[data-host]')).toHaveLength(1);
    const row = chips(container);
    expect(row.map(chipLabel)).toEqual(['40°', 'Filters · 1', 'V4', 'Sort', 'Beta', 'Tall']);
    expect(row.map((chip) => chip.getAttribute('data-selected'))).toEqual([
      'false',
      'true',
      'true',
      'false',
      'false',
      'true',
    ]);
    expect(row[1].getAttribute('data-container')).toBe('#7C3AED');
    expect(row[1].getAttribute('data-label-color')).toBe('#FFFFFF');
    // Only the Filters opener carries an icon; the rail has no chevron on Android.
    expect(row.map((chip) => chip.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null)).toEqual([
      null,
      'tune',
      null,
      null,
      null,
      null,
    ]);
    // Only the menu capsule anchors a dropdown.
    expect(container.querySelectorAll('[data-menu]')).toHaveLength(1);
  });

  it('runs onPress on tap for sheet, rail, toggle and toggleMenu (no long-press menu)', () => {
    const handlers = { sheet: vi.fn(), rail: vi.fn(), toggle: vi.fn(), toggleMenu: vi.fn(), lock: vi.fn() };
    const { container } = render(
      createElement(CapsuleRow, {
        capsules: [
          { kind: 'sheet', key: 'filters', label: 'Filters', onPress: handlers.sheet },
          { kind: 'rail', key: 'grade', label: 'Grade', active: false, expanded: false, onPress: handlers.rail },
          { kind: 'toggle', key: 'beta', label: 'Beta', active: false, onPress: handlers.toggle },
          {
            kind: 'toggleMenu',
            key: 'tall',
            label: 'Tall',
            active: false,
            onPress: handlers.toggleMenu,
            actions: [{ key: 'lock', label: 'Lock', onPress: handlers.lock }],
          },
        ],
      }),
    );
    for (const chip of chips(container)) fireEvent.click(chip);
    expect(handlers.sheet).toHaveBeenCalledTimes(1);
    expect(handlers.rail).toHaveBeenCalledTimes(1);
    expect(handlers.toggle).toHaveBeenCalledTimes(1);
    expect(handlers.toggleMenu).toHaveBeenCalledTimes(1);
    // The toggleMenu's actions are unreachable on Android.
    expect(container.textContent).not.toContain('Lock');
    expect(handlers.lock).not.toHaveBeenCalled();
  });

  it('opens a menu chip, checks the selected option, commits and closes', () => {
    const onSelect = vi.fn();
    const onClear = vi.fn();
    const { container } = render(
      createElement(CapsuleRow, {
        capsules: [
          {
            kind: 'menu',
            key: 'recent',
            label: 'Recent',
            active: false,
            icon: 'recent',
            optionStyle: 'commands',
            options: [
              { value: 'a', label: 'Crimpy' },
              { value: 'b', label: 'Slopers' },
            ],
            selected: 'a',
            onSelect,
            actions: [{ key: 'clear', label: 'Clear recent searches', destructive: true, onPress: onClear }],
          },
        ],
      }),
    );
    const menu = () => container.querySelector('[data-menu]') as HTMLElement;
    const [chip] = chips(container);
    expect(chip.querySelector('[data-icon]')?.getAttribute('data-icon')).toBe('history');
    expect(menu().getAttribute('data-expanded')).toBe('false');
    fireEvent.click(chip);
    expect(menu().getAttribute('data-expanded')).toBe('true');

    const items = [...menu().querySelectorAll<HTMLElement>('[data-menu-item]')];
    expect(items.map((item) => item.textContent)).toEqual(['Crimpy', 'Slopers', 'Clear recent searches']);
    expect(items.map((item) => item.querySelector('[data-icon]')?.getAttribute('data-icon') ?? null)).toEqual([
      'check',
      null,
      null,
    ]);
    // A divider sits between the options and the actions.
    expect(within(menu()).getByText('Slopers').closest('[data-menu-item]')?.nextElementSibling?.tagName).toBe('HR');
    // The destructive action is red; options keep the scheme's label colour.
    expect(items[2].querySelector('[data-text-color]')?.getAttribute('data-text-color')).toBe('#F87171');
    expect(items[0].querySelector('[data-text-color]')?.getAttribute('data-text-color')).toBe('#EEEEEE');

    fireEvent.click(items[1]);
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(menu().getAttribute('data-expanded')).toBe('false');

    fireEvent.click(chip);
    fireEvent.click([...menu().querySelectorAll<HTMLElement>('[data-menu-item]')][2]);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(menu().getAttribute('data-expanded')).toBe('false');
  });

  it('draws no divider for a menu without actions', () => {
    const { container } = render(
      createElement(CapsuleRow, {
        capsules: [
          {
            kind: 'menu',
            key: 'progress',
            label: 'Unsent',
            active: true,
            options: [
              { value: 'all', label: 'All' },
              { value: 'unsent', label: 'Unsent' },
            ],
            selected: 'unsent',
            onSelect: vi.fn(),
          },
        ],
      }),
    );
    expect(container.querySelector('hr')).toBeNull();
    expect(chips(container)[0].getAttribute('data-selected')).toBe('true');
  });
});
