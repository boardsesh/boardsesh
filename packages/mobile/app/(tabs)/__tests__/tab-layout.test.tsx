// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({
  bluetoothConnected: false,
  sessionId: null as string | null,
  nativeAccessoryActive: true,
  hasCurrentClimb: false,
  // Whether the focused route is an accessory surface (a top-level tab page, or the
  // player). The native bottom accessory only mounts there; a pushed sub-route
  // (session detail) or a root modal takes it off the surface, so the host unmounts.
  onAccessorySurface: true,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  // Whether the device can render real iOS 26 glass chrome. The native tab bar
  // mounts only for the Liquid Glass variant on a capable device; everything else
  // (Material, plus Liquid Glass on iOS < 26 / Android) takes the JS tab bar.
  glassCapable: true,
  platformOS: 'ios' as 'ios' | 'android' | 'web',
  // 'regular' takes the tablet sidebar shell; 'compact' keeps the phone tab bars.
  widthClass: 'compact' as 'compact' | 'regular',
  // Tablet in a narrow split: compact width but still a tablet, which the shell keeps on
  // JS Tabs (never NativeTabs). Independent of widthClass; 'regular' always implies tablet.
  isTablet: false,
  // Window width drives the wall surface in the regular shell: a dedicated column
  // (landscape) vs a strip atop the pane (portrait) — see resolveWallSurface.
  windowWidth: 1024,
  // Board presence gates the wall column: no bound board → no column (the wall
  // stays the sidebar cell instead).
  boardPresenceEnabled: false,
  boardPresenceBoardId: null as number | null,
  // The column also needs a resolved active board (the panel renders its config);
  // boardId can be set from BLE without one, so the layout gates on this too.
  activeBoard: null as { uuid: string } | null,
  // Launch-fixed device-size class: 'panel-capable' (11" Pro / 13") keeps the wall
  // panel; 'sheet-only' (mini / base 11" / Air) collapses it to the sheet + tab.
  // Default panel-capable so the width-driven wall-surface tests still hold.
  wallDeviceClass: 'panel-capable' as 'panel-capable' | 'sheet-only',
  // Focused route segments — drives the wall-tab redundancy rule (the ambient
  // column is hidden while the "On the Wall" tab is the focused destination).
  segments: ['(tabs)', 'home'] as readonly string[],
  materialScreens: [] as Array<{ name: string; options?: { lazy?: boolean; href?: string | null } }>,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return cfg.platformOS;
    },
  },
  // _layout.tsx wraps the iPad shell in Views + calls StyleSheet.create at module
  // eval, so the strict RN mock must supply both.
  View: ({ children, style }: { children?: ReactNode; style?: unknown }) =>
    createElement('div', { 'data-style': style == null ? '' : JSON.stringify(style) }, children),
  StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 1 },
  // The regular-width shell sizes the play pane + decides the wall surface off the
  // window width.
  useWindowDimensions: () => ({ width: cfg.windowWidth, height: 1366 }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../../../src/lib/ble/bluetooth-status-store', () => ({
  useBluetoothConnectedStatus: () => cfg.bluetoothConnected,
}));

vi.mock('../../../src/providers/queue-provider', () => ({
  useQueueSessionId: () => ({ sessionId: cfg.sessionId }),
}));

// Wall-aware, snapshot-stable presence gate: true for a local OR a live wall
// (board-presence) climb, held briefly across a presence blip. The layout only
// sees the combined boolean — the local-vs-wall split is unit-tested in
// use-has-accessory-climb, and the hold logic in use-sticky-accessory-presence.
vi.mock('../../../src/hooks/use-sticky-accessory-presence', () => ({
  useStickyAccessoryPresence: () => cfg.hasCurrentClimb,
}));

// Route gate on the accessory mount: false on a pushed sub-route or root modal that
// takes the bar off a top-level tab. Driven by useSegments() + isAccessorySurfaceRoute
// in the real hook; the route-segment split is unit-tested in route-segments.test.
vi.mock('../../../src/hooks/use-on-accessory-surface', () => ({
  useOnAccessorySurface: () => cfg.onAccessorySurface,
}));

