// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Controls whether `useNativeGlass()` reports the real iOS 26 glass path.
// `useNativeGlass()` (via `useEffectiveSurfaceMode()`) already collapses
// Reduce Transparency (solid) and iOS < 26 (blur) down to `false` — this
// component only ever consumes that boolean, so both non-glass paths are
// exercised here as `nativeGlass = false`.
const ctrl = vi.hoisted(() => ({ nativeGlass: false }));

vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1, absoluteFill: {} },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

vi.mock('../../../hooks/use-native-glass', () => ({
  useNativeGlass: () => ctrl.nativeGlass,
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ systemColors: { label: '#111111', separator: '#CCCCCC', elevatedSurface: '#FFFFFF' } }),
}));

vi.mock('../../../theme/ios-colors', () => ({ iosSystemColors: { white: '#FFFFFF' } }));

// The playlist component imports the toolbar shell through the chrome barrel
// (`'../chrome'`), and that barrel re-exports several other chrome components
// that pull in react-native-reanimated / react-native-paper — mock the whole
// barrel down to the two pieces this component actually renders.
vi.mock('../../chrome', () => ({
  GlassActionToolbar: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  GlassToolbarAction: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => createElement('button', { 'aria-label': accessibilityLabel, onClick: onPress }, children),
}));

vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: unknown }) =>
    createElement('span', { 'data-icon': name, 'data-color': typeof color === 'string' ? color : '' }),
}));

import { PlaylistOwnerToolbar } from '../PlaylistOwnerToolbar';

const handlers = {
  onTogglePin: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
};

beforeEach(() => {
  ctrl.nativeGlass = false;
  vi.clearAllMocks();
});

describe('PlaylistOwnerToolbar icon colour', () => {
  it('uses systemColors.label (not white) when there is no native glass — the solid Reduce Transparency path', () => {
    ctrl.nativeGlass = false;
    const { container } = render(
      <PlaylistOwnerToolbar
        isPinned={false}
        onTogglePin={handlers.onTogglePin}
        onEdit={handlers.onEdit}
        onDelete={handlers.onDelete}
      />,
    );
    const icons = container.querySelectorAll('[data-icon]');
    expect(icons.length).toBe(3);
    icons.forEach((icon) => {
      expect(icon.getAttribute('data-color')).toBe('#111111');
      expect(icon.getAttribute('data-color')).not.toBe('#FFFFFF');
    });
  });

  it('uses systemColors.label (not white) when there is no native glass — the iOS < 26 blur path', () => {
    // Same boolean as the solid path from this component's point of view:
    // `useNativeGlass()` already folds blur into `false`.
    ctrl.nativeGlass = false;
    const { container } = render(
      <PlaylistOwnerToolbar
        isPinned
        onTogglePin={handlers.onTogglePin}
        onEdit={handlers.onEdit}
        onDelete={handlers.onDelete}
      />,
    );
    const icons = container.querySelectorAll('[data-icon]');
    expect(icons.length).toBe(3);
    icons.forEach((icon) => {
      expect(icon.getAttribute('data-color')).toBe('#111111');
    });
  });

  it('keeps white glyphs on real iOS 26 Liquid Glass', () => {
    ctrl.nativeGlass = true;
    const { container } = render(
      <PlaylistOwnerToolbar
        isPinned={false}
        onTogglePin={handlers.onTogglePin}
        onEdit={handlers.onEdit}
        onDelete={handlers.onDelete}
      />,
    );
    const icons = container.querySelectorAll('[data-icon]');
    expect(icons.length).toBe(3);
    icons.forEach((icon) => {
      expect(icon.getAttribute('data-color')).toBe('#FFFFFF');
    });
  });

  it('carries pin state via the glyph, not the colour', () => {
    ctrl.nativeGlass = false;
    const { container } = render(
      <PlaylistOwnerToolbar
        isPinned
        onTogglePin={handlers.onTogglePin}
        onEdit={handlers.onEdit}
        onDelete={handlers.onDelete}
      />,
    );
    expect(container.querySelector('[data-icon="pin.fill"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="pin"]')).toBeNull();
  });
});
