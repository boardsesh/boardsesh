import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeChunkSeries } from '../index';

afterEach(() => vi.useRealTimers());

describe('shared ATT chunk iteration', () => {
  it('preserves caller boundaries and awaits one write before beginning the next', async () => {
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = Uint8Array.of(1, 2, 3);
    const second = Uint8Array.of(4);
    const write = vi
      .fn<(chunk: Uint8Array) => Promise<void>>()
      .mockImplementationOnce(() => firstWrite)
      .mockResolvedValue(undefined);
    const pending = writeChunkSeries([first, second], write);
    expect(write).toHaveBeenCalledExactlyOnceWith(first);
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    releaseFirst();
    await pending;
    expect(write.mock.calls).toEqual([[first], [second]]);
  });

  it('preserves the legacy DOM cancellation error and removes a pending pacing timer', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const write = vi.fn(async () => {});
    const pending = writeChunkSeries([Uint8Array.of(1), Uint8Array.of(2)], write, {
      signal: controller.signal,
      delayMs: 5,
      abortError: () => new DOMException('Write aborted', 'AbortError'),
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError', message: 'Write aborted' });
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(1);
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(write).toHaveBeenCalledOnce();
  });

  it('checks the platform pacing gate again after each completed chunk', async () => {
    vi.useFakeTimers();
    let foreground = true;
    const write = vi.fn(async () => {
      foreground = false;
    });
    const pending = writeChunkSeries([Uint8Array.of(1), Uint8Array.of(2), Uint8Array.of(3)], write, {
      delayMs: 5,
      shouldDelay: () => foreground,
    });
    // This must finish without advancing JS timers after Android backgrounds.
    await pending;
    expect(write).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