vi.mock('../../../src/hooks/use-device-layout', () => ({
  // `regular` is only ever reached on a tablet (a phone is always compact), so it
  // always implies isTablet; cfg.isTablet additionally models a tablet in a narrow split.
  useDeviceLayout: () => ({
    widthClass: cfg.widthClass,
    expanded: false,
    isTablet: cfg.widthClass === 'regular' || cfg.isTablet,
    wallDeviceClass: cfg.wallDeviceClass,
  }),
}));

// The shell renders TabletSidebar (the variant router → IpadSidebar glass rail or
// MaterialNavigationRail); mock it so the layout tests don't reach into either rail's
// native surface. The per-variant routing is covered by the variant-component tests.
vi.mock('../../../src/components/navigation/TabletSidebar', () => ({
  TabletSidebar: ({ showWallCell = true }: { showWallCell?: boolean }) =>
    createElement('aside', { 'data-tablet-sidebar': 'true', 'data-show-wall-cell': String(showWallCell) }),
}));

vi.mock('../../../src/components/play-drawer/IpadPlayPane', () => ({
  IpadPlayPane: () => createElement('aside', { 'data-ipad-play-pane': 'true' }),
}));

vi.mock('../../../src/components/board-presence/IpadWallColumn', () => ({
  IpadWallColumn: () => createElement('aside', { 'data-ipad-wall-column': 'true' }),
}));

vi.mock('../../../src/providers/board-presence-provider', () => ({
  useBoardPresenceControls: () => ({ enabled: cfg.boardPresenceEnabled, boardId: cfg.boardPresenceBoardId }),
}));

vi.mock('../../../src/lib/graphql/use-active-board', () => ({
  useActiveBoard: () => ({ data: cfg.activeBoard }),
}));

vi.mock('../../../src/components/queue-control/QueueBottomAccessory', () => ({
  QueueBottomAccessory: () => createElement('div', { 'data-accessory': 'true' }),
}));

vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    variant: cfg.variant,
    systemColors: {
      label: '#F5F2FB',
      secondaryLabel: '#A9A2B6',
      separator: 'rgba(60,55,75,0.18)',
    },
    m3: { outlineVariant: '#49454F' },
    // Record badge color: green for board-connected-only, amber 'live' for a
    // live session — read from the theme now (not a static import) so it
    // resolves per scheme.
    brandColors: { success: '#047857', live: '#FBBF24' },
  }),
}));

vi.mock('../../../src/hooks/use-bottom-accessory', () => ({
  useNativeAccessoryActive: () => cfg.nativeAccessoryActive,
  useNativeTabBar: () => cfg.variant === 'liquidGlass' && cfg.glassCapable,
}));

// Stub the Material-variant path so it doesn't pull in native modules.
vi.mock('expo-router', () => {
  const Tabs = Object.assign(
    ({
      children,
      detachInactiveScreens,
      screenOptions,
    }: {
      children?: ReactNode;
      detachInactiveScreens?: boolean;
      screenOptions?: { freezeOnBlur?: boolean };
    }) =>
      createElement(
        'nav',
        {
          'data-tabs-material': 'true',
          // Surface the #3153 residency props so tests can pin the platform matrix.
          'data-detach-inactive-screens': detachInactiveScreens === undefined ? 'unset' : String(detachInactiveScreens),
          'data-freeze-on-blur':
            screenOptions?.freezeOnBlur === undefined ? 'unset' : String(screenOptions.freezeOnBlur),
        },
        children,
      ),
    {
      Screen: ({ name, options }: { name: string; options?: { lazy?: boolean } }) => {
        const screen = { name, options };
        const existingIndex = cfg.materialScreens.findIndex((entry) => entry.name === name);
        if (existingIndex === -1) cfg.materialScreens.push(screen);
        else cfg.materialScreens[existingIndex] = screen;
        return null;
      },
    },
  );

  return { Tabs, useSegments: () => cfg.segments };
});

vi.mock('../../../src/components/navigation/MaterialTabBar', () => ({
  MaterialTabBar: () => createElement('nav', { 'data-material-tab-bar': 'true' }),
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: () => createElement('span', { 'data-icon': 'mci' }),
}));

