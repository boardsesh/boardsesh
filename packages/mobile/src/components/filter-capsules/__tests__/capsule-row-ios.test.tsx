// @vitest-environment jsdom
// Descriptor → SwiftUI control mapping for the iOS capsule row. The default
// extensionless import is aliased to a null stub by mobile Vitest, so this
// imports the platform file explicitly and stands each @expo/ui view in with a
// DOM node that records its props.
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Capsule } from '../CapsuleRow.types';

type ModifierRecord = { modifier: string; arg?: unknown };
type RecordedProps = Record<string, unknown> & { children?: ReactNode; modifiers?: ModifierRecord[] };

const captured = vi.hoisted(() => ({
  supportsGlass: true,
  views: [] as {
    view: string;
    props: Record<string, unknown> & { modifiers?: { modifier: string; arg?: unknown }[] };
  }[],
}));

vi.mock('@expo/ui/swift-ui/modifiers', () => {
  const make =
    (modifier: string) =>
    (arg?: unknown): ModifierRecord => ({ modifier, arg });
  return {
    buttonStyle: make('buttonStyle'),
    controlSize: make('controlSize'),
    tint: make('tint'),
    foregroundColor: make('foregroundColor'),
    tag: make('tag'),
    padding: make('padding'),
    fixedSize: make('fixedSize'),
    accessibilityHint: make('accessibilityHint'),
    accessibilityHidden: make('accessibilityHidden'),
    accessibilityLabel: make('accessibilityLabel'),
    accessibilityAddTraits: make('accessibilityAddTraits'),
  };
});

vi.mock('@expo/ui/swift-ui', () => {
  // Every view renders as a tagged node holding its children, and records its
  // props so a test can call the handlers the native view would.
  const view = (name: string) => (props: RecordedProps) => {
    captured.views.push({ view: name, props });
    const label = typeof props.label === 'string' ? props.label : undefined;
    return createElement(
      name === 'Button' ? 'button' : 'div',
      {
        'data-view': name,
        'data-label': label,
        onClick: typeof props.onPress === 'function' ? props.onPress : undefined,
      },
      props.children,
    );
  };
  const Popover = Object.assign(view('Popover'), {
    Trigger: view('Popover.Trigger'),
    Content: view('Popover.Content'),
  });
  return {
    Host: view('Host'),
    HStack: view('HStack'),
    ScrollView: view('ScrollView'),
    Menu: view('Menu'),
    Picker: view('Picker'),
    Button: view('Button'),
    Text: view('Text'),
    Image: view('Image'),
    Divider: view('Divider'),
    RNHostView: view('RNHostView'),
    Popover,
  };
});

vi.mock('react-native', () => ({
  StyleSheet: { create: <T,>(styles: T): T => styles },
  View: ({ children }: { children?: ReactNode }) => createElement('div', { 'data-rn-view': true }, children),
  // src/theme/colors.ts reads Platform.OS / PlatformColor at module load.
  Platform: { OS: 'ios' },
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
  PlatformColor: (name: string) => name,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#A78BFA', primaryFill: '#7C3AED', onPrimary: '#FFFFFF' } }),
}));

vi.mock('../../../hooks/use-glass-capability', () => ({
  useGlassCapability: () => captured.supportsGlass,
}));

// Imported after the mocks so the module graph resolves against them.
const { CapsuleRow } = await import('../CapsuleRow.ios');

beforeEach(() => {
  captured.views = [];
  captured.supportsGlass = true;
});

function viewsOf(name: string) {
  return captured.views.filter((entry) => entry.view === name).map((entry) => entry.props);
}

function lastViewWithLabel(name: string, label: string) {
  const match = viewsOf(name).filter((props) => props.label === label);
  const last = match[match.length - 1];
  if (!last) throw new Error(`missing ${name} "${label}"`);
  return last;
}

const ACTIVE = [
  { modifier: 'buttonStyle', arg: 'glassProminent' },
  { modifier: 'controlSize', arg: 'small' },
  { modifier: 'tint', arg: '#7C3AED' },
  { modifier: 'foregroundColor', arg: '#FFFFFF' },
];
const RESTING = [
  { modifier: 'buttonStyle', arg: 'glass' },
  { modifier: 'controlSize', arg: 'small' },
];

