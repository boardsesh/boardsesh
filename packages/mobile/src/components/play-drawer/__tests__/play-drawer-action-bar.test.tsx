// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';

// Minimal RN surface. Pressable exposes its a11y label + hitSlop so the angle
// pill's restored 44pt touch target is inspectable.
type PressMockProps = {
  children?: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  hitSlop?: number;
};
vi.mock('react-native', () => ({
  View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  Pressable: ({ children, onPress, accessibilityLabel, hitSlop }: PressMockProps) =>
    createElement(
      'button',
      { onClick: onPress, 'data-label': accessibilityLabel, 'data-hitslop': hitSlop == null ? '' : String(hitSlop) },
      children,
    ),
  StyleSheet: { create: (styles: Record<string, unknown>) => styles, hairlineWidth: 1 },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

// Icon → expose name + colour so the tick glyph's green (colour-on-glyph, not a
// fill) is assertable. Paths are relative to THIS test file (one level under the
// source in __tests__), so they carry an extra `../`.
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name?: string; color?: string }) =>
    createElement('span', { 'data-icon': name, 'data-color': color }),
}));
vi.mock('../../Text', () => ({
  Text: ({ children }: { children?: ReactNode }) => createElement('span', null, children),
}));
vi.mock('../../ble/BleLightbulbButton', () => ({
  BleLightbulbButton: ({
    accessibilityLabel,
    accessibilitySelected,
    longPressAccessibilityHint,
    onLongPress,
  }: {
    accessibilityLabel?: string;
    accessibilitySelected?: boolean;
    longPressAccessibilityHint?: string;
    onLongPress?: () => void;
  }) =>
    createElement('div', {
      'data-ble': 'true',
      'data-label': accessibilityLabel,
      'data-selected': accessibilitySelected == null ? undefined : String(accessibilitySelected),
      'data-long-press-hint': longPressAccessibilityHint,
      'data-long-press-enabled': onLongPress ? 'true' : 'false',
    }),
}));
// The holder pip self-reads board presence; stub it so the row renders without
// the presence provider. It renders nothing when the wall is free anyway.
vi.mock('../LightbulbHolderBadge', () => ({
  LightbulbHolderBadge: () => createElement('div', { 'data-lightbulb-holder-badge': 'true' }),
}));
vi.mock('../../drawer-action-bar/DrawerActionBar', () => ({
  SIZES: { lg: { dim: 48, icon: 28 }, sm: { dim: 44, icon: 22 } },
  ActionButton: ({ iconName }: { iconName?: string }) => createElement('div', { 'data-action': iconName }),
  drawerActionBarStyles: {
    container: {},
    rowPrimary: {},
    primarySlot: {},
    rowSecondary: {},
    spacer: {},
    actionButton: {},
    actionButtonPressed: {},
  },
}));
vi.mock('../../../theme/colors', () => ({ brandColors: { primary: '#6D28D9', success: '#047857' } }));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primary: '#6D28D9', success: '#047857' } }),
}));
vi.mock('../../../theme/ios-colors', () => ({
  iosSystemColors: { white: '#FFFFFF', systemGray: '#8E8E93', systemRed: '#FF3B30', separator: '#ccc' },
}));
vi.mock('../../../theme/layout', () => ({ glassSize: { mini: 32 } }));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

import { PlayDrawerActionBar } from '../PlayDrawerActionBar';

const baseProps = {
  canSwipePrevious: true,
  canSwipeNext: true,
  isMirrored: false,
  supportsMirroring: true,
  isFavorited: false,
  remainingQueueCount: 3,
  lightbulbActive: false,
  lightbulbConnected: false,
  ascentCount: 2,
  currentAngle: 40,
  onPrevClick: vi.fn(),
  onNextClick: vi.fn(),
  onMirror: vi.fn(),
  onToggleFavorite: vi.fn(),
  onLightbulb: vi.fn(),
  onOpenActions: vi.fn(),
  onOpenQueue: vi.fn(),
  onShare: vi.fn(),
  onTickPress: vi.fn(),
  onTickLongPress: vi.fn(),
  onOpenAngleSelector: vi.fn(),
};

