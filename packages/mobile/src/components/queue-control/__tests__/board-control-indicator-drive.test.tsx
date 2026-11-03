// @vitest-environment jsdom
// The MiniPlayer's bulb while this phone drives the wall, the Live Activity's
// pattern (owner decision 2026-11-02): Put on board's timed drive draws the
// amber bulb inside an amber ring that drains from the drive's end
// (`expiresAt`) and fills again on each lit climb; an open-ended drive is the
// amber disc; nobody driving, nothing extra. The drain runs on the UI thread,
// so the bar never re-renders on a tick, and steps every 5 s under Reduce
// Motion. The real ring and drain hook run here; Reanimated and SVG are stubs
// that record what they are asked for.
import { act, cleanup, render } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const signals = vi.hoisted(() => ({
  reduceMotion: false,
  board: {
    bluetooth: {} as object | null,
    localConnected: true,
    inAppBoardConnection: 'connectedByMe' as 'connectedByMe' | 'heldByPeer' | 'disconnected',
    ledless: false,
    holderDisplayName: null,
  },
  // Each `withTiming` the drain asks for, every shared value it made, and how
  // often the bulb's body and the ring's body rendered.
  timings: [] as { to: number; duration: number | undefined }[],
  sharedValues: [] as { value: number }[],
  iconRenders: 0,
  ringRenders: 0,
}));

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('../../../lib/analytics-wall-control', () => ({
  trackDriveModeStarted: vi.fn(),
  trackDriveModeEnded: vi.fn(),
  trackWallControlTapped: vi.fn(),
}));
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  I18nManager: { isRTL: false },
  StyleSheet: {
    flatten: (style: unknown) => Object.assign({}, ...[style].flat(10).filter(Boolean)),
    create: (styles: Record<string, unknown>) => styles,
  },
  View: ({ testID, children }: { testID?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID }, children),
}));
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: {
      View: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
      createAnimatedComponent:
        () =>
        ({ animatedProps, stroke }: { animatedProps?: { strokeDashoffset?: number }; stroke?: string }) =>
          createElement('i', { 'data-arc': stroke, 'data-offset': String(animatedProps?.strokeDashoffset) }),
    },
    cancelAnimation: vi.fn(),
    Easing: { linear: (value: number) => value },
    useAnimatedProps: (build: () => unknown) => build(),
    useAnimatedStyle: (build: () => unknown) => build(),
    // Stable across renders, as Reanimated's own is.
    useSharedValue: (value: number) => {
      const ref = useRef<{ value: number } | null>(null);
      if (ref.current === null) {
        ref.current = { value };
        signals.sharedValues.push(ref.current);
      }
      return ref.current;
    },
    withSequence: (...steps: number[]) => steps[steps.length - 1],
    withTiming: (to: number, config?: { duration?: number }) => {
      signals.timings.push({ to, duration: config?.duration });
      return to;
    },
  };
});
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => {
    signals.ringRenders += 1;
    return createElement('svg', null, children);
  },
  Circle: ({ stroke }: { stroke?: string }) => createElement('i', { 'data-track': stroke }),
}));
vi.mock('../../PressableSurface', () => ({
  PressableSurface: ({
    children,
    accessibilityLabel,
    accessibilityValue,
    style,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityValue?: { text?: string };
    style?: (state: { pressed: boolean }) => unknown;
  }) =>
    createElement(
      'button',
      {
        type: 'button',
        'aria-label': accessibilityLabel,
        'data-value': accessibilityValue?.text,
        'data-style': JSON.stringify(style?.({ pressed: false })),
      },
      children,
    ),
}));
vi.mock('../../Icon', () => ({
  Icon: ({ name, color }: { name: string; color?: string }) => {
    signals.iconRenders += 1;
    return createElement('span', { 'data-icon': name, 'data-color': color });
  },
}));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => signals.reduceMotion }));
vi.mock('../../../providers/theme-provider', () => ({
  useOptionalTheme: () => null,
  useTheme: () => ({
    systemColors: { secondaryLabel: '#8E8E93' },
    // The dark scheme's Velvet amber.
    brandColors: { warning: '#FBBF24', live: '#FBBF24', primary: '#A78BFA', onAccent: '#16111F', onPrimary: '#FFF' },
    colorScheme: 'dark',
  }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../providers/ble-control-sheet-provider', () => ({ useBleControlSheet: () => ({ open: vi.fn() }) }));
vi.mock('../use-accessory-climb-tap', () => ({ useAccessoryClimbTap: () => ({ openPlay: vi.fn() }) }));
vi.mock('../../ble/use-lightbulb-control', () => ({ useLightbulbControl: () => ({ onPress: vi.fn() }) }));
vi.mock('../../ble/use-board-connection-state', () => ({ useBoardConnectionState: () => signals.board }));
vi.mock('../../../hooks/use-differentiate-without-color', () => ({ useDifferentiateWithoutColor: () => 'off' }));
vi.mock('../../../lib/haptics', () => ({ hapticMedium: vi.fn() }));

import { BoardControlIndicator } from '../BoardControlIndicator';
import {
  enterDriveMode,
  makeDriveOpenEnded,
  markDriveLive,
  noteDriveClimbLit,
  resetDriveModeForTests,
} from '../../play-drawer/drive-mode-store';
import { WINDOW_FROST_REFILL_MS } from '../../play-drawer/WallWindowClock';

const SIZE = 44;
const RADIUS = (SIZE - 2) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function startDrive(windowMs: number | null = 45_000) {
  act(() => {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: null,
      windowMs,
      windowSetting: windowMs === null ? null : 'putOnBoardKeepsLighting',
    });
    markDriveLive();
  });
}

function renderBulb() {
  const view = render(createElement(BoardControlIndicator, { size: SIZE, enableLongPress: true }));
  const bulb = () => view.getByRole('button');
  return {
    ...view,
    bulb,
    ring: () => view.container.querySelector('[data-testid="wall-window-ring"]'),
    arc: () => view.container.querySelector('[data-arc]'),
    style: () => bulb().getAttribute('data-style') ?? '',
    value: () => bulb().getAttribute('data-value'),
  };
}

/** The drain's shared value: the only one the ring makes. */
const fraction = () => signals.sharedValues[signals.sharedValues.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  resetDriveModeForTests();
  signals.reduceMotion = false;
  signals.board = {
    bluetooth: {},
    localConnected: true,
    inAppBoardConnection: 'connectedByMe',
    ledless: false,
    holderDisplayName: null,
  };
  signals.timings.length = 0;
  signals.sharedValues.length = 0;
  signals.iconRenders = 0;
  signals.ringRenders = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetDriveModeForTests();
});

describe('BoardControlIndicator while this phone drives the wall', () => {
  it('draws nothing extra with nobody driving: the lit bulb and its halo, no value', () => {
    const view = renderBulb();
    expect(view.ring()).toBeNull();
    expect(view.container.querySelector('[data-testid="wall-drive-ring-whole"]')).toBeNull();
    expect(view.value()).toBeNull();
    expect(view.style()).toContain('"backgroundColor":"#FBBF2424"');
  });

  it("draws the amber bulb inside the timed drive's amber ring, full at the start, draining to its end", () => {
    startDrive();
    const view = renderBulb();
    expect(view.ring()).not.toBeNull();
    // The Live Activity's amber, with no track behind it.
    expect(view.arc()?.getAttribute('data-arc')).toBe('#FBBF24');
    expect(view.container.querySelector('[data-track]')).toBeNull();
    // Neither the amber disc (the arc would vanish into it) nor the halo (the
    // arc meets the bar itself, as on the Live Activity).
    expect(view.style()).not.toContain('backgroundColor');
    expect(view.container.querySelector('[data-icon]')?.getAttribute('data-color')).toBe('#FBBF24');
    expect(Number(view.arc()?.getAttribute('data-offset'))).toBe(0);
    // One linear run from full to nothing over the drive's 45 s, on the UI thread.
    expect(signals.timings).toEqual([
      { to: 1, duration: 0 },
      { to: 0, duration: 45_000 },
    ]);
    expect(view.value()).toBe('ble.barControl.drivingValue');
  });

  it('starts from the time left when the bar mounts mid-drive: the fraction comes from expiresAt', () => {
    startDrive();
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    const view = renderBulb();
    // 30 s of 45 left: two thirds of the ring, the rest drawn as the dash offset.
    expect(Number(view.arc()?.getAttribute('data-offset'))).toBeCloseTo(CIRCUMFERENCE / 3, 6);
    expect(signals.timings[0]?.to).toBeCloseTo(2 / 3, 6);
    expect(signals.timings[1]).toEqual({ to: 0, duration: 30_000 });
  });

  it('fills the ring again when a climb lights (expiresAt moves), then drains the whole drive', () => {
    startDrive();
    renderBulb();
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    signals.timings.length = 0;
    act(() => {
      noteDriveClimbLit();
      noteDriveClimbLit();
    });
    expect(signals.timings).toEqual([
      { to: 1, duration: WINDOW_FROST_REFILL_MS },
      { to: 0, duration: 45_000 - WINDOW_FROST_REFILL_MS },
    ]);
  });

  it('fills an open-ended drive with the amber disc and draws no ring', () => {
    startDrive();
    const view = renderBulb();
    act(() => {
      makeDriveOpenEnded();
    });
    expect(view.ring()).toBeNull();
    expect(view.container.querySelector('[data-testid="wall-drive-ring-whole"]')).toBeNull();
    expect(view.style()).toContain('"backgroundColor":"#FBBF24"');
    // Dark ink on the dark scheme's pale amber, as the wall button.
    expect(view.container.querySelector('[data-icon]')?.getAttribute('data-color')).toBe('#16111F');
    expect(view.value()).toBe('ble.barControl.drivingValue');
  });

  it('takes the ring and the value off when the drive ends', () => {
    startDrive();
    const view = renderBulb();
    expect(view.ring()).not.toBeNull();
    act(() => {
      resetDriveModeForTests();
    });
    expect(view.ring()).toBeNull();
    expect(view.value()).toBeNull();
  });

  it("draws no ring off this phone's lit link: arming, a crewmate's board, no lights, or a dropped link", () => {
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    const arming = renderBulb();
    expect(arming.ring()).toBeNull();
    expect(arming.value()).toBeNull();
    arming.unmount();
    act(() => {
      markDriveLive();
    });
    for (const board of [
      { inAppBoardConnection: 'heldByPeer' as const },
      // A wall with no lights, held with no link: nothing drives the LEDs.
      { ledless: true, localConnected: false },
      { localConnected: false },
    ]) {
      signals.board = { ...signals.board, inAppBoardConnection: 'connectedByMe', ledless: false, localConnected: true };
      signals.board = { ...signals.board, ...board };
      const view = renderBulb();
      expect(view.ring(), JSON.stringify(board)).toBeNull();
      expect(view.value(), JSON.stringify(board)).toBeNull();
      view.unmount();
    }
  });

  it('under Reduce Motion, steps the ring every 5 s from a timer, with no animation', () => {
    signals.reduceMotion = true;
    startDrive();
    renderBulb();
    expect(fraction()?.value).toBe(1);
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(fraction()?.value).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(fraction()?.value).toBeCloseTo(40 / 45, 6);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(fraction()?.value).toBeCloseTo(35 / 45, 6);
    expect(signals.timings).toEqual([]);
  });

  it.each([false, true])('re-renders neither the bulb nor its ring on a tick (Reduce Motion: %s)', (reduceMotion) => {
    signals.reduceMotion = reduceMotion;
    startDrive();
    renderBulb();
    const icons = signals.iconRenders;
    const rings = signals.ringRenders;
    for (let second = 0; second < 30; second += 1) {
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
    }
    expect(signals.iconRenders).toBe(icons);
    expect(signals.ringRenders).toBe(rings);
    // A lit climb renews the drive: only the ring hears it, the bulb does not.
    act(() => {
      noteDriveClimbLit();
      noteDriveClimbLit();
    });
    expect(signals.iconRenders).toBe(icons);
    expect(signals.ringRenders).toBeGreaterThan(rings);
  });
});