describe('CapsuleRow.ios below iOS 26 (no Liquid Glass)', () => {
  // @expo/ui degrades `glass` / `glassProminent` to a plain text button there, so
  // the row must ask for bordered styles itself or a white active label vanishes.
  const capsules: Capsule[] = [
    { kind: 'sheet', key: 'filters', label: 'Filters · 2', count: 2, onPress: vi.fn() },
    { kind: 'toggle', key: 'beta', label: 'Beta videos', active: false, onPress: vi.fn() },
  ];

  it('draws an active capsule as a solid brand fill with the on-fill label', () => {
    captured.supportsGlass = false;
    render(createElement(CapsuleRow, { capsules }));
    expect(lastViewWithLabel('Button', 'Filters · 2').modifiers).toEqual([
      { modifier: 'buttonStyle', arg: 'borderedProminent' },
      { modifier: 'controlSize', arg: 'small' },
      { modifier: 'tint', arg: '#7C3AED' },
      { modifier: 'foregroundColor', arg: '#FFFFFF' },
    ]);
  });

  it('draws a resting capsule as a neutral bordered capsule', () => {
    captured.supportsGlass = false;
    render(createElement(CapsuleRow, { capsules }));
    expect(lastViewWithLabel('Button', 'Beta videos').modifiers?.slice(0, 3)).toEqual([
      { modifier: 'buttonStyle', arg: 'bordered' },
      { modifier: 'controlSize', arg: 'small' },
      { modifier: 'tint', arg: { type: 'hierarchical', style: 'primary' } },
    ]);
  });

  it('never asks for a glass style', () => {
    captured.supportsGlass = false;
    render(createElement(CapsuleRow, { capsules }));
    expect(JSON.stringify(captured.views.map((entry) => entry.props.modifiers))).not.toMatch(/"glass/);
  });
});

describe('CapsuleRow.ios', () => {
  it('fills an active capsule with primaryFill + onPrimary, never the text tint', () => {
    render(
      createElement(CapsuleRow, {
        capsules: [
          { kind: 'sheet', key: 'filters', label: 'Filters · 2', count: 2, icon: 'filters', onPress: vi.fn() },
          { kind: 'toggle', key: 'beta', label: 'Beta videos', active: false, onPress: vi.fn() },
        ],
      }),
    );
    const filters = lastViewWithLabel('Button', 'Filters · 2');
    expect(filters.systemImage).toBe('line.3.horizontal.decrease');
    expect(filters.modifiers).toEqual(ACTIVE);
    expect(JSON.stringify(captured.views.map((entry) => entry.props.modifiers))).not.toContain('#A78BFA');
    expect(lastViewWithLabel('Button', 'Beta videos').modifiers?.slice(0, 2)).toEqual(RESTING);
  });

  it('renders capsules in order inside one Host', () => {
    const { container } = render(
      createElement(CapsuleRow, {
        capsules: [
          { kind: 'sheet', key: 'filters', label: 'Filters', onPress: vi.fn() },
          { kind: 'toggle', key: 'beta', label: 'Beta videos', active: true, onPress: vi.fn() },
          {
            kind: 'menu',
            key: 'sort',
            label: 'Sort',
            active: false,
            options: [{ value: 'a', label: 'A' }],
            selected: 'a',
            onSelect: vi.fn(),
          },
        ],
      }),
    );
    expect(container.querySelectorAll('[data-view="Host"]')).toHaveLength(1);
    const labels = [...container.querySelectorAll('[data-view="HStack"] > [data-label]')].map((node) =>
      node.getAttribute('data-label'),
    );
    expect(labels).toEqual(['Filters', 'Beta videos', 'Sort']);
  });

  it('labels a sheet opener for VoiceOver only when asked', () => {
    render(
      createElement(CapsuleRow, {
        capsules: [
          { kind: 'sheet', key: 'angle', label: '40°', accessibilityLabel: 'Select Angle', onPress: vi.fn() },
          { kind: 'sheet', key: 'filters', label: 'Filters', onPress: vi.fn() },
        ],
      }),
    );
    expect(lastViewWithLabel('Button', '40°').modifiers).toContainEqual({
      modifier: 'accessibilityLabel',
      arg: 'Select Angle',
    });
    expect(lastViewWithLabel('Button', 'Filters').modifiers).toEqual(RESTING);
  });

  it('draws a rail with a chevron that flips and a hint', () => {
    const onPress = vi.fn();
    const rail = (expanded: boolean): Capsule => ({
      kind: 'rail',
      key: 'grade',
      label: 'V4–V6',
      active: true,
      expanded,
      onPress,
      accessibilityHint: expanded ? 'Hides the grade row' : 'Shows the grade row',
    });
    const { container, rerender } = render(createElement(CapsuleRow, { capsules: [rail(false)] }));
    expect(viewsOf('Image').at(-1)?.systemName).toBe('chevron.down');
    expect(viewsOf('Text').at(-1)?.children).toBe('V4–V6');
    expect(viewsOf('Button').at(-1)?.modifiers).toEqual([
      ...ACTIVE,
      { modifier: 'accessibilityHint', arg: 'Shows the grade row' },
    ]);
    expect(viewsOf('Popover')).toHaveLength(0);

    rerender(createElement(CapsuleRow, { capsules: [rail(true)] }));
    expect(viewsOf('Image').at(-1)?.systemName).toBe('chevron.up');
    fireEvent.click(container.querySelector('button') as Element);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('puts the rail content in a popover when one is given', () => {
    const onDismiss = vi.fn();
    render(
      createElement(CapsuleRow, {
        capsules: [
          {
            kind: 'rail',
            key: 'grade',
            label: 'Grade',
            active: false,
            expanded: true,
            onPress: vi.fn(),
            popover: { content: createElement('span', { 'data-testid': 'rail' }), onDismiss },
          },
        ],
      }),
    );
    const popover = viewsOf('Popover').at(-1);
    if (!popover) throw new Error('missing Popover');
    expect(popover.isPresented).toBe(true);
    const onIsPresentedChange = popover.onIsPresentedChange as (presented: boolean) => void;
    onIsPresentedChange(true);
    expect(onDismiss).not.toHaveBeenCalled();
    onIsPresentedChange(false);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('draws a picker menu, guards the tag and puts actions after a divider', () => {
    const onSelect = vi.fn();
    const onCustom = vi.fn();
    const { container } = render(
      createElement(CapsuleRow, {
        capsules: [
          {
            kind: 'menu',
            key: 'when',
            label: 'This month',
            active: true,
            options: [
              { value: 'any', label: 'Any time' },
              { value: 'month', label: 'This month' },
            ],
            selected: 'month',
            onSelect,
            actions: [{ key: 'custom', label: 'Custom…', onPress: onCustom }],
          },
        ],
      }),
    );
    expect(lastViewWithLabel('Menu', 'This month').modifiers).toEqual(ACTIVE);
    const picker = viewsOf('Picker').at(-1);
    expect(picker?.selection).toBe('month');
    const tags = viewsOf('Text').map((props) => props.modifiers?.[0]);
    expect(tags).toEqual([
      { modifier: 'tag', arg: 'any' },
      { modifier: 'tag', arg: 'month' },
    ]);
    const change = picker?.onSelectionChange as (value: unknown) => void;
    change(7);
    change('any');
    expect(onSelect.mock.calls).toEqual([['any']]);

    const menu = container.querySelector('[data-view="Menu"]');
    expect([...(menu?.children ?? [])].map((node) => node.getAttribute('data-view'))).toEqual([
      'Picker',
      'Divider',
      'Button',
    ]);
    fireEvent.click(container.querySelector('[data-label="Custom…"]') as Element);
    expect(onCustom).toHaveBeenCalledTimes(1);
  });

  it('draws a commands menu as buttons with a checkmark, and a red destructive action', () => {
    const onSelect = vi.fn();
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
            actions: [{ key: 'clear', label: 'Clear', destructive: true, onPress: vi.fn() }],
          },
        ],
      }),
    );
    expect(lastViewWithLabel('Menu', 'Recent').systemImage).toBe('clock.arrow.circlepath');
    expect(viewsOf('Picker')).toHaveLength(0);
    expect(lastViewWithLabel('Button', 'Crimpy').systemImage).toBe('checkmark');
    expect(lastViewWithLabel('Button', 'Slopers').systemImage).toBeUndefined();
    expect(lastViewWithLabel('Button', 'Clear').role).toBe('destructive');
    // The checked one re-applies too.
    fireEvent.click(container.querySelector('[data-label="Crimpy"]') as Element);
    fireEvent.click(container.querySelector('[data-label="Slopers"]') as Element);
    expect(onSelect.mock.calls).toEqual([['a'], ['b']]);
  });

  it('marks a toggle as a toggle that is on or off', () => {
    const toggle = (active: boolean): Capsule => ({
      kind: 'toggle',
      key: 'beta',
      label: 'Beta',
      active,
      onPress: vi.fn(),
    });
    const { rerender } = render(createElement(CapsuleRow, { capsules: [toggle(false)] }));
    expect(lastViewWithLabel('Button', 'Beta').modifiers?.at(-1)).toEqual({
      modifier: 'accessibilityAddTraits',
      arg: ['isToggle'],
    });
    rerender(createElement(CapsuleRow, { capsules: [toggle(true)] }));
    expect(lastViewWithLabel('Button', 'Beta').modifiers?.at(-1)).toEqual({
      modifier: 'accessibilityAddTraits',
      arg: ['isToggle', 'isSelected'],
    });
  });

  it('draws a toggleMenu as a Menu whose tap toggles and whose long-press holds the actions', () => {
    const onPress = vi.fn();
    const onLock = vi.fn();
    const { container } = render(
      createElement(CapsuleRow, {
        capsules: [
          {
            kind: 'toggleMenu',
            key: 'tall',
            label: 'Tall',
            active: true,
            icon: 'locked',
            onPress,
            actions: [{ key: 'lock', label: 'Unlock', icon: 'unlock', onPress: onLock }],
          },
        ],
      }),
    );
    const menu = lastViewWithLabel('Menu', 'Tall');
    expect(menu.systemImage).toBe('lock.fill');
    expect(menu.onPrimaryAction).toBe(onPress);
    expect(menu.modifiers).toEqual(ACTIVE);
    expect(lastViewWithLabel('Button', 'Unlock').systemImage).toBe('lock.open');
    fireEvent.click(container.querySelector('[data-label="Unlock"]') as Element);
    expect(onLock).toHaveBeenCalledTimes(1);
  });
});
