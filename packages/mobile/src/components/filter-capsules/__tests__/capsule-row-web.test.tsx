// @vitest-environment jsdom
// Descriptor → Paper chip mapping for the web capsule row. Paper is stood in
// with DOM nodes that record the props the row hands it.
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { Capsule } from '../CapsuleRow.types';

type ChildrenProps = { children?: ReactNode };
type ChipProps = ChildrenProps & {
  selected?: boolean;
  icon?: string | (() => ReactNode);
  onPress?: () => void;
  accessibilityLabel?: string;
  selectedColor?: string;
  style?: unknown;
  textStyle?: unknown;
};

// Flattens a StyleProp (object or nested arrays) into one object.
function flatten(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
  return style && typeof style === 'object' ? (style as Record<string, unknown>) : {};
}

vi.mock('react-native-paper', () => {
  const Chip = ({
    children,
    selected,
    icon,
    onPress,
    accessibilityLabel,
    selectedColor,
    style,
    textStyle,
  }: ChipProps) => {
    const flat = flatten(style);
    return createElement(
      'button',
      {
        'data-chip': true,
        'data-selected': String(Boolean(selected)),
        'data-icon': typeof icon === 'string' ? icon : undefined,
        'data-text-style': JSON.stringify(textStyle),
        'data-selected-color': selectedColor,
        'data-background': typeof flat.backgroundColor === 'string' ? flat.backgroundColor : undefined,
        'aria-label': accessibilityLabel,
        onClick: onPress,
      },
      typeof icon === 'function' ? icon() : null,
      children,
    );
  };
  const Menu = Object.assign(
    ({ children, visible, anchor }: ChildrenProps & { visible: boolean; anchor: ReactNode }) =>
      createElement('div', { 'data-menu': true, 'data-visible': String(visible) }, anchor, visible ? children : null),
    {
      Item: ({ title, leadingIcon, onPress }: { title: string; leadingIcon?: string; onPress: () => void }) =>
        createElement('button', { 'data-menu-item': true, 'data-leading-icon': leadingIcon, onClick: onPress }, title),
    },
  );
  return {
    Chip,
    Menu,
    Divider: () => createElement('hr'),
    Icon: ({ source }: { source: string }) => createElement('i', { 'data-glyph': source }),
    Badge: ({ children, style }: ChildrenProps & { style?: unknown }) =>
      createElement('span', { 'data-badge': true, 'data-style': JSON.stringify(style) }, children),
  };
});
vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T): T => styles },
  ScrollView: ({ children }: ChildrenProps) => createElement('div', { 'data-scroll': true }, children),
  View: ({ children }: ChildrenProps) => createElement('div', null, children),
  // src/theme/colors.ts (via the spacing tokens) reads these at module load.
  Platform: { OS: 'web' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    brandColors: { primaryFill: '#7C3AED', onPrimary: '#FFFFFF' },
    systemColors: { secondaryLabel: '#888' },
  }),
}));

const { CapsuleRow } = await import('../CapsuleRow.web');

function chips(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>('[data-chip]')];
}

