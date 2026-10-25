import { describe, expect, it, vi } from 'vitest';
import { noteSessionTimerTick, subscribeSessionTimerTicks } from '../tick-events';

const NOW_MS = Date.parse('2026-10-24T10:00:30.000Z');

describe('session timer ticks', () => {
  it('hands every subscriber the tick as stored, its time and now', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = subscribeSessionTimerTicks(first);
    const unsubscribeSecond = subscribeSessionTimerTicks(second);

    noteSessionTimerTick('2026-10-24T10:00:25.000Z', NOW_MS);

    const tick = {
      climbedAt: '2026-10-24T10:00:25.000Z',
      climbedAtMs: Date.parse('2026-10-24T10:00:25.000Z'),
      nowMs: NOW_MS,
    };
    expect(first).toHaveBeenCalledWith(tick);
    expect(second).toHaveBeenCalledWith(tick);
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('says null for a timestamp it cannot read', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSessionTimerTicks(listener);
    noteSessionTimerTick('not a date', NOW_MS);
    expect(listener).toHaveBeenCalledWith({ climbedAt: 'not a date', climbedAtMs: null, nowMs: NOW_MS });
    unsubscribe();
  });

  it('stops after unsubscribing', () => {
    const listener = vi.fn();
    subscribeSessionTimerTicks(listener)();
    noteSessionTimerTick('2026-10-24T10:00:25.000Z', NOW_MS);
    expect(listener).not.toHaveBeenCalled();
  });

  it('never throws at the save that called it, and still reaches the other sinks', () => {
    const failing = vi.fn(() => {
      throw new Error('sink broke');
    });
    const healthy = vi.fn();
    const unsubscribeFailing = subscribeSessionTimerTicks(failing);
    const unsubscribeHealthy = subscribeSessionTimerTicks(healthy);

    expect(() => noteSessionTimerTick('2026-10-24T10:00:25.000Z', NOW_MS)).not.toThrow();
    expect(healthy).toHaveBeenCalledTimes(1);
    unsubscribeFailing();
    unsubscribeHealthy();
  });
});