describe('PlayDrawerActionBar', () => {
  it('renders the tick as a green glyph (colour on the icon, not a solid fill)', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    const tick = container.querySelector('[data-icon="tick.outline"]') as HTMLElement;

    expect(tick).toBeTruthy();
    expect(tick.getAttribute('data-color')).toBe('#047857');
    // The old solid-white-on-green tick is gone — no white tick glyph remains.
    expect(container.querySelector('[data-icon="tick.outline"][data-color="#FFFFFF"]')).toBeNull();
  });

  it('suppresses the lightbulb holder pip when the banner owns the driver face', () => {
    // Default: the pip shows on the lightbulb.
    const withPip = render(createElement(PlayDrawerActionBar, baseProps));
    expect(withPip.container.querySelector('[data-lightbulb-holder-badge="true"]')).toBeTruthy();

    // Banner up → showHolderBadge false → no second face in the drawer.
    const noPip = render(createElement(PlayDrawerActionBar, { ...baseProps, showHolderBadge: false }));
    expect(noPip.container.querySelector('[data-lightbulb-holder-badge="true"]')).toBeNull();
  });

  it('keeps the 32pt angle pill tappable at the 44pt floor via hit-slop', () => {
    const { container } = render(createElement(PlayDrawerActionBar, baseProps));
    const anglePill = container.querySelector('[data-label="mobile.angleSelector.title"]') as HTMLElement;

    expect(anglePill).toBeTruthy();
    expect(anglePill.textContent).toContain('40°');
    expect(Number(anglePill.getAttribute('data-hitslop'))).toBeGreaterThanOrEqual(6);
  });

  it('derives the lightbulb label + selected state from local BLE (lightbulbConnected), not the lit visual', () => {
    // Peer lit the wall (lightbulbActive true) but this phone is NOT connected:
    // the bulb is filled, yet tapping connects — so the a11y label/selected must
    // read "connect", not "turn off"/selected.
    const peerLit = render(
      createElement(PlayDrawerActionBar, { ...baseProps, lightbulbActive: true, lightbulbConnected: false }),
    );
    const peerBulb = peerLit.container.querySelector('[data-ble="true"]') as HTMLElement;
    expect(peerBulb.getAttribute('data-label')).toBe('ble.connectBoard');
    expect(peerBulb.getAttribute('data-selected')).toBe('false');

    // This phone connected → tapping disconnects → "turn off" + selected.
    const localConnected = render(
      createElement(PlayDrawerActionBar, { ...baseProps, lightbulbActive: true, lightbulbConnected: true }),
    );
    const localBulb = localConnected.container.querySelector('[data-ble="true"]') as HTMLElement;
    expect(localBulb.getAttribute('data-label')).toBe('ble.turnOff');
    expect(localBulb.getAttribute('data-selected')).toBe('true');
  });

  it('passes party wall-control labels through to the lightbulb', () => {
    const { container } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        lightbulbActive: true,
        lightbulbAccessibilityLabel: 'Release wall control',
        lightbulbLongPressAccessibilityHint: 'Hold for Bluetooth controls',
      }),
    );
    const lightbulb = container.querySelector('[data-ble="true"]') as HTMLElement;

    expect(lightbulb.getAttribute('data-label')).toBe('Release wall control');
    expect(lightbulb.getAttribute('data-long-press-hint')).toBe('Hold for Bluetooth controls');
  });

  it('gates lightbulb long-press controls separately from the active state', () => {
    const { container, rerender } = render(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        lightbulbActive: true,
        lightbulbLongPressEnabled: false,
        lightbulbAccessibilityLabel: 'Release wall control',
      }),
    );
    const inactiveLongPressBulb = container.querySelector('[data-ble="true"]') as HTMLElement;

    expect(inactiveLongPressBulb.getAttribute('data-long-press-enabled')).toBe('false');
    expect(inactiveLongPressBulb.getAttribute('data-long-press-hint')).toBeNull();

    rerender(
      createElement(PlayDrawerActionBar, {
        ...baseProps,
        lightbulbActive: false,
        lightbulbLongPressEnabled: true,
        lightbulbAccessibilityLabel: 'Take wall control',
        onLightbulbLongPress: vi.fn(),
      }),
    );
    const activeLongPressBulb = container.querySelector('[data-ble="true"]') as HTMLElement;

    expect(activeLongPressBulb.getAttribute('data-long-press-enabled')).toBe('true');
    expect(activeLongPressBulb.getAttribute('data-long-press-hint')).toBe('ble.holdForControls');
  });
});
