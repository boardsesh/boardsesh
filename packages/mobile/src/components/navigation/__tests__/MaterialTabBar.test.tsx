// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const ctrl = vi.hoisted(() => ({
  os: 'ios' as string,
  // The Android phone bar over a tab root (hide-on-scroll), and whether it is hidden.
  overlay: false,
  hidden: false,
  colorScheme: 'dark' as 'light' | 'dark',
}));

// Shared with the theme-provider mock below, so the assertion can't drift from it.
const { FOCUSED_INDICATOR_COLOR } = vi.hoisted(() => ({ FOCUSED_INDICATOR_COLOR: '#4A4458' }));

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
    flatten: (style: unknown) => (Array.isArray(style) ? Object.assign({}, ...style) : style),
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
        ...(props.pointerEvents ? { 'data-pointer-events': props.pointerEvents } : {}),
        ...(props.importantForAccessibility ? { 'data-a11y': props.importantForAccessibility } : {}),
      },
      children,
    ),
}));

vi.mock('react-native-reanimated', async () => {
  const { View } = await import('react-native');
  return {
    default: { createAnimatedComponent: (component: unknown) => component, View },
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value }),
    withSpring: (value: number) => value,
  };
});

vi.mock('expo-linear-gradient', () => ({
  LinearGradient: ({ colors, pointerEvents, style }: { colors: string[]; pointerEvents?: string; style?: unknown }) =>
    createElement('div', {
      'data-testid': 'fade',
      'data-colors': JSON.stringify(colors),
      'data-pointer-events': pointerEvents,
      'data-style': JSON.stringify(style),
    }),
}));

vi.mock('../../../hooks/use-bottom-chrome-metrics', () => ({
  useBottomChromeMetrics: () => ({ jsBarOverlaysContent: ctrl.overlay }),
}));

vi.mock('../../../lib/tab-bar-hide-progress', () => ({ tabBarHiddenProgress: { value: 0 } }));

vi.mock('../../../lib/tab-bar-visibility-store', () => ({ useTabBarHidden: () => ctrl.hidden }));

vi.mock('../../../providers/tab-bar-height-provider', () => ({
  useSetMeasuredTabBarHeight: () => () => {},
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
  Text: ({ children, maxFontSizeMultiplier }: { children?: ReactNode; maxFontSizeMultiplier?: number }) =>
    createElement('span', { 'data-max-font-scale': maxFontSizeMultiplier }, children),
}));

vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));

vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({
    systemColors: {
      elevatedSurface: '#2C2C2E',
      separator: '#3A3A3C',
      secondaryLabel: '#8E8E93',
    },
    // Seeded with the DARK-scheme brand values so the badge assertions below
    // prove the dot fill comes from the static (light) brand instead.
    brandColors: { primary: '#A78BFA', success: '#34D399', live: '#FBBF24' },
    // Picks the overlay bar's alpha.
    colorScheme: ctrl.colorScheme,
    // M3 navigation-bar roles: active icon on a secondaryContainer pill, active
    // label secondary, inactive icon+label onSurfaceVariant.
    m3: {
      onSecondaryContainer: '#E8DEF8',
      secondary: '#CCC2DC',
      onSurfaceVariant: '#CAC4D0',
      secondaryContainer: FOCUSED_INDICATOR_COLOR,
      surface: '#141218',
    },
  }),
}));

// The real static (light-scheme) brand fills from @boardsesh/velvet-tokens — the
// badge dot is a FILL, so it stays on these in both schemes.
vi.mock('../../../theme/colors', () => ({
  brandColors: { primary: '#6D28D9', success: '#047857', live: '#B45309' },
  withAlpha: (color: string, alpha: number) => `${color}@${alpha}`,
}));

vi.mock('../../../theme/tokens', () => ({
  material: {
    navBar: {
      surfaceElevation: 2,
      overlaySurfaceAlpha: { light: 0.85, dark: 0.92 },
      activeIndicatorWidth: 56,
      activeIndicatorHeight: 32,
      activeIndicatorRadius: 16,
    },
  },
}));

vi.mock('../../../theme/layout', () => ({
  MATERIAL_TAB_BAR_HEIGHT: 64,
}));

import { MaterialTabBar } from '../MaterialTabBar';
import { TAB_BADGE_CONNECTED, TAB_BADGE_LIVE } from '../tab-badge';

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
    emitter: navigation,
    navigateToTab: navigation.navigate,
    insets: { bottom: 0, top: 0, left: 0, right: 0 },
  };
}

