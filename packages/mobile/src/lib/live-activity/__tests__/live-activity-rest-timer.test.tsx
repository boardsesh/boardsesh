// @vitest-environment jsdom
//
// The rest timer reaches the Lock Screen only through these sends, and the
// native side draws the countdown itself — so the contract is about WHEN JS
// speaks: on every real change, once at each deadline, after every start, and
// never per second. The rest-timer store is the real one.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveActivityRestTimerOptions } from '../../../../modules/live-activity/src/index';

const harness = vi.hoisted(() => ({
  nowMs: Date.parse('2026-10-18T10:00:00.000Z'),
  appStateListener: null as null | ((state: string) => void),
  sent: [] as (LiveActivityRestTimerOptions | null)[],
  supportsRestTimer: true,
  pacingOverride: null as null | { targetSeconds: number; mode: 'afterTick' | 'onTheMinute' },
}));

const settingsStore = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.appStateListener = listener;
      return {
        remove: () => {
          harness.appStateListener = null;
        },
      };
    },
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

vi.mock('../../clock', () => ({ nowMs: () => harness.nowMs }));

vi.mock('../../../settings', async () => {
  const { useReducer, useEffect } = await import('react');
  return {
    useSetting: (key: string) => {
      const [, forceRender] = useReducer((count: number) => count + 1, 0);
      useEffect(() => {
        settingsStore.listeners.add(forceRender);
        return () => {
          settingsStore.listeners.delete(forceRender);
        };
      }, []);
      return [settingsStore.values[key], vi.fn()];
    },
  };
});

// Stage and crew pacing reach the hook as a different resolved value; the
// override stands in for them. Without one the real hook reads the settings.
vi.mock('../../../hooks/use-effective-rest-pacing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/use-effective-rest-pacing')>();
  return {
    ...actual,
    useEffectiveRestPacing: () => {
      const resolved = actual.useEffectiveRestPacing();
      return harness.pacingOverride === null ? resolved : { ...resolved, ...harness.pacingOverride };
    },
  };
});

vi.mock('../live-activity-plugin', () => ({
  get sessionPresenceSupportsRestTimer() {
    return harness.supportsRestTimer;
  },
  updateLiveActivityRestTimer: async (options: LiveActivityRestTimerOptions | null) => {
    harness.sent.push(options);
  },
}));

import {
  armRestTimer,
  disarmRestTimer,
  noteRestTimerQueueEnded,
  noteRestTimerTick,
  pauseRestTimer,
  resetRestTimerStoreForTests,
} from '../../rest-timer-store';
import { LiveActivityRestTimerSync, REST_TIMER_DEADLINE_SLACK_MS } from '../live-activity-rest-timer';

const T0 = Date.parse('2026-10-18T10:00:00.000Z');
const SESSION = 'session-1';

function setSetting(key: string, value: unknown) {
  act(() => {
    settingsStore.values[key] = value;
    for (const listener of settingsStore.listeners) listener();
  });
}

/** Moves the mocked clock and the fake timers together. */
function advance(ms: number) {
  act(() => {
    harness.nowMs += ms;
    vi.advanceTimersByTime(ms);
  });
}

function renderSync(activityStartCount = 0) {
  return render(<LiveActivityRestTimerSync sessionId={SESSION} activityStartCount={activityStartCount} />);
}