describe('CapsuleRow.web', () => {
  it.each([0, 1, 2, 12, 123])(
    'keeps the compact filter icon/count fully labelled and tappable (%s filters)',
    (count) => {
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
      expect(chip.getAttribute('aria-label')).toBe(label);
      expect(chip.querySelector('[data-glyph]')?.getAttribute('data-glyph')).toBe('tune');
      expect(JSON.parse(chip.getAttribute('data-text-style') ?? '{}')).toMatchObject({ width: 0, marginLeft: 0 });
      const badge = chip.querySelector('[data-badge]');
      if (count === 0) expect(badge).toBeNull();
      else {
        expect(badge?.textContent).toBe(count > 99 ? '99+' : String(count));
        expect(JSON.parse(badge?.getAttribute('data-style') ?? '{}')).toMatchObject({
          backgroundColor: '#FFFFFF',
          color: '#7C3AED',
        });
      }
      expect(chip.textContent).not.toContain('Filters');
      fireEvent.click(chip);
      expect(onPress).toHaveBeenCalledOnce();
    },
  );

  it('maps every kind to a Paper chip in order, filled with primaryFill + onPrimary when active', () => {
    const capsules: Capsule[] = [
      { kind: 'sheet', key: 'angle', label: '40°', accessibilityLabel: 'Select Angle', onPress: vi.fn() },
      { kind: 'sheet', key: 'filters', label: 'Filters · 1', count: 1, icon: 'filters', onPress: vi.fn() },
      { kind: 'rail', key: 'grade', label: 'Grade', active: false, expanded: false, onPress: vi.fn() },
      { kind: 'menu', key: 'sort', label: 'Sort', active: true, options: [], selected: undefined, onSelect: vi.fn() },
      { kind: 'toggle', key: 'beta', label: 'Beta', active: false, onPress: vi.fn() },
      { kind: 'toggleMenu', key: 'tall', label: 'Tall', active: true, icon: 'locked', onPress: vi.fn(), actions: [] },
    ];
    const { container } = render(createElement(CapsuleRow, { capsules }));
    const row = chips(container);
    expect(row.map((chip) => chip.textContent)).toEqual(['40°', 'Filters · 1', 'Grade', 'Sort', 'Beta', 'Tall']);
    expect(row.map((chip) => chip.getAttribute('data-selected'))).toEqual([
      'false',
      'true',
      'false',
      'true',
      'false',
      'true',
    ]);
    // Active chips take the brand fill and on-fill label; resting ones neither.
    expect(row.map((chip) => chip.getAttribute('data-background'))).toEqual([
      null,
      '#7C3AED',
      null,
      '#7C3AED',
      null,
      '#7C3AED',
    ]);
    expect(row.map((chip) => chip.getAttribute('data-selected-color'))).toEqual([
      null,
      '#FFFFFF',
      null,
      '#FFFFFF',
      null,
      '#FFFFFF',
    ]);
    // Filters keeps its icon; the lock glyph is iOS-only, so web draws none.
    expect(row.map((chip) => chip.getAttribute('data-icon'))).toEqual([null, 'tune', null, null, null, null]);
    expect(row[0].getAttribute('aria-label')).toBe('Select Angle');
  });

  it('runs onPress on tap for every non-menu kind', () => {
    const onPress = vi.fn();
    const { container } = render(
      createElement(CapsuleRow, {
        capsules: [
          { kind: 'sheet', key: 'filters', label: 'Filters', onPress },
          { kind: 'rail', key: 'grade', label: 'Grade', active: false, expanded: false, onPress },
          { kind: 'toggle', key: 'beta', label: 'Beta', active: false, onPress },
          {
            kind: 'toggleMenu',
            key: 'tall',
            label: 'Tall',
            active: false,
            onPress,
            actions: [{ key: 'lock', label: 'Lock', onPress: vi.fn() }],
          },
        ],
      }),
    );
    for (const chip of chips(container)) fireEvent.click(chip);
    expect(onPress).toHaveBeenCalledTimes(4);
    expect(container.textContent).not.toContain('Lock');
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
    const items = () => [...container.querySelectorAll<HTMLElement>('[data-menu-item]')];
    const [chip] = chips(container);
    expect(chip.getAttribute('data-icon')).toBe('history');
    expect(menu().getAttribute('data-visible')).toBe('false');

    fireEvent.click(chip);
    expect(items().map((item) => item.textContent)).toEqual(['Crimpy', 'Slopers', 'Clear recent searches']);
    expect(items().map((item) => item.getAttribute('data-leading-icon'))).toEqual(['check', null, null]);
    expect(items()[1].nextElementSibling?.tagName).toBe('HR');

    fireEvent.click(items()[1]);
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(menu().getAttribute('data-visible')).toBe('false');

    fireEvent.click(chip);
    fireEvent.click(items()[2]);
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(menu().getAttribute('data-visible')).toBe('false');
  });
});
