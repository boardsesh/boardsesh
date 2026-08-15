// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

vi.mock('server-only', () => ({}));

import { DbReadTimeoutError, FRONT_DOOR_READ_DEADLINE_MS, withReadDeadline } from '../read-deadline';

describe('withReadDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to a 6 second front-door deadline', () => {
    expect(FRONT_DOOR_READ_DEADLINE_MS).toBe(6000);
  });

  it('rejects with DbReadTimeoutError once the deadline elapses', async () => {
    const cancel = vi.fn();
    const neverSettling = Object.assign(new Promise<string>(() => {}), { cancel });

    const pending = withReadDeadline('climb-select', neverSettling);
    const assertion = expect(pending).rejects.toBeInstanceOf(DbReadTimeoutError);

    await vi.advanceTimersByTimeAsync(FRONT_DOOR_READ_DEADLINE_MS);
    await assertion;
  });

  it('cancels the pending query exactly once when the deadline wins', async () => {
    const cancel = vi.fn();
    const neverSettling = Object.assign(new Promise<string>(() => {}), { cancel });

    const pending = withReadDeadline('climb-select', neverSettling, 1000);
    const assertion = expect(pending).rejects.toThrow(/exceeded 1000ms/);

    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    // postgres.js queues a query with no timeout of its own, so walking away
    // would leave a zombie statement that fires when the pool recovers.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('carries the label into the error message', async () => {
    const neverSettling = Object.assign(new Promise<string>(() => {}), { cancel: vi.fn() });

    const pending = withReadDeadline('climb-alias', neverSettling, 500);
    const assertion = expect(pending).rejects.toThrow(/"climb-alias"/);

    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it('resolves a fast read without cancelling it, and clears the timer', async () => {
    const cancel = vi.fn();
    const fast = Object.assign(Promise.resolve('rows'), { cancel });

    await expect(withReadDeadline('climb-select', fast, 1000)).resolves.toBe('rows');

    expect(cancel).not.toHaveBeenCalled();
    // A leaked timer per read would keep a serverless instance alive past its
    // response for the length of the deadline.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates the underlying error and clears the timer', async () => {
    const cancel = vi.fn();
    const failing = Object.assign(Promise.reject(new Error('relation does not exist')), { cancel });

    await expect(withReadDeadline('climb-select', failing, 1000)).rejects.toThrow('relation does not exist');

    expect(cancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts a plain promise with no cancel (drizzle-issued queries)', async () => {
    await expect(withReadDeadline('climb-search', Promise.resolve(['a']), 1000)).resolves.toEqual(['a']);
  });

  it('does not blow up cancelling a plain promise on timeout', async () => {
    const pending = withReadDeadline('climb-search', new Promise<string>(() => {}), 750);
    const assertion = expect(pending).rejects.toBeInstanceOf(DbReadTimeoutError);

    await vi.advanceTimersByTimeAsync(750);
    await assertion;
  });
});
