// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

type Modifier = { kind: string; params: unknown };
vi.mock('@expo/ui', () => ({
  Host: ({ children, ignoreSafeArea, style }: { children: ReactNode; ignoreSafeArea?: string; style?: unknown }) =>
    createElement(
      'div',
      {
        'data-host-ignore-safe-area': ignoreSafeArea,
        'data-host-style': JSON.stringify(Object.assign({}, ...[style].flat(10).filter(Boolean))),
      },
      children,
    ),
}));
vi.mock('@expo/ui/swift-ui', () => ({
  ContextMenu: Object.assign(
    ({ children }: { children: ReactNode }) => createElement('div', { 'data-context-menu': true }, children),
    {
      Trigger: ({ children }: { children: ReactNode }) =>
        createElement('div', { 'data-context-trigger': true }, children),
      Items: ({ children }: { children: ReactNode }) => createElement('div', { 'data-context-items': true }, children),
    },
  ),
  RNHostView: ({ children, matchContents }: { children: ReactNode; matchContents?: boolean }) =>
    createElement('div', { 'data-rn-match-contents': String(Boolean(matchContents)) }, children),
  Menu: ({ label, children, modifiers }: { label: ReactNode; children: ReactNode; modifiers: Modifier[] }) =>
    createElement('div', { 'data-menu-modifiers': JSON.stringify(modifiers) }, label, children),
  Button: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, label),
  Divider: () => createElement('hr'),
  ControlGroup: ({ children }: { children: ReactNode }) => createElement('section', { 'data-palette': true }, children),
  HStack: ({ children }: { children: ReactNode }) => createElement('div', null, children),
  VStack: ({ children }: { children: ReactNode }) => createElement('div', { 'data-vstack': true }, children),
  Text: ({ children }: { children: ReactNode }) => createElement('span', null, children),
  Image: ({ systemName, size, modifiers }: { systemName: string; size?: number; modifiers?: Modifier[] }) =>
    createElement('i', {
      'data-symbol': systemName,
      'data-size': size,
      'data-glyph-modifiers': JSON.stringify(modifiers ?? []),
    }),
}));
vi.mock('@expo/ui/swift-ui/modifiers', () => ({
  ...Object.fromEntries(
    [
      'buttonStyle',
      'clipShape',
      'contentShape',
      'controlSize',
      'backgroundOverlay',
      'disabled',
      'frame',
      'font',
      'foregroundStyle',
      'lineLimit',
      'truncationMode',
      'accessibilityLabel',
      'accessibilityHint',
    ].map((kind) => [kind, (params: unknown) => ({ kind, params })]),
  ),
  shapes: {
    rectangle: () => ({ shape: 'rectangle' }),
    roundedRectangle: (params: unknown) => ({ shape: 'roundedRectangle', params }),
  },
}));
vi.mock('react-native', () => ({
  View: ({
    children,
    onLayout,
    style,
  }: {
    children?: ReactNode;
    onLayout?: (event: { nativeEvent: { layout: { width: number } } }) => void;
    style?: { backgroundColor?: string };
  }) =>
    createElement(
      'div',
      {
        'data-measured-menu-anchor': onLayout ? true : undefined,
        'data-row-background': style && !Array.isArray(style) ? style.backgroundColor : undefined,
        onClick: onLayout ? () => onLayout({ nativeEvent: { layout: { width: 326 } } }) : undefined,
      },
      children,
    ),
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: { background: 'background', fill: 'systemFill', label: 'label', secondaryLabel: 'secondaryLabel' },
  }),
}));

import { AppMenu } from '../AppMenu.ios';

const actions = [{ label: 'Choose holds' }, { label: 'Blocked route action', disabled: true }];
const modifiersOf = (container: HTMLElement): Modifier[] =>
  JSON.parse(container.querySelector('[data-menu-modifiers]')?.getAttribute('data-menu-modifiers') ?? '[]');

