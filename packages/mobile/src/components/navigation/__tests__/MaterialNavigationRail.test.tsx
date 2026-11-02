// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({
  segments: ['(tabs)', 'home'] as readonly string[],
  navigate: vi.fn(),
}));

vi.mock('react-native', () => ({
  // Android context: `theme/colors` (pulled in transitively via `theme/tokens`)
  // branches on `Platform.OS` and only calls `PlatformColor` on iOS.
  Platform: { OS: 'android', select: (spec: Record<string, unknown>) => spec.android ?? spec.default },
  PlatformColor: (name: string) => name,
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': style == null ? '' : JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ navigate: cfg.navigate }),
  useSegments: () => cfg.segments,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }),
}));

// PressableSurface → a button exposing the testID, the selected a11y state, and press.
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    testID,
    accessibilityState,
    onPress,
  }: {
    children?: ReactNode;
    testID?: string;
    accessibilityState?: { selected?: boolean };
    onPress?: () => void;
  }) =>
    createElement(
      'button',
      { 'data-testid': testID, 'data-selected': String(Boolean(accessibilityState?.selected)), onClick: onPress },
      children,
    ),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', {}, children),
}));

vi.mock('../SidebarWallCell', () => ({
  SidebarWallCell: () => createElement('aside', { 'data-wall-cell': 'true' }),
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: ({ name }: { name: string }) => createElement('span', { 'data-icon': name }),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    m3: {
      secondaryContainer: '#4A3C6B',
      onSecondaryContainer: '#E7DEFF',
      onSurface: '#E6E0EC',
      onSurfaceVariant: '#C9C2D4',
      outlineVariant: '#49454F',
    },
    m3SurfaceContainers: { lowest: '#0F0B16', low: '#1A1420', base: '#221A2E', high: '#2C2438', highest: '#372E44' },
    brandColors: { primary: '#A78BFA' },
  }),
}));

vi.mock('../../../lib/haptics', () => ({ hapticSelection: vi.fn() }));

import { MaterialNavigationRail } from '../MaterialNavigationRail';

// Rail order: Climbs is the last primary row, as it is the rightmost phone tab;
// Profile stays pinned at the bottom.
// The Wall display is no destination: it opens from the board sheet and the
// Climbs menu.
const SEGMENTS = ['home', 'record', 'discover', 'climbs', 'profile'];

describe('MaterialNavigationRail', () => {
  beforeEach(() => {
    cfg.segments = ['(tabs)', 'home'];
    cfg.navigate.mockClear();
  });

  it('renders all five destinations (four primary + pinned profile) in rail order', () => {
    const { container } = render(<MaterialNavigationRail />);
    for (const segment of SEGMENTS) {
      expect(container.querySelector(`[data-testid="tablet-rail-${segment}"]`)).not.toBeNull();
    }
    const renderedOrder = Array.from(container.querySelectorAll('[data-testid^="tablet-rail-"]')).map((row) =>
      row.getAttribute('data-testid')?.replace('tablet-rail-', ''),
    );
    expect(renderedOrder.filter((segment) => segment && SEGMENTS.includes(segment))).toEqual(SEGMENTS);
  });

  it('marks only the focused destination selected', () => {
    cfg.segments = ['(tabs)', 'climbs'];
    const { container } = render(<MaterialNavigationRail />);
    expect(container.querySelector('[data-testid="tablet-rail-climbs"]')?.getAttribute('data-selected')).toBe('true');
    expect(container.querySelector('[data-testid="tablet-rail-home"]')?.getAttribute('data-selected')).toBe('false');
    expect(container.querySelector('[data-testid="tablet-rail-profile"]')?.getAttribute('data-selected')).toBe('false');
  });

  it('shows the ambient wall cell only when showWallCell is set', () => {
    const shown = render(<MaterialNavigationRail showWallCell />);
    expect(shown.container.querySelector('[data-wall-cell="true"]')).not.toBeNull();

    const hidden = render(<MaterialNavigationRail showWallCell={false} />);
    expect(hidden.container.querySelector('[data-wall-cell="true"]')).toBeNull();
  });

  it('navigates to a destination href on press', () => {
    const { container } = render(<MaterialNavigationRail />);
    fireEvent.click(container.querySelector('[data-testid="tablet-rail-discover"]')!);
    expect(cfg.navigate).toHaveBeenCalledWith('/discover');
  });

  it('shows the focused (filled) glyph for the active destination and outline for the rest', () => {
    cfg.segments = ['(tabs)', 'home'];
    const { container } = render(<MaterialNavigationRail />);
    // Active home → filled 'home'; inactive discover → 'bookmark-multiple-outline'.
    expect(container.querySelector('[data-icon="home"]')).not.toBeNull();
    expect(container.querySelector('[data-icon="bookmark-multiple-outline"]')).not.toBeNull();
  });
});
