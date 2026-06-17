// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({
  bluetoothConnected: false,
  sessionId: null as string | null,
  nativeAccessoryActive: true,
  hasCurrentClimb: false,
  // Whether the focused route is inside the (tabs) group. The native bottom
  // accessory only mounts on-tabs; a root-level push (session detail) or modal
  // takes the tab bar off screen, so the host unmounts there.
  insideTabs: true,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  // Whether the device can render real iOS 26 glass chrome. The native tab bar
  // mounts only for the Liquid Glass variant on a capable device; everything else
  // (Material, plus Liquid Glass on iOS < 26 / Android) takes the JS tab bar.
  glassCapable: true,
  platformOS: 'ios' as 'ios' | 'android',
  materialScreens: [] as Array<{ name: string; options?: { lazy?: boolean } }>,
  accessoryDismissed: false,
}));

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return cfg.platformOS;
    },
  },
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

// Route gate on the accessory mount: false once a root push/modal slides the tab
// bar (and its accessory) off screen. Driven by useSegments() + isTabsRoute in the
// real hook; the route-segment split is unit-tested in route-segments.test.
vi.mock('../../../src/hooks/use-inside-tabs', () => ({
  useInsideTabs: () => cfg.insideTabs,
}));

// User-dismissed (and not actively climbing): the native accessory host unmounts.
vi.mock('../../../src/hooks/use-accessory-dismissed', () => ({
  useAccessoryDismissed: () => cfg.accessoryDismissed,
}));

vi.mock('../../../src/components/queue-control/QueueBottomAccessory', () => ({
  QueueBottomAccessory: () => createElement('div', { 'data-accessory': 'true' }),
}));

vi.mock('../../../src/theme/colors', () => ({
  brandColors: { success: '#047857' },
}));

vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({
    variant: cfg.variant,
    systemColors: {
      label: '#F5F2FB',
      secondaryLabel: '#A9A2B6',
    },
  }),
}));

vi.mock('../../../src/hooks/use-bottom-accessory', () => ({
  useNativeAccessoryActive: () => cfg.nativeAccessoryActive,
  useNativeTabBar: () => cfg.variant === 'liquidGlass' && cfg.glassCapable,
}));

// Stub the Material-variant path so it doesn't pull in native modules.
vi.mock('expo-router', () => {
  const Tabs = Object.assign(
    ({ children }: { children?: ReactNode }) => createElement('nav', { 'data-tabs-material': 'true' }, children),
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

  return { Tabs };
});

vi.mock('../../../src/components/navigation/MaterialTabBar', () => ({
  MaterialTabBar: () => createElement('nav', { 'data-material-tab-bar': 'true' }),
}));

vi.mock('@expo/vector-icons/MaterialCommunityIcons', () => ({
  default: () => createElement('span', { 'data-icon': 'mci' }),
}));

vi.mock('expo-router/unstable-native-tabs', () => {
  const Trigger = Object.assign(
    ({ name, children }: { name: string; children?: ReactNode }) =>
      createElement('section', { 'data-trigger': name }, children),
    {
      Icon: () => createElement('span', { 'data-icon': 'true' }),
      Label: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
      Badge: ({ children }: { children?: ReactNode }) => createElement('span', { 'data-badge': 'true' }, children),
    },
  );

  const NativeTabs = Object.assign(
    ({
      children,
      minimizeBehavior,
      iconColor,
      labelStyle,
      tintColor,
    }: {
      children?: ReactNode;
      minimizeBehavior?: string;
      iconColor?: unknown;
      labelStyle?: unknown;
      tintColor?: unknown;
    }) =>
      createElement(
        'nav',
        {
          'data-tabs': 'true',
          'data-minimize-behavior': minimizeBehavior ?? '',
          'data-icon-color': JSON.stringify(iconColor),
          'data-label-style': JSON.stringify(labelStyle),
          'data-tint-color': typeof tintColor === 'string' ? tintColor : '',
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

describe('TabLayout', () => {
  beforeEach(() => {
    cfg.bluetoothConnected = false;
    cfg.sessionId = null;
    cfg.nativeAccessoryActive = true;
    cfg.hasCurrentClimb = false;
    cfg.insideTabs = true;
    cfg.variant = 'liquidGlass';
    cfg.glassCapable = true;
    cfg.platformOS = 'ios';
    cfg.materialScreens = [];
    cfg.accessoryDismissed = false;
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
      'discover',
      'profile',
    ]);
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

  it('skips the native bottom accessory when the user has tucked the bar away', () => {
    cfg.nativeAccessoryActive = true;
    cfg.hasCurrentClimb = true;
    cfg.accessoryDismissed = true;

    const { container } = render(<TabLayout />);

    expect(container.querySelector('[data-bottom-accessory="true"]')).toBeNull();
  });

  it('skips the native bottom accessory when outside the tabs group', () => {
    // A root push (session detail) or modal slides the tab bar off screen. Unmount
    // the accessory host there so UIKit doesn't keep a stale glass-platter snapshot
    // that re-presents doubled on return.
    cfg.nativeAccessoryActive = true;
    cfg.hasCurrentClimb = true;
    cfg.insideTabs = false;

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

  it('renders the Record badge when a session is active', () => {
    cfg.sessionId = 'session-1';
    const { container } = render(<TabLayout />);
    const recordTrigger = container.querySelector('[data-trigger="record"]') as HTMLElement;

    expect(recordTrigger.querySelector('[data-badge="true"]')).not.toBeNull();
  });

  it('renders the Record badge when Bluetooth is connected', () => {
    cfg.bluetoothConnected = true;
    const { container } = render(<TabLayout />);
    const recordTrigger = container.querySelector('[data-trigger="record"]') as HTMLElement;

    expect(recordTrigger.querySelector('[data-badge="true"]')).not.toBeNull();
  });
});