// The wall tab holds a keep-awake lock (kiosk stays lit); mock the native module
// so the wall-segment render doesn't reach for it, and assert the lock engages.
const keepAwake = vi.hoisted(() => ({
  activate: vi.fn().mockResolvedValue(undefined),
  deactivate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: keepAwake.activate,
  deactivateKeepAwake: keepAwake.deactivate,
}));

vi.mock('expo-router/unstable-native-tabs', () => {
  const Trigger = Object.assign(
    ({ name, hidden, children }: { name: string; hidden?: boolean; children?: ReactNode }) =>
      // Model NativeTabs: a `hidden` trigger declares the route but is not a tab.
      hidden ? null : createElement('section', { 'data-trigger': name }, children),
    {
      Icon: () => createElement('span', { 'data-icon': 'true' }),
      Label: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
      Badge: ({ children, selectedBackgroundColor }: { children?: ReactNode; selectedBackgroundColor?: string }) =>
        createElement(
          'span',
          { 'data-badge': 'true', 'data-selected-background-color': selectedBackgroundColor ?? '' },
          children,
        ),
    },
  );

  const NativeTabs = Object.assign(
    ({
      children,
      minimizeBehavior,
      iconColor,
      labelStyle,
      tintColor,
      badgeBackgroundColor,
    }: {
      children?: ReactNode;
      minimizeBehavior?: string;
      iconColor?: unknown;
      labelStyle?: unknown;
      tintColor?: unknown;
      badgeBackgroundColor?: string;
    }) =>
      createElement(
        'nav',
        {
          'data-tabs': 'true',
          'data-minimize-behavior': minimizeBehavior ?? '',
          'data-icon-color': JSON.stringify(iconColor),
          'data-label-style': JSON.stringify(labelStyle),
          'data-tint-color': typeof tintColor === 'string' ? tintColor : '',
          'data-badge-background-color': badgeBackgroundColor ?? '',
        },
        children,
      ),
    {
      BottomAccessory: ({ children }: { children?: ReactNode }) =>
        createElement('div', { 'data-bottom-accessory': 'true' }, children),
      Trigger,
    },
  );

  return { NativeTabs };
});

import TabLayout, { unstable_settings } from '../_layout';
import { TAB_BADGE_CONNECTED, TAB_BADGE_LIVE } from '../../../src/components/navigation/tab-badge';