beforeEach(() => {
  ctrl.os = 'ios';
  ctrl.overlay = false;
  ctrl.hidden = false;
  ctrl.colorScheme = 'dark';
});

describe('MaterialTabBar', () => {
  describe('badge rendering', () => {
    it('renders a badge dot when tabBarBadge is set', () => {
      const props = makeProps({ tabBarBadge: '' });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      expect(queryByTestId('badge')).not.toBeNull();
    });

    it('does not render a badge when tabBarBadge is undefined', () => {
      const props = makeProps({ tabBarBadge: undefined });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      expect(queryByTestId('badge')).toBeNull();
    });

    it('uses the live color when tabBarBadge carries the live marker', () => {
      const props = makeProps({ tabBarBadge: TAB_BADGE_LIVE });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const style = queryByTestId('badge')?.getAttribute('data-style');
      expect(style).toContain('#B45309');
      expect(style).not.toContain('#047857');
    });

    it('keeps the standard (success) color for the connected marker', () => {
      const props = makeProps({ tabBarBadge: TAB_BADGE_CONNECTED });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const style = queryByTestId('badge')?.getAttribute('data-style');
      expect(style).toContain('#047857');
      expect(style).not.toContain('#B45309');
    });

    // Any badge value that isn't the live marker keeps the standard color — the
    // dot never renders text, so a future count badge degrades to a plain dot
    // rather than picking up the live tint.
    it('keeps the standard color for an unrelated badge value', () => {
      const props = makeProps({ tabBarBadge: 3 });
      const { queryByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const style = queryByTestId('badge')?.getAttribute('data-style');
      expect(style).toContain('#047857');
      expect(style).not.toContain('#B45309');
    });
  });

  describe('active indicator', () => {
    // Toggling color instead of opacity made Android drop the borderRadius clip on focus.
    it('gives every indicator the same tonal color, focused or not', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const indicators = getAllByTestId('indicator');
      for (const indicator of indicators) {
        const style = indicator.getAttribute('data-style');
        expect(style).toContain(`"backgroundColor":"${FOCUSED_INDICATOR_COLOR}"`);
      }
    });

    it('hides the fill via opacity on unfocused tabs', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const indicators = getAllByTestId('indicator');
      const style = indicators[1].getAttribute('data-style');
      expect(style).toContain('"opacity":0');
    });

    it('shows the fill via opacity on the focused tab', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByTestId } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const indicators = getAllByTestId('indicator');
      const style = indicators[0].getAttribute('data-style');
      expect(style).toContain('"opacity":1');
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
      expect(props.emitter.emit).toHaveBeenCalledWith({
        type: 'tabPress',
        target: 'route-b',
        canPreventDefault: true,
      });
      expect(props.navigateToTab).toHaveBeenCalledWith('route-b');
    });

    it('does not navigate when the already-focused tab is pressed', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tabs = getAllByRole('tab');
      // Press the first tab (already focused)
      fireEvent.click(tabs[0]);
      expect(props.emitter.emit).toHaveBeenCalledWith({
        type: 'tabPress',
        target: 'route-a',
        canPreventDefault: true,
      });
      expect(props.navigateToTab).not.toHaveBeenCalled();
    });

    it('emits tabLongPress on long press', () => {
      const props = makeProps({ activeIndex: 0 });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tabs = getAllByRole('tab');
      fireEvent.contextMenu(tabs[1]);
      expect(props.emitter.emit).toHaveBeenCalledWith({
        type: 'tabLongPress',
        target: 'route-b',
      });
    });
  });

  describe('hidden (href:null) routes', () => {
    it('does not render a route whose tabBarItemStyle is display:none', () => {
      // expo-router turns a screen's `href: null` into tabBarItemStyle:{display:'none'}
      // (the iPad-only /wall destination). This custom bar renders every route in
      // state.routes, so it must filter that item or it would show as a phone tab.
      const routes = [
        { key: 'a', name: 'home' },
        { key: 'wall', name: 'wall' },
        { key: 'b', name: 'profile' },
      ];
      const props = {
        state: { routes, index: 0 },
        descriptors: {
          a: { options: { title: 'Home' } },
          wall: { options: { title: 'On the Wall', tabBarItemStyle: { display: 'none' } } },
          b: { options: { title: 'Profile' } },
        },
        emitter: { emit: vi.fn(() => ({ defaultPrevented: false })) },
        navigateToTab: vi.fn(),
        insets: { bottom: 0, top: 0, left: 0, right: 0 },
      };
      const { getAllByRole, queryByLabelText } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      expect(getAllByRole('tab')).toHaveLength(2);
      expect(queryByLabelText('On the Wall')).toBeNull();
      expect(queryByLabelText('Home')).not.toBeNull();
      expect(queryByLabelText('Profile')).not.toBeNull();
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

    // The bar is a fixed 64dp, so the visible label caps at the chrome scale;
    // the full label still reaches screen readers through accessibilityLabel.
    it('caps the visible label at the chrome font scale and keeps it in the a11y label', () => {
      const props = makeProps({ activeIndex: 0, title: 'Climbs' });
      const { getAllByRole } = render(
        <MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />,
      );
      const tab = getAllByRole('tab')[0];
      expect(tab.getAttribute('aria-label')).toBe('Climbs');
      const label = tab.querySelector('span[data-max-font-scale]');
      expect(label?.getAttribute('data-max-font-scale')).toBe('1.2');
      expect(label?.textContent).toBe('Climbs');
    });

    it('falls back to route name when no title is provided', () => {
      const routes = [{ key: 'route-a', name: 'boards' }];
      const props = {
        state: { routes, index: 0 },
        descriptors: {
          'route-a': { options: {} },
        },
        emitter: { emit: vi.fn(() => ({ defaultPrevented: false })) },
        navigateToTab: vi.fn(),
        insets: { bottom: 0, top: 0, left: 0, right: 0 },
      };
      const { getByRole } = render(<MaterialTabBar {...(props as unknown as Parameters<typeof MaterialTabBar>[0])} />);
      expect(getByRole('tab').getAttribute('aria-label')).toBe('boards');
    });
  });

  describe('hide on scroll (Android phone tab roots)', () => {
    const renderBar = () =>
      render(<MaterialTabBar {...(makeProps({}) as unknown as Parameters<typeof MaterialTabBar>[0])} />);
    const barOf = (container: HTMLElement) => container.firstElementChild as HTMLElement;

    it('stays an opaque in-flow bar when it does not overlay content', () => {
      const { container, queryByTestId } = renderBar();
      expect(queryByTestId('fade')).toBeNull();
      const style = barOf(container).getAttribute('data-style') ?? '';
      expect(style).toContain('"backgroundColor":"#2C2C2E"');
      expect(style).not.toContain('"position":"absolute"');
    });

    it('draws over the tab root on a mostly opaque surface, no hairline, no elevated fill', () => {
      ctrl.overlay = true;
      const { container } = renderBar();
      const style = barOf(container).getAttribute('data-style') ?? '';
      expect(style).toContain('"position":"absolute"');
      expect(style).toContain('"borderTopWidth":0');
      // Dark covers more (0.92) so the violet active label clears 4.5:1 over white content.
      expect(style).toContain('"backgroundColor":"#141218@0.92"');
      expect(style).not.toContain('#2C2C2E');
    });

    it('keeps the lighter 0.85 overlay surface in light mode', () => {
      ctrl.overlay = true;
      ctrl.colorScheme = 'light';
      const { container, getByTestId } = renderBar();
      expect(barOf(container).getAttribute('data-style') ?? '').toContain('"backgroundColor":"#141218@0.85"');
      expect(getByTestId('fade').getAttribute('data-colors')).toBe(JSON.stringify(['#141218@0', '#141218@0.85']));
    });

    it('fades 24dp above its top edge into the surface, without taking touches', () => {
      ctrl.overlay = true;
      const { getByTestId } = renderBar();
      const fade = getByTestId('fade');
      expect(fade.getAttribute('data-colors')).toBe(JSON.stringify(['#141218@0', '#141218@0.92']));
      expect(fade.getAttribute('data-pointer-events')).toBe('none');
      const fadeStyle = fade.getAttribute('data-style') ?? '';
      expect(fadeStyle).toContain('"top":-24');
      expect(fadeStyle).toContain('"height":24');
    });

    it('takes a hidden bar out of touch and the TalkBack order', () => {
      ctrl.overlay = true;
      ctrl.hidden = true;
      const { container } = renderBar();
      expect(barOf(container).getAttribute('data-pointer-events')).toBe('none');
      expect(barOf(container).getAttribute('data-a11y')).toBe('no-hide-descendants');
    });

    it('keeps a shown bar reachable', () => {
      ctrl.overlay = true;
      const { container } = renderBar();
      expect(barOf(container).getAttribute('data-pointer-events')).toBe('auto');
      expect(barOf(container).getAttribute('data-a11y')).toBe('auto');
    });
  });
});
