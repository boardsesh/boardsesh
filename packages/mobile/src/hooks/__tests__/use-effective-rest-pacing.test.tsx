// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const settingsStore = vi.hoisted(() => ({
  values: {} as Record<string, unknown>,
  listeners: new Set<() => void>(),
}));

vi.mock('../../settings', async () => {
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
    getSetting: (key: string) => settingsStore.values[key],
  };
});

import { getEffectiveRestPacing, useEffectiveRestPacing } from '../use-effective-rest-pacing';

function writeSetting(key: string, value: unknown) {
  act(() => {
    settingsStore.values[key] = value;
    for (const listener of settingsStore.listeners) listener();
  });
}

beforeEach(() => {
  settingsStore.values = { restTimerTargetSeconds: 90, restTimerMode: 'onTheMinute', restTimerAutoAdvance: true };
  settingsStore.listeners.clear();
});

describe('useEffectiveRestPacing', () => {
  it('reads the three rest-timer settings, on the deadline, from the settings source', () => {
    const { result } = renderHook(() => useEffectiveRestPacing());
    expect(result.current).toEqual({
      targetSeconds: 90,
      mode: 'onTheMinute',
      autoAdvance: true,
      advanceOn: 'deadline',
      source: 'settings',
      stage: null,
    });
  });

  it('hands back the same object until a setting changes, so readers do not reschedule', () => {
    const { result, rerender } = renderHook(() => useEffectiveRestPacing());
    const first = result.current;

    rerender();
    expect(result.current).toBe(first);

    writeSetting('restTimerTargetSeconds', 120);
    expect(result.current).not.toBe(first);
    expect(result.current.targetSeconds).toBe(120);
  });

  it('agrees with the non-React read', () => {
    const { result } = renderHook(() => useEffectiveRestPacing());
    expect(getEffectiveRestPacing()).toEqual(result.current);

    writeSetting('restTimerMode', 'afterTick');
    expect(getEffectiveRestPacing()).toEqual(result.current);
  });
});