describe('AppMenu (iOS) icon surfaces', () => {
  it('keeps the filled circular icon anchor by default', () => {
    const { container } = render(
      createElement(AppMenu, { iconName: 'more', accessibilityLabel: 'More actions', actions, onSelectIndex: vi.fn() }),
    );
    expect(modifiersOf(container)).toContainEqual({ kind: 'backgroundOverlay', params: { color: 'systemFill' } });
    expect(modifiersOf(container)).toContainEqual({ kind: 'clipShape', params: 'circle' });
  });

  it('uses the shared toolbar surface while retaining its target, spoken name and guarded actions', () => {
    const onSelectIndex = vi.fn();
    const { container, getByText } = render(
      createElement(AppMenu, {
        iconName: 'more',
        iconAppearance: 'plain',
        accessibilityLabel: 'More actions',
        accessibilityHint: 'Open climb actions',
        actions,
        onSelectIndex,
      }),
    );
    const modifiers = modifiersOf(container);
    expect(modifiers.some((modifier) => modifier.kind === 'backgroundOverlay')).toBe(false);
    expect(modifiers.some((modifier) => modifier.kind === 'clipShape')).toBe(false);
    expect(modifiers).toContainEqual({ kind: 'frame', params: { width: 44, height: 44 } });
    expect(modifiers).toContainEqual({ kind: 'accessibilityLabel', params: 'More actions' });
    expect(modifiers).toContainEqual({ kind: 'accessibilityHint', params: 'Open climb actions' });
    fireEvent.click(getByText('Blocked route action'));
    expect(onSelectIndex).not.toHaveBeenCalled();
    fireEvent.click(getByText('Choose holds'));
    expect(onSelectIndex).toHaveBeenCalledWith(0);
  });

  it('fits a glyph anchor to a narrower toolbar slot without shrinking the glyph', () => {
    const { container } = render(
      createElement(AppMenu, {
        iconName: 'more',
        iconAppearance: 'plain',
        anchorSize: 38,
        accessibilityLabel: 'More actions',
        actions,
        onSelectIndex: vi.fn(),
      }),
    );
    expect(modifiersOf(container)).toContainEqual({ kind: 'frame', params: { width: 38, height: 38 } });
    const glyph = container.querySelector('[data-symbol]')!;
    expect(glyph.getAttribute('data-size')).toBe('17');
    expect(JSON.parse(glyph.getAttribute('data-glyph-modifiers') ?? '[]')).toContainEqual({
      kind: 'frame',
      params: { width: 38, height: 38 },
    });
    expect(JSON.parse(container.querySelector('[data-host-style]')?.getAttribute('data-host-style') ?? '{}')).toEqual({
      minHeight: 38,
    });
  });

  it('keeps the 44pt anchor frame and floor without an anchorSize', () => {
    const { container } = render(
      createElement(AppMenu, { iconName: 'more', accessibilityLabel: 'More actions', actions, onSelectIndex: vi.fn() }),
    );
    const glyph = container.querySelector('[data-symbol]')!;
    expect(JSON.parse(glyph.getAttribute('data-glyph-modifiers') ?? '[]')).toContainEqual({
      kind: 'frame',
      params: { width: 44, height: 44 },
    });
    expect(JSON.parse(container.querySelector('[data-host-style]')?.getAttribute('data-host-style') ?? '{}')).toEqual({
      minHeight: 44,
    });
  });

  it('keeps the text anchor glass capsule', () => {
    const { container } = render(createElement(AppMenu, { label: 'My crew', actions, onSelectIndex: vi.fn() }));
    expect(modifiersOf(container)).toContainEqual({ kind: 'buttonStyle', params: 'glass' });
    expect(modifiersOf(container)).toContainEqual({ kind: 'controlSize', params: 'large' });
  });
});