function armAndTick() {
  act(() => {
    armRestTimer('afterTick', harness.nowMs, SESSION);
    noteRestTimerTick(new Date(harness.nowMs).toISOString(), 'afterTick', harness.nowMs);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.nowMs = T0;
  harness.sent = [];
  harness.appStateListener = null;
  harness.supportsRestTimer = true;
  harness.pacingOverride = null;
  settingsStore.values = {
    restTimerTargetSeconds: 120,
    restTimerMode: 'afterTick',
    restTimerShowOnLockScreen: true,
  };
  settingsStore.listeners.clear();
});

afterEach(() => {
  cleanup();
  resetRestTimerStoreForTests();
  vi.useRealTimers();
});

describe('LiveActivityRestTimerSync', () => {
  it('counts the effective rest, not the raw setting, when something else paces the timer', () => {
    harness.pacingOverride = { targetSeconds: 45, mode: 'afterTick' };
    renderSync();
    armAndTick();

    const running = harness.sent.at(-1);
    expect(running?.status).toBe('running');
    expect(running?.targetSeconds).toBe(45);
    expect(running?.deadlineMs).toBe(T0 + 45_000);
  });

  it('stays silent on a binary that predates the rest timer: no sends, no timeouts, no app-state listener', () => {
    harness.supportsRestTimer = false;
    renderSync();
    armAndTick();
    advance(120_000 + REST_TIMER_DEADLINE_SLACK_MS);

    expect(harness.sent).toEqual([]);
    expect(harness.appStateListener).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the Lock Screen once on mount, so a killed app never leaves a timer behind', () => {
    renderSync();
    expect(harness.sent).toEqual([null]);
  });

  it('sends the rest when a climb is logged, and nothing more while it runs', () => {
    renderSync();
    armAndTick();
    expect(harness.sent.at(-1)).toMatchObject({ status: 'running', startMs: T0, deadlineMs: T0 + 120_000 });
    const sends = harness.sent.length;

    // A minute of nothing happening: no per-second traffic.
    advance(60_000);
    expect(harness.sent).toHaveLength(sends);
  });

  it('sends again at the deadline so the Lock Screen redraws as over', () => {
    renderSync();
    armAndTick();
    const sends = harness.sent.length;

    advance(120_000 + REST_TIMER_DEADLINE_SLACK_MS);
    expect(harness.sent).toHaveLength(sends + 1);
    // The same snapshot, re-sent so iOS redraws; Android picks the over
    // caption itself from androidOverCaption once past the deadline.
    expect(harness.sent.at(-1)).toMatchObject({
      status: 'running',
      deadlineMs: T0 + 120_000,
      androidOverCaption: 'mobile.restTimer.clockCaptionOver',
    });

    // Over is a resting state: no further wake-ups.
    advance(600_000);
    expect(harness.sent).toHaveLength(sends + 1);
  });

  it('rolls a fixed window on at every beat', () => {
    settingsStore.values.restTimerMode = 'onTheMinute';
    settingsStore.values.restTimerTargetSeconds = 60;
    renderSync();
    act(() => {
      armRestTimer('onTheMinute', harness.nowMs, SESSION);
    });
    expect(harness.sent.at(-1)).toMatchObject({ startMs: T0, deadlineMs: T0 + 60_000, periodSeconds: 60 });

    advance(60_000 + REST_TIMER_DEADLINE_SLACK_MS);
    expect(harness.sent.at(-1)).toMatchObject({ startMs: T0 + 60_000, deadlineMs: T0 + 120_000 });

    advance(60_000);
    expect(harness.sent.at(-1)).toMatchObject({ startMs: T0 + 120_000, deadlineMs: T0 + 180_000 });
  });

  it('keeps rolling a fixed window after the queue runs out', () => {
    settingsStore.values.restTimerMode = 'onTheMinute';
    settingsStore.values.restTimerTargetSeconds = 60;
    renderSync();
    act(() => {
      armRestTimer('onTheMinute', harness.nowMs, SESSION);
      noteRestTimerQueueEnded();
    });
    expect(harness.sent.at(-1)).toMatchObject({ status: 'queueEnded', startMs: T0, deadlineMs: T0 + 60_000 });

    advance(60_000 + REST_TIMER_DEADLINE_SLACK_MS);
    expect(harness.sent.at(-1)).toMatchObject({ status: 'queueEnded', startMs: T0 + 60_000, deadlineMs: T0 + 120_000 });
  });

  it('re-sends after every Live Activity start, even when nothing changed', () => {
    const { rerender } = renderSync(0);
    armAndTick();
    const sends = harness.sent.length;
    const last = harness.sent.at(-1);

    rerender(<LiveActivityRestTimerSync sessionId={SESSION} activityStartCount={1} />);
    expect(harness.sent).toHaveLength(sends + 1);
    expect(harness.sent.at(-1)).toEqual(last);
  });

  it('skips a recompute that changes nothing', () => {
    renderSync();
    armAndTick();
    const sends = harness.sent.length;

    act(() => harness.appStateListener?.('background'));
    act(() => harness.appStateListener?.('active'));
    expect(harness.sent).toHaveLength(sends);
  });

  it('follows pause, the Lock Screen switch and disarm', () => {
    renderSync();
    armAndTick();

    act(() => pauseRestTimer(harness.nowMs + 30_000));
    expect(harness.sent.at(-1)).toMatchObject({ status: 'paused', frozenSignedSeconds: 90 });

    setSetting('restTimerShowOnLockScreen', false);
    expect(harness.sent.at(-1)).toBeNull();

    setSetting('restTimerShowOnLockScreen', true);
    expect(harness.sent.at(-1)).toMatchObject({ status: 'paused' });

    act(() => disarmRestTimer());
    expect(harness.sent.at(-1)).toBeNull();
  });

  it('follows a rest-length change mid-rest', () => {
    renderSync();
    armAndTick();
    setSetting('restTimerTargetSeconds', 180);
    expect(harness.sent.at(-1)).toMatchObject({ deadlineMs: T0 + 180_000, targetSeconds: 180 });
  });
});