describe('TabLayout', () => {
  beforeEach(() => {
    cfg.bluetoothConnected = false;
    cfg.sessionId = null;
    cfg.nativeAccessoryActive = true;
    cfg.hasCurrentClimb = false;
    cfg.onAccessorySurface = true;
    cfg.variant = 'liquidGlass';
    cfg.glassCapable = true;
    cfg.platformOS = 'ios';
    cfg.widthClass = 'compact';
    cfg.isTablet = false;
    cfg.windowWidth = 1024;
    cfg.boardPresenceEnabled = false;
    cfg.boardPresenceBoardId = null;
    cfg.activeBoard = null;
    cfg.wallDeviceClass = 'panel-capable';
    cfg.segments = ['(tabs)', 'home'];
    cfg.materialScreens = [];
    keepAwake.activate.mockClear();
    keepAwake.deactivate.mockClear();
  });

  it('lands on the home tab by default', () => {
    expect(unstable_settings.initialRouteName).toBe('home');
  });

  it('renders Home as the leftmost native tab', () => {
    const { container } = render(<TabLayout />);
    const triggerNames = Array.from(container.querySelectorAll('[data-trigger]')).map((trigger) =>
      trigger.getAttribute('data-trigger'),
    );

    expect(triggerNames).toEqual(['home', 'climbs', 'record', 'discover', 'profile']);
  });

  it('registers Home as the leftmost material tab', () => {
    cfg.variant = 'material';

    render(<TabLayout />);

    expect(cfg.materialScreens.map((screen) => screen.name)).toEqual([
      'home',
      'climbs',
      'record',
      'wall',
      'discover',
      'profile',
    ]);
  });

  it('falls back to the JS Material tab bar for Liquid Glass on a non-capable device', () => {
    // Older iPhone / Android on the Liquid Glass variant: the native iOS 26 tab bar
    // can't render, so the JS Tabs + MaterialTabBar carry the navigation instead.
    cfg.variant = 'liquidGlass';
    cfg.glassCapable = false;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-tabs-material="true"]')).not.toBeNull();
    expect(container.querySelector('[data-tabs="true"]')).toBeNull();
    expect(cfg.materialScreens.map((screen) => screen.name)).toEqual([
      'home',
      'climbs',
      'record',
      'wall',
      'discover',
      'profile',
    ]);
  });

  it('keeps an iPad in a narrow split on the JS Material tab bar (never NativeTabs)', () => {
    // Slide Over / Split View: compact width but still an iPad. The single-navigator
    // shell routes it through JS Tabs + the Material bar so a resize across the 700pt
    // boundary doesn't swap navigator types — NativeTabs never renders on iPad, and
    // there's no rail at compact width.
    cfg.isTablet = true;
    cfg.widthClass = 'compact';
    cfg.variant = 'liquidGlass';
    cfg.glassCapable = true;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-tabs-material="true"]')).not.toBeNull();
    expect(container.querySelector('[data-tabs="true"]')).toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')).toBeNull();
    expect(cfg.materialScreens.map((screen) => screen.name)).toEqual([
      'home',
      'climbs',
      'record',
      'wall',
      'discover',
      'profile',
    ]);
  });

  it('renders the iPad sidebar shell at regular width and registers all six tabs (wall hidden from the bar)', () => {
    // Regular-width iPad takes the sidebar branch before the native/Material tab
    // bars: the glass sidebar carries navigation and the native iOS 26 tab bar is
    // gone, but the Tabs navigator still registers every tab screen.
    cfg.widthClass = 'regular';

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-tablet-sidebar="true"]')).not.toBeNull();
    // The right column hosts the PlayDrawer pane (replaces the floating accessory bar).
    expect(container.querySelector('[data-ipad-play-pane="true"]')).not.toBeNull();
    // At narrow-regular width (1024) the wall has no room for a column, so it stays
    // the sidebar cell — no dedicated column, rail cell shown.
    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('true');
    expect(container.querySelector('[data-tabs="true"]')).toBeNull();
    expect(cfg.materialScreens.map((screen) => screen.name)).toEqual([
      'home',
      'climbs',
      'record',
      'wall',
      'discover',
      'profile',
    ]);
    // The wall screen registers with href:null so it never shows as a Material tab
    // button (MaterialTabBar filters the resulting display:none item).
    expect(cfg.materialScreens.find((screen) => screen.name === 'wall')?.options).toMatchObject({ href: null });
  });

  it('mounts the same shell on an Android tablet (Material variant, regular width, no NativeTabs)', () => {
    // An Android tablet resolves the Material variant and, at regular width, takes the
    // adaptive-shell branch exactly like an iPad: the rail (TabletSidebar → the M3
    // navigation rail) carries navigation over a hidden JS Tabs bar, with the detail
    // pane beside it. The native glass tab bar never exists on Android.
    cfg.platformOS = 'android';
    cfg.variant = 'material';
    cfg.glassCapable = false;
    cfg.widthClass = 'regular';

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-tablet-sidebar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ipad-play-pane="true"]')).not.toBeNull();
    expect(container.querySelector('[data-tabs="true"]')).toBeNull();
    expect(cfg.materialScreens.map((screen) => screen.name)).toEqual([
      'home',
      'climbs',
      'record',
      'wall',
      'discover',
      'profile',
    ]);
  });

  it('keeps a compact Android tablet (small multi-window split) on the Material bar, no rail', () => {
    // A tablet in a small freeform / split-screen window is still a tablet (sw600dp,
    // launch-fixed) but reads `compact` from the live width — so it stays on the single
    // JS Tabs navigator + Material bar with no rail, mirroring an iPad in a narrow split.
    cfg.platformOS = 'android';
    cfg.variant = 'material';
    cfg.glassCapable = false;
    cfg.widthClass = 'compact';
    cfg.isTablet = true;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-tabs-material="true"]')).not.toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')).toBeNull();
    expect(container.querySelector('[data-tabs="true"]')).toBeNull();
  });

  it('adapts an eligible web screen from the Material bar to the desktop tablet shell', () => {
    cfg.platformOS = 'web';
    cfg.variant = 'material';
    cfg.glassCapable = false;
    cfg.isTablet = true;
    cfg.widthClass = 'compact';
    cfg.windowWidth = 699;

    const { container, rerender } = render(<TabLayout />);
    const tabsNavigator = container.querySelector('[data-tabs-material="true"]');

    expect(tabsNavigator).not.toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')).toBeNull();

    cfg.widthClass = 'regular';
    cfg.windowWidth = 1440;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };
    rerender(<TabLayout />);

    expect(container.querySelector('[data-tabs-material="true"]')).toBe(tabsNavigator);
    expect(container.querySelector('[data-tablet-sidebar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ipad-play-pane="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ipad-wall-column="true"]')).not.toBeNull();
    expect(cfg.materialScreens.map((screen) => screen.name)).toEqual([
      'home',
      'climbs',
      'record',
      'wall',
      'discover',
      'profile',
    ]);
  });

  it('suppresses the detail pane on the tightest regular portraits, keeping the list full width', () => {
    // iPad mini portrait (744): sidebar (96) + the pane's 320pt floor would leave the
    // browse list ~328pt — below the 400pt readable floor — so resolveDetailPaneSurface
    // drops the pane and the compact bottom-sheet PlayDrawer hosts the drawer instead.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 744;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-tablet-sidebar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ipad-play-pane="true"]')).toBeNull();
    // No room for a wall column at this width either — the wall stays the sidebar cell.
    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
  });

  it('shows the dedicated wall column in landscape with a bound board, hiding the rail cell', () => {
    // Wide enough for sidebar + browse list + detail pane + wall column (1366), and
    // a board is bound — so the wall graduates to its own column and the ambient
    // sidebar cell steps aside (one wall surface per layout).
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1366;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-wall-column="true"]')).not.toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('false');
    // The detail pane mounts alongside the list and the dedicated wall column — the
    // pixel widths of each are covered by size-class.test.ts (resolveDetailPaneWidth,
    // WALL_COLUMN_WIDTH), so assert the surfaces are present, not their arithmetic.
    expect(container.querySelector('[data-ipad-play-pane="true"]')).not.toBeNull();
  });

  it('shows the dedicated wall column on a landscape Android tablet with a bound board', () => {
    // The chosen v1 scope: a wide Android tablet is panel-capable (no dp floor), so
    // the wall graduates to its own column beside the browse list + detail pane —
    // exactly the wall-mounted-gym-tablet scenario, in Material dress.
    cfg.platformOS = 'android';
    cfg.variant = 'material';
    cfg.glassCapable = false;
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1280;
    cfg.wallDeviceClass = 'panel-capable';
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };

    const { container } = render(<TabLayout />);

    // `data-ipad-*` markers keep the shared components' names: IpadPlayPane /
    // IpadWallColumn are variant-agnostic and render on Android too (only the glass
    // IpadSidebar is iOS-specific, swapped for the rail via TabletSidebar).
    expect(container.querySelector('[data-ipad-wall-column="true"]')).not.toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ipad-play-pane="true"]')).not.toBeNull();
  });

  it('collapses the wall column to the sheet on a small (sheet-only) iPad, even in landscape', () => {
    // iPad mini / base 11" / Air 11": physically below the 11" Pro, so the wall panel
    // is dropped even though the window is wide enough for a column — the wall reaches
    // the user via the BoardSheet peek + the "On the Wall" tab instead, like the phone.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1366;
    cfg.wallDeviceClass = 'sheet-only';
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    // No rich wall surface on this device → the ambient sidebar cell stays the launcher.
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('true');
  });

  it('hides the wall column while the "On the Wall" tab is the focused destination', () => {
    // Panel-capable landscape with a bound board would show the column, but on the
    // wall tab the same feed is already the content pane — so the ambient column
    // steps aside (no two live copies of the feed).
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1366;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };
    cfg.segments = ['(tabs)', 'wall'];

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    // The kiosk IS the wall surface on this tab, so the persistent detail pane also
    // steps aside — it would otherwise squeeze the kiosk into a narrow left column.
    expect(container.querySelector('[data-ipad-play-pane="true"]')).toBeNull();
    // The surface still EXISTS for this layout, so the sidebar cell stays hidden — it
    // doesn't pop back in merely because the wall tab is open.
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('false');
    // Kiosk stays lit while the wall tab is focused.
    expect(keepAwake.activate).toHaveBeenCalledWith('wall');
  });

  it('gives the hold-outline editor the whole content area, keeping only the sidebar', () => {
    // The editor is a drawing canvas, so both trailing panes step aside — not for
    // redundancy like the wall tab, but because every point of width is working
    // space to zoom a hold into. The sidebar stays: this is a wider canvas, not a
    // modal, and you still need to navigate away from it.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1366;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };
    cfg.segments = ['(tabs)', 'profile', 'outline-canvas'];

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-play-pane="true"]')).toBeNull();
    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')).not.toBeNull();
  });

  it('keeps both trailing panes on the profile tab itself', () => {
    // The suppression is scoped to the canvas route, not the whole profile stack —
    // browsing Settings beside the play pane is the normal shell.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1366;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };
    cfg.segments = ['(tabs)', 'profile'];

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-play-pane="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ipad-wall-column="true"]')).not.toBeNull();
  });

  it('does not hold the wall keep-awake lock off the "On the Wall" tab', () => {
    cfg.segments = ['(tabs)', 'home'];

    render(<TabLayout />);

    expect(keepAwake.activate).not.toHaveBeenCalled();
    expect(keepAwake.deactivate).toHaveBeenCalledWith('wall');
  });

  it('hides the sidebar wall cell when the portrait play-pane strip owns the wall surface', () => {
    // 13" portrait has room for the play pane but not the dedicated wall column.
    // The wall therefore renders as the strip inside IpadPlayPane, so the sidebar
    // cell steps aside just like it does for the landscape wall column.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1032;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-play-pane="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('false');
  });

  it('keeps the sidebar wall cell when tight regular width suppresses the play pane', () => {
    // iPad mini portrait has no play pane, so there is no strip host either. The
    // sidebar cell remains the only wall affordance in that regular-width shell.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 744;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = { uuid: 'board-1' };

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-play-pane="true"]')).toBeNull();
    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('true');
  });

  it('keeps the sidebar wall cell in portrait while the active board config is unresolved', () => {
    // Presence can be bound from BLE before the active board query resolves. The
    // strip cannot render a useful wall surface yet, so the sidebar cell remains.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1032;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = null;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-play-pane="true"]')).not.toBeNull();
    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('true');
  });

  it('keeps the wall as the sidebar cell (no column) when no board is bound', () => {
    // Landscape width, but presence has no bound board — an empty column would be
    // dead space, so the wall stays the ambient sidebar cell.
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1366;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = null;
    cfg.activeBoard = { uuid: 'board-1' };

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('true');
  });

  it('does not reserve a wall column when a board is BLE-bound but no active board is resolved', () => {
    // boardId can be set from the BLE serial before/without an active board; the
    // column renders its content from the active board config, so without one the
    // layout must NOT reserve the 300pt column (it would be dead space).
    cfg.widthClass = 'regular';
    cfg.windowWidth = 1366;
    cfg.boardPresenceEnabled = true;
    cfg.boardPresenceBoardId = 1;
    cfg.activeBoard = null;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-ipad-wall-column="true"]')).toBeNull();
    expect(container.querySelector('[data-tablet-sidebar="true"]')?.getAttribute('data-show-wall-cell')).toBe('true');
  });

  it('does not render the Record badge when no status is active', () => {
    const { container } = render(<TabLayout />);
    const recordTrigger = container.querySelector('[data-trigger="record"]') as HTMLElement;

    expect(recordTrigger.querySelector('[data-badge="true"]')).toBeNull();
  });

  it('keeps native tab minimization enabled globally', () => {
    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-tabs="true"]')?.getAttribute('data-minimize-behavior')).toBe('onScrollDown');
  });

  it('uses adaptive neutral colors for native Liquid Glass tab icons and labels', () => {
    const { container } = render(<TabLayout />);
    const tabs = container.querySelector('[data-tabs="true"]');

    expect(tabs?.getAttribute('data-icon-color')).toBe(JSON.stringify({ default: '#A9A2B6', selected: '#F5F2FB' }));
    expect(tabs?.getAttribute('data-label-style')).toBe(
      JSON.stringify({ default: { color: '#A9A2B6' }, selected: { color: '#F5F2FB' } }),
    );
    expect(tabs?.getAttribute('data-tint-color')).toBe('#F5F2FB');
  });

  it('mounts the native bottom accessory when active and a climb is current', () => {
    cfg.hasCurrentClimb = true;
    const { container } = render(<TabLayout />);

    const accessorySlot = container.querySelector('[data-bottom-accessory="true"]');
    expect(accessorySlot).not.toBeNull();
    expect(accessorySlot?.querySelector('[data-accessory="true"]')).not.toBeNull();
  });

  it('skips the native bottom accessory when that path is inactive', () => {
    cfg.nativeAccessoryActive = false;
    cfg.hasCurrentClimb = true;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-bottom-accessory="true"]')).toBeNull();
  });

  it('skips the empty native bottom accessory when no climb is current', () => {
    cfg.nativeAccessoryActive = true;
    cfg.hasCurrentClimb = false;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-bottom-accessory="true"]')).toBeNull();
  });

  it('skips the native bottom accessory off a top-level tab (pushed sub-route or modal)', () => {
    // Pushing a sub-route (session detail) or a root modal takes the bar off a
    // top-level tab. Unmount the accessory host there so UIKit doesn't keep a stale
    // glass-platter snapshot that re-presents doubled on return.
    cfg.nativeAccessoryActive = true;
    cfg.hasCurrentClimb = true;
    cfg.onAccessorySurface = false;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-bottom-accessory="true"]')).toBeNull();
  });

  it('keeps the Record tab lazy outside Android builds', () => {
    cfg.variant = 'material';

    render(<TabLayout />);

    expect(cfg.materialScreens.find((screen) => screen.name === 'record')?.options?.lazy).not.toBe(false);
  });

  it('eager-mounts the Record tab on Android builds', () => {
    cfg.variant = 'material';
    cfg.platformOS = 'android';

    render(<TabLayout />);

    expect(cfg.materialScreens.find((screen) => screen.name === 'record')?.options).toMatchObject({ lazy: false });
  });

  // The JS-Tabs badge value is a state marker MaterialTabBar branches its dot
  // color on — assert the shared constants (tab-badge) so producer and consumer
  // can't drift apart, and pin the wire values so a rename stays deliberate.
  it('sets the JS-Tabs Record badge to the live marker when a session is active', () => {
    cfg.variant = 'material';
    cfg.sessionId = 'session-1';

    render(<TabLayout />);

    expect(TAB_BADGE_LIVE).toBe('live');
    expect(cfg.materialScreens.find((screen) => screen.name === 'record')?.options).toMatchObject({
      tabBarBadge: TAB_BADGE_LIVE,
    });
  });

  it('sets the JS-Tabs Record badge to the connected marker when only Bluetooth is connected', () => {
    cfg.variant = 'material';
    cfg.bluetoothConnected = true;

    render(<TabLayout />);

    expect(TAB_BADGE_CONNECTED).toBe('connected');
    expect(cfg.materialScreens.find((screen) => screen.name === 'record')?.options).toMatchObject({
      tabBarBadge: TAB_BADGE_CONNECTED,
    });
  });

  // #3153: Android/iPad keep blurred tabs' native trees resident (detach off) so a
  // switch is a re-attach, not a Fabric rebuild; iOS < 26 iPhones stay on default
  // detach where freezeOnBlur actually takes effect.
  it('keeps Android tabs resident with freeze declared (#3153)', () => {
    cfg.variant = 'material';
    cfg.platformOS = 'android';

    const { container } = render(<TabLayout />);
    const materialNav = container.querySelector('[data-tabs-material="true"]');

    expect(materialNav?.getAttribute('data-detach-inactive-screens')).toBe('false');
    expect(materialNav?.getAttribute('data-freeze-on-blur')).toBe('true');
  });

  it('leaves iOS < 26 iPhones on default detach with freeze active (#3153)', () => {
    cfg.variant = 'liquidGlass';
    cfg.glassCapable = false;
    cfg.platformOS = 'ios';

    const { container } = render(<TabLayout />);
    const materialNav = container.querySelector('[data-tabs-material="true"]');

    expect(materialNav?.getAttribute('data-detach-inactive-screens')).toBe('unset');
    expect(materialNav?.getAttribute('data-freeze-on-blur')).toBe('true');
  });

  it('keeps iPad shell tabs resident (#3153)', () => {
    cfg.widthClass = 'regular';

    const { container } = render(<TabLayout />);
    const materialNav = container.querySelector('[data-tabs-material="true"]');

    expect(materialNav?.getAttribute('data-detach-inactive-screens')).toBe('false');
    expect(materialNav?.getAttribute('data-freeze-on-blur')).toBe('true');
  });

  it('keeps residency props off the iOS 26 NativeTabs path (#3153)', () => {
    cfg.variant = 'liquidGlass';
    cfg.glassCapable = true;
    cfg.platformOS = 'ios';

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-tabs="true"]')).not.toBeNull();
    expect(container.querySelector('[data-tabs-material="true"]')).toBeNull();
  });

  it('renders the Record badge when a session is active, in the live color', () => {
    cfg.sessionId = 'session-1';
    const { container } = render(<TabLayout />);
    const recordTrigger = container.querySelector('[data-trigger="record"]') as HTMLElement;
    const badge = recordTrigger.querySelector('[data-badge="true"]');

    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-selected-background-color')).toBe('#FBBF24');
  });

  it('renders the Record badge when Bluetooth is connected, in the standard (success) color', () => {
    cfg.bluetoothConnected = true;
    const { container } = render(<TabLayout />);
    const recordTrigger = container.querySelector('[data-trigger="record"]') as HTMLElement;
    const badge = recordTrigger.querySelector('[data-badge="true"]');

    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-selected-background-color')).toBe('#047857');
  });

  it('shows the live badge color when both Bluetooth is connected and a session is active — live takes priority', () => {
    cfg.bluetoothConnected = true;
    cfg.sessionId = 'session-1';
    const { container } = render(<TabLayout />);
    const recordTrigger = container.querySelector('[data-trigger="record"]') as HTMLElement;
    const badge = recordTrigger.querySelector('[data-badge="true"]');

    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-selected-background-color')).toBe('#FBBF24');
  });

  // `NativeTabs.Trigger.Badge`'s `selectedBackgroundColor` only reaches
  // options.selectedBadgeBackgroundColor, which expo-router applies solely to the
  // ['selected','focused'] item states — so it's a no-op for the badge tint while
  // Record is NOT the focused tab (the exact moment a live-session badge needs to
  // be visible from another tab). The normal-state tint must ride the
  // navigator-level `badgeBackgroundColor` prop instead.
  it('sets the navigator-level badgeBackgroundColor to the live color so the unfocused badge tint is correct', () => {
    cfg.sessionId = 'session-1';
    const { container } = render(<TabLayout />);
    const tabs = container.querySelector('[data-tabs="true"]');

    expect(tabs?.getAttribute('data-badge-background-color')).toBe('#FBBF24');
  });

  it('sets the navigator-level badgeBackgroundColor to the standard (success) color when only Bluetooth is connected', () => {
    cfg.bluetoothConnected = true;
    const { container } = render(<TabLayout />);
    const tabs = container.querySelector('[data-tabs="true"]');

    expect(tabs?.getAttribute('data-badge-background-color')).toBe('#047857');
  });

  // `badgeBackgroundColor` above is a navigator-wide DEFAULT: it tints every
  // trigger's badge. That's only correct while Record owns the sole badge, so lock
  // the invariant here — a second badged trigger would silently inherit Record's
  // session color, and this failing test is the signal to move the color onto
  // per-trigger styling instead.
  it('keeps Record as the only badged trigger (the navigator badge color is a shared default)', () => {
    cfg.bluetoothConnected = true;
    cfg.sessionId = 'session-1';
    const { container } = render(<TabLayout />);
    const badges = container.querySelectorAll('[data-badge="true"]');

    expect(badges).toHaveLength(1);
    expect(badges[0].closest('[data-trigger]')?.getAttribute('data-trigger')).toBe('record');
  });
});
