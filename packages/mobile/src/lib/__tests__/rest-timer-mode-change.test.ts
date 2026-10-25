import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsStore = vi.hoisted(() => ({ values: new Map<string, unknown>() }));
vi.mock('../../settings', () => ({
  getSetting: (key: string) => settingsStore.values.get(key),
  setSetting: (key: string, value: unknown) => {
    settingsStore.values.set(key, value);
  },
}));

const pacingOverride = vi.hoisted(() => ({ source: null as 'stage' | 'crew' | null }));
vi.mock('../../hooks/use-effective-rest-pacing', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../hooks/use-effective-rest-pacing')>();
  return {
    ...original,
    getEffectiveRestPacing: () => {
      const pacing = original.getEffectiveRestPacing();
      return pacingOverride.source ? { ...pacing, source: pacingOverride.source } : pacing;
    },
  };
});

import { changeRestTimerMode } from '../rest-timer-mode-change';
import {
  adoptCrewCadence,
  armRestTimer,
  getRestTimerState,
  noteRestTimerTick,
  resetRestTimerStoreForTests,
  subscribeLocalRestTimerActions,
} from '../rest-timer-store';

beforeEach(() => {
  resetRestTimerStoreForTests();
  settingsStore.values.clear();
  settingsStore.values.set('restTimerMode', 'afterTick');
  pacingOverride.source = null;
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

  it.each(['stage', 'crew'] as const)('saves the cadence but keeps a %s-paced timer armed as it was', (source) => {
    pacingOverride.source = source;
    settingsStore.values.set('restTimerMode', 'onTheMinute');
    armRestTimer('onTheMinute', Date.now(), 'session-1');
    const before = getRestTimerState();
    expect(changeRestTimerMode('afterTick', 'session-1')).toBe(true);
    expect(settingsStore.values.get('restTimerMode')).toBe('afterTick');
    expect(getRestTimerState()).toBe(before);
  });
});

describe('changeRestTimerMode under a crew clock this app cannot run (Fable, #6757)', () => {
  it('saves the cadence but never re-arms, so no ARM replaces the crew’s clock', () => {
    const now = Date.now();
    armRestTimer('afterTick', now, 'session-1');
    // A newer app set the crew clock: held, config null, resolving as the settings.
    adoptCrewCadence({
      sessionId: 'session-1',
      revision: 3,
      config: null,
      isRunning: true,
      anchorMs: now,
      pausedElapsedSeconds: 0,
      lastFiredBeatMs: null,
      lastTick: null,
      anchorServerMs: now,
      lastFiredBeatServerMs: null,
    });
    const actions: string[] = [];
    subscribeLocalRestTimerActions((action) => actions.push(action.type));
    const before = getRestTimerState();

    expect(changeRestTimerMode('onTheMinute', 'session-1')).toBe(true);
    expect(settingsStore.values.get('restTimerMode')).toBe('onTheMinute');
    expect(actions).toEqual([]);
    expect(getRestTimerState()).toBe(before);
  });
});
