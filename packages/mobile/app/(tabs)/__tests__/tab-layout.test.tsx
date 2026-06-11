// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

const cfg = vi.hoisted(() => ({
  bluetoothConnected: false,
  sessionId: null as string | null,
  nativeAccessoryActive: true,
  hasCurrentClimb: false,
  variant: 'liquidGlass' as 'liquidGlass' | 'material',
  platformOS: 'ios' as 'ios' | 'android',
  materialScreens: [] as Array<{ name: string; options?: { lazy?: boolean; tabBarBadge?: unknown } }>,
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
  useHasActiveClimb: () => cfg.hasCurrentClimb,
}));

vi.mock('../../../src/components/queue-control/QueueBottomAccessory', () => ({
  QueueBottomAccessory: () => createElement('div', { 'data-accessory': 'true' }),
}));

vi.mock('../../../src/theme/colors', () => ({
  brandColors: { primaryFill: '#6D28D9', success: '#047857' },
}));

vi.mock('../../../src/providers/theme-provider', () => ({
  useTheme: () => ({ variant: cfg.variant }),
}));

vi.mock('../../../src/hooks/use-bottom-accessory', () => ({
  useNativeAccessoryActive: () => cfg.nativeAccessoryActive,
}));

// Stub the Material-variant path so it doesn't pull in native modules.
vi.mock('expo-router', () => {
  const Tabs = Object.assign(
    ({ children }: { children?: ReactNode }) => createElement('nav', { 'data-tabs-material': 'true' }, children),
    {
      Screen: ({ name, options }: { name: string; options?: { lazy?: boolean; tabBarBadge?: unknown } }) => {
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
      Badge: ({ children, selectedBackgroundColor }: { children?: ReactNode; selectedBackgroundColor?: string }) =>
        createElement('span', { 'data-badge': 'true', 'data-bg': selectedBackgroundColor ?? '' }, children),
    },
  );

  const NativeTabs = Object.assign(
    ({ children, minimizeBehavior }: { children?: ReactNode; minimizeBehavior?: string }) =>
      createElement('nav', { 'data-tabs': 'true', 'data-minimize-behavior': minimizeBehavior ?? '' }, children),
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
    cfg.variant = 'liquidGlass';
    cfg.platformOS = 'ios';
    cfg.materialScreens = [];
  });

  it('lands on the climbs tab by default', () => {
    expect(unstable_settings.initialRouteName).toBe('climbs');
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
    const badge = recordTrigger.querySelector('[data-badge="true"]');

    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-bg')).toBe('#6D28D9');
    expect(badge?.textContent).toBe('•');
  });

  it('renders the Record badge when Bluetooth is connected', () => {
    cfg.bluetoothConnected = true;
    const { container } = render(<TabLayout />);
    const recordTrigger = container.querySelector('[data-trigger="record"]') as HTMLElement;
    const badge = recordTrigger.querySelector('[data-badge="true"]');

    expect(badge).not.toBeNull();
    expect(badge?.getAttribute('data-bg')).toBe('#047857');
    expect(badge?.textContent).toBe(' ');
  });

  it('prefers the live-session Record badge when Bluetooth is also connected', () => {
    cfg.bluetoothConnected = true;
    cfg.sessionId = 'session-1';
    const { container } = render(<TabLayout />);
    const recordTrigger = container.querySelector('[data-trigger="record"]') as HTMLElement;
    const badge = recordTrigger.querySelector('[data-badge="true"]');

    expect(badge?.getAttribute('data-bg')).toBe('#6D28D9');
  });

  it('passes the session badge kind to the Material tab bar', () => {
    cfg.variant = 'material';
    cfg.sessionId = 'session-1';

    render(<TabLayout />);

    expect(cfg.materialScreens.find((screen) => screen.name === 'record')?.options?.tabBarBadge).toBe('session');
  });

  it('passes the bluetooth badge kind to the Material tab bar', () => {
    cfg.variant = 'material';
    cfg.bluetoothConnected = true;

    render(<TabLayout />);

    expect(cfg.materialScreens.find((screen) => screen.name === 'record')?.options?.tabBarBadge).toBe('bluetooth');
  });
});
