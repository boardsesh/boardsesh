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
  Menu: ({ label, children, modifiers }: { label: ReactNode; children: ReactNode; modifiers: Modifier[] }) =>
    createElement('div', { 'data-menu-modifiers': JSON.stringify(modifiers) }, label, children),
  Button: ({ label, onPress }: { label: string; onPress: () => void }) =>
    createElement('button', { onClick: onPress }, label),
  Divider: () => createElement('hr'),
  HStack: ({ children }: { children: ReactNode }) => createElement('div', null, children),
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
      'lineLimit',
      'truncationMode',
      'accessibilityLabel',
      'accessibilityHint',
    ].map((kind) => [kind, (params: unknown) => ({ kind, params })]),
  ),
  shapes: { rectangle: () => ({ shape: 'rectangle' }) },
}));
vi.mock('react-native', () => ({
  StyleSheet: { create: (styles: unknown) => styles },
  Platform: { OS: 'ios', select: (options: { ios?: unknown }) => options.ios },
  PlatformColor: (name: string) => name,
  DynamicColorIOS: (appearances: { light: string }) => appearances.light,
}));
vi.mock('../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { fill: 'systemFill', label: 'label', secondaryLabel: 'secondaryLabel' } }),
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
