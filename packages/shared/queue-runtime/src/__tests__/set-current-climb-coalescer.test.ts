import { describe, it, expect, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import {
  createSetCurrentClimbCoalescer,
  type SetCurrentClimbArgs,
} from '../set-current-climb-coalescer';

const makeItem = (uuid: string): ClimbQueueItem => ({
  uuid,
  climb: {
    uuid: `c-${uuid}`,
    name: uuid,
    frames: '',
    setter_username: '',
    angle: 0,
    ascensionist_count: 0,
    difficulty: '',
    quality_average: '',
    stars: 0,
    difficulty_error: '',
    benchmark_difficulty: null,
  },
});

// Manual promise lets a test gate when sendArgs resolves so we can squeeze
// extra enqueue() calls in while the first send is still in flight.
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createSetCurrentClimbCoalescer', () => {
  it('sends a single enqueue once and resolves', async () => {
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs });

    await coalescer.enqueue({ item: makeItem('a'), shouldAddToQueue: true });

    expect(sendArgs).toHaveBeenCalledTimes(1);
    expect(sendArgs).toHaveBeenCalledWith({ item: makeItem('a'), shouldAddToQueue: true });
  });

  it('serializes two rapid calls: second is sent after first completes', async () => {
    const first = deferred();
    const calls: SetCurrentClimbArgs[] = [];
    const sendArgs = vi.fn(async (args: SetCurrentClimbArgs) => {
      calls.push(args);
      if (calls.length === 1) await first.promise;
    });
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    // Yield so the first send starts and sets inFlight before the second call.
    await Promise.resolve();
    const secondEnqueue = coalescer.enqueue({ item: makeItem('b') });

    // The second enqueue resolves immediately (it was deferred to pending).
    await secondEnqueue;
    // Only the first send has run so far — the second is queued.
    expect(sendArgs).toHaveBeenCalledTimes(1);

    first.resolve();
    await firstEnqueue;

    expect(sendArgs).toHaveBeenCalledTimes(2);
    expect(calls.map((c) => c.item?.uuid)).toEqual(['a', 'b']);
  });

  it('supersedes: only the latest pending args are sent after the first', async () => {
    const first = deferred();
    const calls: SetCurrentClimbArgs[] = [];
    const sendArgs = vi.fn(async (args: SetCurrentClimbArgs) => {
      calls.push(args);
      if (calls.length === 1) await first.promise;
    });
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b') });
    await coalescer.enqueue({ item: makeItem('c') });

    first.resolve();
    await firstEnqueue;

    // 'b' was superseded by 'c' and is never sent.
    expect(calls.map((c) => c.item?.uuid)).toEqual(['a', 'c']);
  });

  it('fires sendSupersededQueueAdd for a superseded args carrying shouldAddToQueue', async () => {
    const first = deferred();
    const calls: SetCurrentClimbArgs[] = [];
    const sendArgs = vi.fn(async (args: SetCurrentClimbArgs) => {
      calls.push(args);
      if (calls.length === 1) await first.promise;
    });
    const sendSupersededQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendSupersededQueueAdd });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    // 'b' will be superseded; it carries shouldAddToQueue so its queue-add
    // must reach the server even though its setCurrentClimb is dropped.
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });
    await coalescer.enqueue({ item: makeItem('c') });

    first.resolve();
    await firstEnqueue;

    expect(sendSupersededQueueAdd).toHaveBeenCalledTimes(1);
    expect(sendSupersededQueueAdd).toHaveBeenCalledWith(makeItem('b'));
  });

  it('omits sendSupersededQueueAdd when the superseded args had no shouldAddToQueue', async () => {
    const first = deferred();
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      sendCount += 1;
      if (sendCount === 1) await first.promise;
    });
    const sendSupersededQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendSupersededQueueAdd });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b') }); // no shouldAddToQueue
    await coalescer.enqueue({ item: makeItem('c') });

    first.resolve();
    await firstEnqueue;

    expect(sendSupersededQueueAdd).not.toHaveBeenCalled();
  });

  it('propagates errors from the first send but still drains pending', async () => {
    const first = deferred();
    const calls: SetCurrentClimbArgs[] = [];
    const sendArgs = vi.fn(async (args: SetCurrentClimbArgs) => {
      calls.push(args);
      if (calls.length === 1) {
        await first.promise;
        throw new Error('first failed');
      }
    });
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b') });

    first.resolve();
    await expect(firstEnqueue).rejects.toThrow('first failed');

    // Drain still ran 'b' after the first throw.
    expect(calls.map((c) => c.item?.uuid)).toEqual(['a', 'b']);
  });

  it('swallows drain errors via onDrainError', async () => {
    const first = deferred();
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      sendCount += 1;
      if (sendCount === 1) await first.promise;
      if (sendCount === 2) throw new Error('drain failed');
    });
    const onDrainError = vi.fn();
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, onDrainError });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b') });

    first.resolve();
    await firstEnqueue; // does not throw — drain error swallowed

    expect(onDrainError).toHaveBeenCalledTimes(1);
    expect(onDrainError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('returns to idle state after drain so a later enqueue starts fresh', async () => {
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs });

    await coalescer.enqueue({ item: makeItem('a') });
    await coalescer.enqueue({ item: makeItem('b') });

    expect(sendArgs).toHaveBeenCalledTimes(2);
  });
});
