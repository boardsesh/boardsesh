import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMinuteTicker } from '../cron/scheduler';

// The ticker wakes 500ms after each minute boundary, so a test that wants
// `count` ticks has to advance past that offset.
const advanceMinutes = (count: number) => vi.advanceTimersByTime(count * 60_000 + 500);

describe('createMinuteTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a job in its matching minute and not in the next one', () => {
    vi.setSystemTime(new Date('2026-08-11T04:59:00Z'));
    const ticker = createMinuteTicker();
    const handler = vi.fn();
    ticker.schedule('0 5 * * *', handler, { timezone: 'UTC' });

    advanceMinutes(1);
    expect(handler).toHaveBeenCalledTimes(1);

    advanceMinutes(1);
    expect(handler).toHaveBeenCalledTimes(1);

    ticker.stop();
  });

  it('does not fire outside the matching minute', () => {
    vi.setSystemTime(new Date('2026-08-11T01:00:00Z'));
    const ticker = createMinuteTicker();
    const handler = vi.fn();
    ticker.schedule('0 5 * * *', handler, { timezone: 'UTC' });

    advanceMinutes(30);
    expect(handler).not.toHaveBeenCalled();

    ticker.stop();
  });

  it('evaluates the schedule in the declared timezone, not the host zone', () => {
    // 19:00 UTC is 05:00 the next day in Sydney, so the UTC-scheduled job must
    // stay quiet while the Sydney-scheduled one fires.
    vi.setSystemTime(new Date('2026-08-11T18:59:00Z'));
    const ticker = createMinuteTicker();
    const utcHandler = vi.fn();
    const sydneyHandler = vi.fn();
    ticker.schedule('0 5 * * *', utcHandler, { timezone: 'UTC' });
    ticker.schedule('0 5 * * *', sydneyHandler, { timezone: 'Australia/Sydney' });

    advanceMinutes(1);
    expect(utcHandler).not.toHaveBeenCalled();
    expect(sydneyHandler).toHaveBeenCalledTimes(1);

    ticker.stop();
  });

  it('keeps ticking after a handler throws', () => {
    vi.setSystemTime(new Date('2026-08-11T04:58:00Z'));
    const onHandlerError = vi.fn();
    const ticker = createMinuteTicker({ onHandlerError });
    const throwingHandler = vi.fn(() => {
      throw new Error('boom');
    });
    const healthyHandler = vi.fn();
    ticker.schedule('* * * * *', throwingHandler, { timezone: 'UTC' });
    ticker.schedule('* * * * *', healthyHandler, { timezone: 'UTC' });

    advanceMinutes(3);
    expect(throwingHandler).toHaveBeenCalledTimes(3);
    expect(healthyHandler).toHaveBeenCalledTimes(3);
    expect(onHandlerError).toHaveBeenCalledTimes(3);

    ticker.stop();
  });

  it('stops firing once the task is stopped', () => {
    vi.setSystemTime(new Date('2026-08-11T04:58:00Z'));
    const ticker = createMinuteTicker();
    const handler = vi.fn();
    const task = ticker.schedule('* * * * *', handler, { timezone: 'UTC' });

    advanceMinutes(1);
    expect(handler).toHaveBeenCalledTimes(1);

    task.stop();
    expect(vi.getTimerCount()).toBe(0);

    advanceMinutes(5);
    expect(handler).toHaveBeenCalledTimes(1);

    ticker.stop();
  });

  it('clears every timer on stop() and refuses further registration', () => {
    vi.setSystemTime(new Date('2026-08-11T04:58:00Z'));
    const ticker = createMinuteTicker();
    ticker.schedule('* * * * *', vi.fn(), { timezone: 'UTC' });
    expect(vi.getTimerCount()).toBe(1);

    ticker.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(() => ticker.schedule('* * * * *', vi.fn(), { timezone: 'UTC' })).toThrow(/stopped ticker/);
  });

  it('rejects an invalid expression or timezone at registration time', () => {
    const ticker = createMinuteTicker();
    expect(() => ticker.schedule('not a cron', vi.fn(), { timezone: 'UTC' })).toThrow();
    expect(() => ticker.schedule('0 5 * * *', vi.fn(), { timezone: 'Mars/Olympus_Mons' })).toThrow();
    ticker.stop();
  });
});
