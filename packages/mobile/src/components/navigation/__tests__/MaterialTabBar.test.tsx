// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({
  os: 'ios' as string,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return ctrl.os;
    },
    select: (spec: Record<string, unknown>) => spec[ctrl.os] ?? spec.default ?? {},
  },
  StyleSheet: {
    hairlineWidth: 1,
    absoluteFill: { position: 'absolute' },
    create: (styles: unknown) => styles,
  },
  View: ({
    children,
    style,
    testID,
    ...props
  }: {
    children?: ReactNode;
    style?: unknown;
    testID?: string;
    [key: string]: unknown;
  }) =>
    createElement(
      'div',
      {
        'data-view': 'true',
        'data-style': JSON.stringify(style),
        ...(testID ? { 'data-testid': testID } : {}),
        ...Object.fromEntries(
          Object.entries(props).filter(([k]) => k.startsWith('data-') || k === 'accessibilityRole'),
        ),
      },
      children,
    ),
}));

vi.mock('react-native-reanimated', () => ({
  default: { createAnimatedComponent: (component: unknown) => component },
  useAnimatedStyle: () => ({}),
  useSharedValue: (value: number) => ({ value }),
  withSpring: (value: number) => value,
}));

vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    onPress,
    onLongPress,
    accessibilityRole,
    accessibilityState,
    accessibilityLabel,
    style,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    onLongPress?: () => void;
    accessibilityRole?: string;
    accessibilityState?: { selected?: boolean };
    accessibilityLabel?: string;
    style?: unknown;
  }) =>
    createElement(
      'button',
      {
        onClick: onPress,
        // jsdom has no long-press event; map to contextmenu so fireEvent.contextMenu() triggers it
        onContextMenu: onLongPress,
        role: accessibilityRole,
        'aria-selected': accessibilityState?.selected,
        'aria-label': accessibilityLabel,
        'data-style': JSON.stringify(style),
      },
      children,
    ),
}));

vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      elevatedSurface: '#2C2C2E',
      separator: '#3A3A3C',
      secondaryLabel: '#8E8E93',
    },
    // MaterialTabBar now reads the scheme-aware brand from the theme (lifted
    // tint in dark) rather than the static import.
    brandColors: { primary: '#FF3B30', primaryFill: '#B3261E', success: '#6B9080' },
    // M3 navigation-bar roles: active icon on a secondaryContainer pill, active
    // label onSurface, inactive icon+label onSurfaceVariant.
    m3: {
      onSecondaryContainer: '#E8DEF8',
      onSurface: '#E6E1E5',
      onSurfaceVariant: '#CAC4D0',
      secondaryContainer: '#4A4458',
    },
  }),
}));

vi.mock('../../../theme/colors', () => ({
  brandColors: { primary: '#FF3B30', primaryFill: '#B3261E', success: '#6B9080' },
}));

vi.mock('../../../theme/tokens', () => ({
  material: {
    navBar: {
      surfaceElevation: 3,
      activeIndicatorWidth: 64,
      activeIndicatorHeight: 32,
      activeIndicatorRadius: 16,
    },
  },
}));

vi.mock('../../../theme/layout', () => ({
  MATERIAL_TAB_BAR_HEIGHT: 80,
}));

import { MaterialTabBar } from '../MaterialTabBar';

function makeProps(overrides: {
  activeIndex?: number;
  routes?: Array<{ key: string; name: string }>;
  tabBarBadge?: unknown;
  tabBarIcon?: ((opts: { focused: boolean; color: string; size: number }) => ReactNode) | null;
  title?: string;
}) {
  const routes = overrides.routes ?? [
    { key: 'route-a', name: 'home' },
    { key: 'route-b', name: 'profile' },
  ];
  const activeIndex = overrides.activeIndex ?? 0;

  const descriptors = Object.fromEntries(
    routes.map((route, i) => [
      route.key,
      {
        options: {
          title: overrides.title ?? route.name,
          tabBarIcon:
            overrides.tabBarIcon !== undefined
              ? (overrides.tabBarIcon ?? undefined)
              : i === 0
                ? ({ focused }: { focused: boolean }) =>
                    createElement('span', { 'data-icon': 'true', 'data-focused': String(focused) })
                : undefined,
          tabBarBadge: i === 0 && overrides.tabBarBadge !== undefined ? overrides.tabBarBadge : undefined,
        },
      },
    ]),
  );

  const navigation = {
    emit: vi.fn(({ type }: { type: string }) => ({ type, defaultPrevented: false })),
    navigate: vi.fn(),
  };

  return {
    state: {
      key: 'tab-state',
      type: 'tab',
      stale: false as const,
      routeNames: routes.map((r) => r.name),
      routes,
      index: activeIndex,
    },
    descriptors,
    navigation,
    insets: { bottom: 0, top: 0, left: 0, right: 0 },
  };
}

