import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStore = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('../../settings', () => ({
  getSetting: (key: string) => settingsStore.values.get(key),
  setSetting: (key: string, value: unknown) => {
    settingsStore.values.set(key, value);
  },
}));

import { changeRestTimerMode } from '../rest-timer-mode-change';
import { armRestTimer, getRestTimerState, noteRestTimerTick, resetRestTimerStoreForTests } from '../rest-timer-store';

beforeEach(() => {
  resetRestTimerStoreForTests();
  settingsStore.values.clear();
  settingsStore.values.set('restTimerMode', 'afterTick');
});

describe('changeRestTimerMode', () => {
  it('saves the cadence and leaves a disarmed timer alone', () => {
    expect(changeRestTimerMode('onTheMinute', null)).toBe(true);
    expect(settingsStore.values.get('restTimerMode')).toBe('onTheMinute');
    expect(getRestTimerState().armed).toBe(false);
  });

  it('does nothing for the cadence that is already saved', () => {
    const now = Date.now();
    armRestTimer('afterTick', now, 'session-1');
    noteRestTimerTick(new Date(now).toISOString(), 'afterTick', now);
    const before = getRestTimerState();
    expect(changeRestTimerMode('afterTick', 'session-1')).toBe(false);
    expect(getRestTimerState()).toBe(before);
  });

  it('re-arms a running timer on the new cadence, bound to the session', () => {
    armRestTimer('afterTick', Date.now(), 'session-1');
    expect(getRestTimerState().anchorMs).toBeNull();
    changeRestTimerMode('onTheMinute', 'session-1');
    const state = getRestTimerState();
    expect(state).toMatchObject({ armed: true, armedForSessionId: 'session-1' });
    expect(state.anchorMs).not.toBeNull();
  });
});
