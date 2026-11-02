// @vitest-environment jsdom
// Put on board's keep-lighting window on the wall button (2.7, spec B2): the
// clock ticks on its own, steps the screen-reader value every 10 s, ends with
// auto-disconnect when that comes first, and the words for it.
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
vi.mock('react-native', () => ({
  I18nManager: { isRTL: false },
  StyleSheet: {
    create: (styles: Record<string, unknown>) => styles,
    absoluteFillObject: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  },
  View: ({ testID, children }: { testID?: string; children?: ReactNode }) =>
    createElement('div', { 'data-testid': testID }, children),
}));
// Each `withTiming` the drain asks for: where to, and over how long.
const timings = vi.hoisted(() => [] as { to: number; duration: number | undefined }[]);
vi.mock('react-native-reanimated', async () => {
  const { useRef } = await import('react');
  return {
    default: { View: ({ children }: { children?: ReactNode }) => createElement('div', null, children) },
    cancelAnimation: vi.fn(),
    Easing: { linear: (value: number) => value },
    useAnimatedStyle: (build: () => unknown) => build(),
    // Stable across renders, as Reanimated's own is.
    useSharedValue: (value: number) => useRef({ value }).current,
    withSequence: (...steps: number[]) => steps[steps.length - 1],
    withTiming: (to: number, config?: { duration?: number }) => {
      timings.push({ to, duration: config?.duration });
      return to;
    },
  };
});
vi.mock('../../Text', () => ({
  Text: ({ children, testID }: { children?: ReactNode; testID?: string }) =>
    createElement('span', { 'data-testid': testID }, children),
}));
vi.mock('../../../theme/colors', () => ({ withAlpha: (color: string) => color }));
vi.mock('../../../theme/typography', () => ({ CHROME_LABEL_MAX_FONT_SCALE: 1.2 }));

import { registerAutoDisconnectDeadlineReader } from '../../../lib/auto-disconnect-deadline';
import {
  enterDriveMode,
  makeDriveOpenEnded,
  markDriveLive,
  noteDriveClimbLit,
  resetDriveModeForTests,
} from '../drive-mode-store';
import { useWindowDrain, useWindowSecondsLeft, WallWindowBar, WallWindowDigits } from '../WallWindowClock';
import { formatWindowClock, windowSecondsLeft, windowStartedAnnouncement, windowTimeValue } from '../wall-control-text';

const t = ((key: string, values?: Record<string, unknown>) =>
  values ? `${key} ${JSON.stringify(values)}` : key) as unknown as TFunction;

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
  timings.length = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetDriveModeForTests();
  registerAutoDisconnectDeadlineReader(() => null)();
});

describe('the window clock words', () => {
  it('reads m:ss, rounded up, so 0:01 shows until the window is over', () => {
    expect(formatWindowClock(45_000)).toBe('0:45');
    expect(formatWindowClock(37_200)).toBe('0:38');
    expect(formatWindowClock(60_000)).toBe('1:00');
    expect(formatWindowClock(1)).toBe('0:01');
    expect(formatWindowClock(0)).toBe('0:00');
    expect(formatWindowClock(-5_000)).toBe('0:00');
    expect(windowSecondsLeft(-1)).toBe(0);
  });

  it('says the time left on a 10 s step, never more than is left, then under ten', () => {
    expect(windowTimeValue(45_000, t)).toBe('playView.wallControl.secondsLeft {"count":40}');
    expect(windowTimeValue(39_100, t)).toBe('playView.wallControl.secondsLeft {"count":30}');
    expect(windowTimeValue(10_000, t)).toBe('playView.wallControl.secondsLeft {"count":10}');
    expect(windowTimeValue(9_500, t)).toBe('playView.wallControl.underTenSeconds');
  });

  it('opens with the length and the way to keep lighting, a minute in minutes', () => {
    expect(windowStartedAnnouncement(45_000, t)).toBe('playView.wallControl.windowStarted {"count":45}');
    expect(windowStartedAnnouncement(30_000, t)).toBe('playView.wallControl.windowStarted {"count":30}');
    expect(windowStartedAnnouncement(60_000, t)).toBe('playView.wallControl.windowStartedMinute');
  });
});