describe('AppMenu (iOS) dividers', () => {
  it('draws a Material headline as flat title text over the scope, read as one name', () => {
    const { container } = render(
      createElement(AppMenu, { label: 'My crew', headline: 'Home', actions, onSelectIndex: vi.fn() }),
    );
    const stack = container.querySelector('[data-vstack]');
    expect(Array.from(stack?.querySelectorAll('span') ?? []).map((text) => text.textContent)).toEqual([
      'Home',
      'My crew',
    ]);
    const kinds = modifiersOf(container).map((modifier) => modifier.kind);
    expect(modifiersOf(container)).toContainEqual({ kind: 'buttonStyle', params: 'plain' });
    expect(kinds).not.toContain('controlSize');
    expect(modifiersOf(container)).toContainEqual({ kind: 'accessibilityLabel', params: 'Home, My crew' });
  });

  it('draws a UIMenu separator above a row that opens a group, without taking an index', () => {
    const onSelectIndex = vi.fn();
    const { container, getByText } = render(
      createElement(AppMenu, {
        iconName: 'more',
        accessibilityLabel: 'More actions',
        actions: [
          { label: 'Add to queue', dividerBefore: true },
          { label: 'Share' },
          { label: 'Report', dividerBefore: true },
        ],
        onSelectIndex,
      }),
    );
    const rows = [...container.querySelectorAll('button, hr')].map((node) => node.tagName.toLowerCase());
    // Never above the first row: there is no group above it to close.
    expect(rows).toEqual(['button', 'button', 'hr', 'button']);
    fireEvent.click(getByText('Report'));
    expect(onSelectIndex).toHaveBeenCalledWith(2);
  });
});

describe('AppMenu (iOS) hosting', () => {
  it('hosts the existing row body in a native context menu without adding icon sizing or consuming its tap', () => {
    const onRowPress = vi.fn();
    const onSelectIndex = vi.fn();
    const { container, getByText } = render(
      createElement(AppMenu, {
        trigger: 'longPress',
        liftPreview: true,
        previewOverlayColor: 'selectedWash',
        children: createElement('button', { onClick: onRowPress }, 'Climb row'),
        actions,
        onSelectIndex,
      }),
    );
    // Never mount an unconstrained native bridge: it retains intrinsic widths.
    expect(container.querySelector('[data-context-menu]')).toBeNull();
    expect(getByText('Climb row')).toBeTruthy();
    fireEvent.click(container.querySelector('[data-measured-menu-anchor]')!);
    expect(container.querySelector('[data-context-menu]')).not.toBeNull();
    expect(container.querySelector('[data-context-trigger] [data-rn-match-contents="true"]')?.textContent).toBe(
      'Climb row',
    );
    expect(container.querySelector('[data-menu-modifiers]')).toBeNull();
    expect(JSON.parse(container.querySelector('[data-host-style]')?.getAttribute('data-host-style') ?? '{}')).toEqual({
      width: 326,
    });
    expect(container.querySelector('[data-host-ignore-safe-area]')?.getAttribute('data-host-ignore-safe-area')).toBe(
      'all',
    );
    fireEvent.click(getByText('Climb row'));
    expect(onRowPress).toHaveBeenCalledOnce();
    expect(onSelectIndex).not.toHaveBeenCalled();
    fireEvent.click(getByText('Blocked route action'));
    expect(onSelectIndex).not.toHaveBeenCalled();
    fireEvent.click(getByText('Choose holds'));
    expect(onSelectIndex).toHaveBeenCalledWith(0);
  });

  it('keeps the hosted row across a target change and redraws only the items', () => {
    const props = {
      trigger: 'longPress' as const,
      children: createElement('span', null, 'Climb row'),
      actions,
      onSelectIndex: vi.fn(),
    };
    const { container, getByText, rerender } = render(createElement(AppMenu, { ...props, menuKey: 'climb-a' }));
    fireEvent.click(container.querySelector('[data-measured-menu-anchor]')!);
    const row = getByText('Climb row');
    const item = getByText('Choose holds');
    // A recycled cell: same width, new climb. The row (and its board art) stays
    // mounted; an item still drawn for the old climb belongs to a Button that is gone.
    rerender(createElement(AppMenu, { ...props, menuKey: 'climb-b' }));
    expect(getByText('Climb row')).toBe(row);
    expect(getByText('Choose holds')).not.toBe(item);
    expect(item.isConnected).toBe(false);
  });

  it('keeps the hosted row when its rows drop to none, and draws no items for a hold', () => {
    const props = {
      trigger: 'longPress' as const,
      children: createElement('span', null, 'Climb row'),
      onSelectIndex: vi.fn(),
    };
    const { container, getByText, rerender } = render(createElement(AppMenu, { ...props, actions, menuKey: 'a' }));
    fireEvent.click(container.querySelector('[data-measured-menu-anchor]')!);
    const row = getByText('Climb row');
    rerender(createElement(AppMenu, { ...props, actions: [], menuKey: 'edit' }));
    expect(getByText('Climb row')).toBe(row);
    expect(container.querySelector('[data-context-items]')).toBeNull();
    rerender(createElement(AppMenu, { ...props, actions, menuKey: 'a' }));
    expect(getByText('Climb row')).toBe(row);
    expect(container.querySelector('[data-context-items]')).not.toBeNull();
  });

  it('draws the lifted preview on the surface the row sits on', () => {
    const { container } = render(
      createElement(AppMenu, {
        trigger: 'longPress',
        liftPreview: true,
        previewBackgroundColor: 'secondaryBackground',
        children: createElement('span', null, 'Queue row'),
        actions,
        onSelectIndex: vi.fn(),
      }),
    );
    fireEvent.click(container.querySelector('[data-measured-menu-anchor]')!);
    expect(container.querySelector('[data-row-background]')?.getAttribute('data-row-background')).toBe(
      'secondaryBackground',
    );
  });

  it('never takes the screen safe-area inset, so a menu that mounts scrolled under the status bar stays in its frame', () => {
    for (const props of [{ iconName: 'more' as const, accessibilityLabel: 'More actions' }, { label: 'Everyone' }]) {
      const { container, unmount } = render(createElement(AppMenu, { ...props, actions, onSelectIndex: vi.fn() }));
      expect(container.querySelector('[data-host-ignore-safe-area]')?.getAttribute('data-host-ignore-safe-area')).toBe(
        'all',
      );
      unmount();
    }
  });
});

