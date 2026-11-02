// @vitest-environment jsdom
// Put on board's keep-lighting window on a bulb (2.7, spec B3): a draining
// amber arc round it (the Live Activity's ring, owner decision 2026-11-02), and
// the time left as the first row's bulb's value, only while a window is live.
// An open-ended drive's whole ring never drains.
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  StyleSheet: { create: (styles: Record<string, unknown>) => styles },
  View: ({ testID, children }: { testID?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID }, children),
}));
vi.mock('react-native-reanimated', () => ({
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
  useSharedValue: (value: number) => ({ value }),
  withSequence: (...steps: number[]) => steps[steps.length - 1],
  withTiming: (value: number) => value,
}));
vi.mock('react-native-svg', () => ({
  default: ({ children }: { children?: ReactNode }) => createElement('svg', null, children),
  Circle: ({ stroke }: { stroke?: string }) => createElement('i', { 'data-track': stroke }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key} ${JSON.stringify(values)}` : key),
  }),
}));
vi.mock('../../../providers/theme-provider', () => ({
  useTheme: () => ({ brandColors: { primaryStrong: '#5B21B6', warning: '#B45309' } }),
}));
vi.mock('../../../hooks/use-reduce-motion', () => ({ useReduceMotion: () => false }));
vi.mock('../../Text', () => ({ Text: () => null }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));

import { enterDriveMode, makeDriveOpenEnded, markDriveLive, resetDriveModeForTests } from '../drive-mode-store';
import { useWindowValueText, WallWindowRing } from '../WallWindowRing';

function openWindow(windowMs = 45_000) {
  act(() => {
    enterDriveMode({
      startedBy: 'tap',
      sessionId: null,
      boardId: null,
      windowMs,
      windowSetting: 'putOnBoardKeepsLighting',
    });
    markDriveLive();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  resetDriveModeForTests();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetDriveModeForTests();
});

describe('WallWindowRing', () => {
  it('draws nothing outside a live window: nobody driving, arming, or an open-ended drive', () => {
    const { container, rerender } = render(createElement(WallWindowRing, { size: 48 }));
    expect(container.querySelector('[data-testid="wall-window-ring"]')).toBeNull();
    act(() => {
      enterDriveMode({
        startedBy: 'tap',
        sessionId: null,
        boardId: null,
        windowMs: 45_000,
        windowSetting: 'putOnBoardKeepsLighting',
      });
    });
    rerender(createElement(WallWindowRing, { size: 48 }));
    expect(container.querySelector('[data-testid="wall-window-ring"]')).toBeNull();
    act(() => {
      markDriveLive();
      makeDriveOpenEnded();
    });
    expect(container.querySelector('[data-testid="wall-window-ring"]')).toBeNull();
  });

  it("draws the Live Activity's amber arc during a window, full at the window's start", () => {
    openWindow();
    const { container } = render(createElement(WallWindowRing, { size: 48 }));
    expect(container.querySelector('[data-testid="wall-window-ring"]')).not.toBeNull();
    // No track behind it: the arc meets the bar itself, the only ground where its amber clears 3:1.
    expect(container.querySelector('[data-track]')).toBeNull();
    const arc = container.querySelector('[data-arc]');
    expect(arc?.getAttribute('data-arc')).toBe('#B45309');
    // Drawn whole (no dash offset) before the UI thread starts draining it.
    expect(Number(arc?.getAttribute('data-offset'))).toBe(0);
  });
});

describe('WallWindowRing whole', () => {
  it('draws one full amber ring with no track and no arc, whatever the store says', () => {
    const { container } = render(createElement(WallWindowRing, { size: 44, kind: 'whole' }));
    expect(container.querySelector('[data-testid="wall-drive-ring-whole"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="wall-window-ring"]')).toBeNull();
    // The only circle is the static one, in the solid amber: nothing to drain.
    const circles = container.querySelectorAll('[data-track]');
    expect(circles).toHaveLength(1);
    expect(circles[0]?.getAttribute('data-track')).toBe('#B45309');
    expect(container.querySelector('[data-arc]')).toBeNull();
  });
});

describe('useWindowValueText', () => {
  it('is null outside a window, or for a bulb that is not in one', () => {
    expect(renderHook(() => useWindowValueText(true)).result.current).toBeNull();
    openWindow();
    expect(renderHook(() => useWindowValueText(false)).result.current).toBeNull();
  });

  it('says the window and its time for the Board lights bulb', () => {
    openWindow();
    expect(renderHook(() => useWindowValueText(true)).result.current).toBe(
      'playView.wallControl.youAreDriving, playView.wallControl.stopsInSeconds {"count":40}',
    );
  });
});