describe('useWindowSecondsLeft', () => {
  it('is null outside a live window: nobody driving, arming, or open-ended', () => {
    const clock = renderHook(() => useWindowSecondsLeft(1));
    expect(clock.result.current).toBeNull();
    act(() => {
      enterDriveMode({ startedBy: 'tap', sessionId: null, boardId: null, windowMs: 45_000 });
    });
    expect(clock.result.current).toBeNull();
    act(() => markDriveLive());
    expect(clock.result.current).toEqual({ secondsLeft: 45, totalMs: 45_000 });
    act(() => {
      makeDriveOpenEnded();
    });
    expect(clock.result.current).toBeNull();
  });

  it('ticks once a second, and refills when a climb lights', () => {
    const clock = renderHook(() => useWindowSecondsLeft(1));
    openWindow();
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    expect(clock.result.current?.secondsLeft).toBe(38);
    act(() => noteDriveClimbLit());
    act(() => noteDriveClimbLit());
    expect(clock.result.current?.secondsLeft).toBe(45);
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(clock.result.current?.secondsLeft).toBe(0);
  });

  it('steps the value every 10 s and re-renders only when it changes', () => {
    let renders = 0;
    const value = renderHook(() => {
      renders += 1;
      return useWindowSecondsLeft(10);
    });
    openWindow();
    expect(value.result.current?.secondsLeft).toBe(40);
    const before = renders;
    act(() => {
      vi.advanceTimersByTime(4_000);
    });
    expect(value.result.current?.secondsLeft).toBe(40);
    expect(renders).toBe(before);
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(value.result.current?.secondsLeft).toBe(30);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(value.result.current?.secondsLeft).toBe(0);
  });

  it('ends with auto-disconnect when that comes first', () => {
    registerAutoDisconnectDeadlineReader(() => 100_000 + 20_000);
    const clock = renderHook(() => useWindowSecondsLeft(1));
    openWindow();
    expect(clock.result.current?.secondsLeft).toBe(20);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(clock.result.current?.secondsLeft).toBe(15);
  });
});

describe('useWindowDrain', () => {
  /** The drains to empty asked for so far, as [from, over how long]. */
  const drains = () =>
    timings.flatMap((step, index) =>
      step.to === 0 && index > 0 ? [[timings[index - 1].to, step.duration] as const] : [],
    );

  it('drains to the shown end, and re-aims when auto-disconnect moves it under the window', () => {
    let deadline: number | null = 100_000 + 30_000;
    registerAutoDisconnectDeadlineReader(() => deadline);
    renderHook(() => useWindowDrain(false));
    openWindow();
    // 45 s window, auto-disconnect at 30 s: empty at 30 s.
    expect(drains()).toEqual([[30_000 / 45_000, 30_000 - 250]]);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(drains()).toHaveLength(1);
    // A hold on the wall button pushes auto-disconnect past the window's own end.
    deadline = 120_000 + 30_000;
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(drains()).toEqual([
      [30_000 / 45_000, 30_000 - 250],
      [24_000 / 45_000, 24_000 - 250],
    ]);
    // Nothing moved since: no new drain.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(drains()).toHaveLength(2);
  });

  // The player opening on a running window, or the bar coming back after a
  // drag: it starts where the window stands, with no refill from full, which
  // would read as a climb lighting.
  it('mounted mid-window, starts where the window stands and refills only on a renewal', () => {
    openWindow();
    act(() => {
      vi.advanceTimersByTime(33_000);
    });
    let firstFrame: number | null = null;
    renderHook(() => {
      const drain = useWindowDrain(false);
      firstFrame ??= drain.fraction.value;
      return drain;
    });
    expect(firstFrame).toBeCloseTo(12_000 / 45_000);
    expect(timings.slice(0, 2)).toEqual([
      { to: 12_000 / 45_000, duration: 0 },
      { to: 0, duration: 12_000 },
    ]);
    timings.length = 0;
    act(() => noteDriveClimbLit());
    expect(timings.slice(0, 2)).toEqual([
      { to: 1, duration: 250 },
      { to: 0, duration: 45_000 - 250 },
    ]);
  });

  it('under Reduce Motion, draws its first frame where the window stands', () => {
    openWindow();
    act(() => {
      vi.advanceTimersByTime(33_000);
    });
    let firstFrame: number | null = null;
    renderHook(() => {
      const drain = useWindowDrain(true);
      firstFrame ??= drain.fraction.value;
      return drain;
    });
    expect(firstFrame).toBeCloseTo(12_000 / 45_000);
  });
});

describe('WallWindowDigits and WallWindowBar', () => {
  it('draw nothing outside a window', () => {
    const view = render(
      createElement('div', null, [
        createElement(WallWindowDigits, { key: 'digits', color: '#5B21B6' }),
        createElement(WallWindowBar, { key: 'bar', color: '#5B21B6', width: 360, reduceMotion: false }),
      ]),
    );
    expect(view.queryByTestId('play-drawer-wall-control-window-clock')).toBeNull();
    expect(view.queryByTestId('play-drawer-wall-control-window-bar')).toBeNull();
  });

  it('show the clock beside the words and the bar inside the pill', () => {
    openWindow();
    act(() => {
      vi.advanceTimersByTime(7_000);
    });
    const view = render(
      createElement('div', null, [
        createElement(WallWindowDigits, { key: 'digits', color: '#5B21B6' }),
        createElement(WallWindowBar, { key: 'bar', color: '#5B21B6', width: 360, reduceMotion: true }),
      ]),
    );
    expect(view.getByTestId('play-drawer-wall-control-window-clock').textContent).toBe('· 0:38');
    expect(view.queryByTestId('play-drawer-wall-control-window-bar')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(view.getByTestId('play-drawer-wall-control-window-clock').textContent).toBe('· 0:37');
  });

  it('draws no bar before the pill has a width', () => {
    openWindow();
    const view = render(createElement(WallWindowBar, { color: '#5B21B6', width: 0, reduceMotion: false }));
    expect(view.queryByTestId('play-drawer-wall-control-window-bar')).toBeNull();
  });
});