describe('AppMenu (iOS) palette rows', () => {
  const paletteActions = [
    { label: 'Favourite', palette: true as const, systemIcon: 'heart' },
    { label: 'Playlist', palette: true as const, disabled: true },
    { label: 'Share', palette: true as const },
    { label: 'Queue', dividerBefore: true },
  ];
  const render3 = (actions: typeof paletteActions, onSelectIndex = vi.fn()) =>
    render(createElement(AppMenu, { iconName: 'more', accessibilityLabel: 'More', actions, onSelectIndex }));

  it('draws the leading palette rows as one control group and keeps indices', () => {
    const onSelectIndex = vi.fn();
    const { container, getByText } = render3(paletteActions, onSelectIndex);
    const group = container.querySelector('[data-palette]')!;
    expect([...group.querySelectorAll('button')].map((node) => node.textContent)).toEqual([
      'Favourite',
      'Playlist',
      'Share',
    ]);
    fireEvent.click(getByText('Share'));
    expect(onSelectIndex).toHaveBeenLastCalledWith(2);
    fireEvent.click(getByText('Queue'));
    expect(onSelectIndex).toHaveBeenLastCalledWith(3);
    onSelectIndex.mockClear();
    fireEvent.click(getByText('Playlist'));
    expect(onSelectIndex).not.toHaveBeenCalled();
  });

  it('falls back to plain rows for a lone palette row', () => {
    const { container } = render3([{ label: 'Share', palette: true as const }, ...paletteActions.slice(3)]);
    expect(container.querySelector('[data-palette]')).toBeNull();
  });

  it('does not group a palette row that follows a plain row', () => {
    const { container } = render3([
      { label: 'Queue' } as never,
      { label: 'A', palette: true as const },
      { label: 'B', palette: true as const },
    ]);
    expect(container.querySelector('[data-palette]')).toBeNull();
  });
});
