// @vitest-environment jsdom
// Put on board's timed drive on the wall button (2.7, Stop driving after): the
// clock ticks on its own, steps the screen-reader value every 10 s, the frost
// shrinks toward the bulb on the UI thread (in 5 s steps under Reduce Motion),
// and the words for it.
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/analytics', () => ({ track: vi.fn() }));
const layoutDirection = vi.hoisted(() => ({ isRTL: false }));
vi.mock('react-native', () => ({
  I18nManager: layoutDirection,
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
    default: {
      View: ({ children, style, testID }: { children?: ReactNode; style?: unknown; testID?: string }) =>
        createElement('div', { 'data-testid': testID, 'data-style': JSON.stringify(style) }, children),
    },
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

import {
  enterDriveMode,
  makeDriveOpenEnded,
  markDriveLive,
  noteDriveClimbLit,
  resetDriveModeForTests,
} from '../drive-mode-store';
import {
  steppedWindowFraction,
  useWindowDrain,
  useWindowSecondsLeft,
  WallWindowDigits,
  WallWindowFrost,
  WINDOW_FROST_REFILL_MS,
} from '../WallWindowClock';
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
  layoutDirection.isRTL = false;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetDriveModeForTests();
});

describe('the timed drive clock words', () => {
  it('reads m:ss, rounded up, so 0:01 shows until the drive is over', () => {
    expect(formatWindowClock(45_000)).toBe('0:45');
    expect(formatWindowClock(37_200)).toBe('0:38');
    expect(formatWindowClock(60_000)).toBe('1:00');
    expect(formatWindowClock(300_000)).toBe('5:00');
    expect(formatWindowClock(119_001)).toBe('2:00');
    expect(formatWindowClock(1)).toBe('0:01');
    expect(formatWindowClock(0)).toBe('0:00');
    expect(formatWindowClock(-5_000)).toBe('0:00');
    expect(windowSecondsLeft(-1)).toBe(0);
  });

  it('says when it stops on a 10 s step, never more than is left, then under ten', () => {
    expect(windowTimeValue(45_000, t)).toBe('playView.wallControl.stopsInSeconds {"count":40}');
    expect(windowTimeValue(39_100, t)).toBe('playView.wallControl.stopsInSeconds {"count":30}');
    expect(windowTimeValue(10_000, t)).toBe('playView.wallControl.stopsInSeconds {"count":10}');
    expect(windowTimeValue(9_500, t)).toBe('playView.wallControl.stopsInUnderTen');
  });

  it('opens with the length and the way to keep going, whole minutes in minutes', () => {
    expect(windowStartedAnnouncement(45_000, t)).toBe('playView.wallControl.windowStarted {"count":45}');
    expect(windowStartedAnnouncement(30_000, t)).toBe('playView.wallControl.windowStarted {"count":30}');
    expect(windowStartedAnnouncement(60_000, t)).toBe('playView.wallControl.windowStartedMinute');
    expect(windowStartedAnnouncement(120_000, t)).toBe('playView.wallControl.windowStartedMinutes {"count":2}');
    expect(windowStartedAnnouncement(300_000, t)).toBe('playView.wallControl.windowStartedMinutes {"count":5}');
  });
});

describe('useWindowSecondsLeft', () => {
  it('is null outside a live timed drive: nobody driving, arming, or open-ended', () => {
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
});

describe('steppedWindowFraction', () => {
  it('rounds the time left up to the next 5 s step: full until the first 5 s pass, empty at the end', () => {
    expect(steppedWindowFraction(45_000, 45_000)).toBe(1);
    expect(steppedWindowFraction(40_001, 45_000)).toBe(1);
    expect(steppedWindowFraction(40_000, 45_000)).toBeCloseTo(40 / 45);
    expect(steppedWindowFraction(12_000, 45_000)).toBeCloseTo(15 / 45);
    expect(steppedWindowFraction(1, 45_000)).toBeCloseTo(5 / 45);
    expect(steppedWindowFraction(0, 45_000)).toBe(0);
    expect(steppedWindowFraction(-1_000, 45_000)).toBe(0);
  });
});

describe('useWindowDrain', () => {
  /** The drains to empty asked for so far, as [from, over how long]. */
  const drains = () =>
    timings.flatMap((step, index) =>
      step.to === 0 && index > 0 ? [[timings[index - 1].to, step.duration] as const] : [],
    );

  // The shrink runs on the UI thread: one timing to the end, nothing more from JS.
  it('drains once to the drive’s end, with no JS timer and no render after', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useWindowDrain(false);
    });
    openWindow();
    // A drive that starts is a renewal: full in 250 ms, then empty at its end.
    expect(drains()).toEqual([[1, 45_000 - WINDOW_FROST_REFILL_MS]]);
    const before = renders;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(drains()).toHaveLength(1);
    expect(renders).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The player opening on a running drive: it starts where the drive stands,
  // with no refill from full, which would read as a climb lighting.
  it('mounted mid-drive, starts where the drive stands and refills only on a renewal', () => {
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

  it('under Reduce Motion, shrinks in 5 s steps with no timing and no render, and jumps back on a renewal', () => {
    let renders = 0;
    const drain = renderHook(() => {
      renders += 1;
      return useWindowDrain(true);
    });
    openWindow();
    const fraction = () => drain.result.current.fraction.value;
    expect(fraction()).toBe(1);
    const before = renders;
    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(fraction()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(fraction()).toBeCloseTo(40 / 45);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(fraction()).toBeCloseTo(35 / 45);
    expect(renders).toBe(before);
    expect(timings).toEqual([]);
    act(() => noteDriveClimbLit());
    expect(fraction()).toBe(1);
    act(() => {
      vi.advanceTimersByTime(45_000);
    });
    expect(fraction()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  // Mounted mid-drive with 12 of 45 s left: 15/45 from the first frame on, so
  // the frost never grows back from 12/45 a frame later. The step timer then
  // holds it there until the 10 s step, two seconds on.
  it('under Reduce Motion, draws its first frame on the step where the drive stands, and holds it', () => {
    openWindow();
    act(() => {
      vi.advanceTimersByTime(33_000);
    });
    let firstFrame: number | null = null;
    const drain = renderHook(() => {
      const result = useWindowDrain(true);
      firstFrame ??= result.fraction.value;
      return result;
    });
    expect(firstFrame).toBeCloseTo(15 / 45);
    expect(drain.result.current.fraction.value).toBeCloseTo(15 / 45);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(drain.result.current.fraction.value).toBeCloseTo(15 / 45);
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(drain.result.current.fraction.value).toBeCloseTo(10 / 45);
    expect(timings).toEqual([]);
  });

  // The preview-first card's picture of a drive: whole while a real timed drive runs.
  it('is inactive where the view draws no timed drive, whatever the store says', () => {
    openWindow();
    const drain = renderHook(() => useWindowDrain(false, false));
    expect(drain.result.current.active).toBe(false);
    expect(drain.result.current.fraction.value).toBe(1);
    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(timings).toEqual([]);
    expect(drain.result.current.active).toBe(false);
  });

  it('is inactive outside a live timed drive', () => {
    const drain = renderHook(() => useWindowDrain(false));
    expect(drain.result.current.active).toBe(false);
    openWindow();
    expect(drain.result.current.active).toBe(true);
    act(() => {
      makeDriveOpenEnded();
    });
    expect(drain.result.current.active).toBe(false);
  });
});

describe('WallWindowDigits and WallWindowFrost', () => {
  const frostOf = (view: ReturnType<typeof render>) => {
    const clip = view.container.querySelector('[data-testid="play-drawer-wall-control-window-frost"]');
    return clip;
  };
  const translateOf = (element: Element | null | undefined): number | null => {
    const style = JSON.parse(element?.getAttribute('data-style') ?? 'null') as unknown;
    const parts = Array.isArray(style) ? style : [style];
    for (const part of parts) {
      if (part && typeof part === 'object' && 'transform' in part) {
        const [{ translateX }] = (part as { transform: { translateX: number }[] }).transform;
        return translateX;
      }
    }
    return null;
  };

  it('draw no clock outside a timed drive, and the whole frost', () => {
    const view = render(
      createElement('div', null, [
        createElement(WallWindowDigits, { key: 'digits', color: '#FFFFFF' }),
        createElement(WallWindowFrost, {
          key: 'frost',
          width: 360,
          reduceMotion: false,
          timed: true,
          children: createElement('b', { 'data-testid': 'glow' }),
        }),
      ]),
    );
    expect(view.queryByTestId('play-drawer-wall-control-window-clock')).toBeNull();
    // Inactive: no shrink frame, and the frost drawn in full.
    expect(frostOf(view)).toBeNull();
    expect(view.getByTestId('glow')).not.toBeNull();
  });

  it('show the clock beside the words, and shrink the frost toward the bulb', () => {
    openWindow();
    act(() => {
      vi.advanceTimersByTime(33_000);
    });
    const view = render(
      createElement('div', null, [
        createElement(WallWindowDigits, { key: 'digits', color: '#FFFFFF' }),
        createElement(WallWindowFrost, {
          key: 'frost',
          width: 360,
          reduceMotion: false,
          timed: true,
          children: createElement('b', { 'data-testid': 'glow' }),
        }),
      ]),
    );
    expect(view.getByTestId('play-drawer-wall-control-window-clock').textContent).toBe('· 0:12');
    const clip = frostOf(view);
    expect(clip?.contains(view.getByTestId('glow'))).toBe(true);
    // 12 of 45 s left: the frame slides 264 pt toward the bulb (left), the
    // frost slides back by as much, so only the trailing edge moves.
    expect(translateOf(clip)).toBeCloseTo(-360 * (1 - 12 / 45));
    expect(translateOf(clip?.firstElementChild)).toBeCloseTo(360 * (1 - 12 / 45));
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(view.getByTestId('play-drawer-wall-control-window-clock').textContent).toBe('· 0:11');
  });

  it('keeps the frost whole on a button that draws no timed drive, during one', () => {
    openWindow();
    act(() => {
      vi.advanceTimersByTime(33_000);
    });
    const view = render(
      createElement(WallWindowFrost, {
        width: 360,
        reduceMotion: false,
        timed: false,
        children: createElement('b', { 'data-testid': 'glow' }),
      }),
    );
    expect(frostOf(view)).toBeNull();
    expect(view.getByTestId('glow')).not.toBeNull();
  });

  it('shrinks toward the bulb on the right in a right-to-left layout', () => {
    layoutDirection.isRTL = true;
    openWindow();
    act(() => {
      vi.advanceTimersByTime(33_000);
    });
    const view = render(
      createElement(WallWindowFrost, {
        width: 360,
        reduceMotion: false,
        timed: true,
        children: createElement('b', { 'data-testid': 'glow' }),
      }),
    );
    expect(translateOf(frostOf(view))).toBeCloseTo(360 * (1 - 12 / 45));
    expect(translateOf(frostOf(view)?.firstElementChild)).toBeCloseTo(-360 * (1 - 12 / 45));
  });
});