beforeEach(() => {
  ctrl.os = 'ios';
});

describe('MaterialTabBar', () => {
  describe('badge rendering', () => {
    it('renders a badge dot when tabBarBadge is set', () => {
      const props = makeProps({ tabBarBadge: 'bluetooth' });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      expect(queryByTestId('badge')).not.toBeNull();
    });

    it('renders the bluetooth badge as the established green dot', () => {
      const props = makeProps({ tabBarBadge: 'bluetooth' });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const badgeStyle = queryByTestId('badge')?.getAttribute('data-style') ?? '';

      expect(badgeStyle).toContain('"width":9');
      expect(badgeStyle).toContain('"height":9');
      expect(badgeStyle).toContain('"backgroundColor":"#6B9080"');
    });

    it('renders the session badge as a primary pill', () => {
      const props = makeProps({ tabBarBadge: 'session' });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const badgeStyle = queryByTestId('badge')?.getAttribute('data-style') ?? '';

      expect(badgeStyle).toContain('"width":16');
      expect(badgeStyle).toContain('"height":9');
      expect(badgeStyle).toContain('"backgroundColor":"#B3261E"');
    });

    it('does not render a badge when tabBarBadge is undefined', () => {
      const props = makeProps({ tabBarBadge: undefined });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      expect(queryByTestId('badge')).toBeNull();
    });
  });

  describe('navigation callbacks', () => {
    it('emits tabPress and navigates when an inactive tab is pressed', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tabs = getAllByRole('tab');
      // Press the second tab (index 1, inactive)
      fireEvent.click(tabs[1]);
      expect(props.navigation.emit).toHaveBeenCalledWith({
        type: 'tabPress',
        target: 'route-b',
        canPreventDefault: true,
      });
      expect(props.navigation.navigate).toHaveBeenCalledWith('profile');
    });

    it('does not navigate when the already-focused tab is pressed', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tabs = getAllByRole('tab');
      // Press the first tab (already focused)
      fireEvent.click(tabs[0]);
      expect(props.navigation.emit).toHaveBeenCalledWith({
        type: 'tabPress',
        target: 'route-a',
        canPreventDefault: true,
      });
      expect(props.navigation.navigate).not.toHaveBeenCalled();
    });

    it('emits tabLongPress on long press', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tabs = getAllByRole('tab');
      fireEvent.contextMenu(tabs[1]);
      expect(props.navigation.emit).toHaveBeenCalledWith({
        type: 'tabLongPress',
        target: 'route-b',
      });
    });
  });

  describe('accessibility state', () => {
    it('marks the focused tab as selected', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tabs = getAllByRole('tab');
      expect(tabs[0].getAttribute('aria-selected')).toBe('true');
    });

    it('marks unfocused tabs as not selected', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tabs = getAllByRole('tab');
      expect(tabs[1].getAttribute('aria-selected')).toBe('false');
    });

    it('uses the title as the accessibility label', () => {
      const props = makeProps({ activeIndex: 0, title: 'Home' });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tabs = getAllByRole('tab');
      expect(tabs[0].getAttribute('aria-label')).toBe('Home');
    });

    it('falls back to route name when no title is provided', () => {
      const routes = [{ key: 'route-a', name: 'boards' }];
      const props = {
        state: { routes, index: 0 },
        descriptors: {
          'route-a': { options: {} },
        },
        navigation: {
          emit: vi.fn(() => ({ defaultPrevented: false })),
          navigate: vi.fn(),
        },
        insets: { bottom: 0, top: 0, left: 0, right: 0 },
      };
      const { getByRole } = render(<MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />);
      expect(getByRole('tab').getAttribute('aria-label')).toBe('boards');
    });
  });
});
