import { describe, it, expect, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { createSetCurrentClimbCoalescer, type SetCurrentClimbArgs } from '../set-current-climb-coalescer';

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
    expect(sendArgs).toHaveBeenCalledWith({ item: makeItem('a'), shouldAddToQueue: true }, undefined);
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

  it('fires sendDeferredQueueAdd for a superseded args carrying shouldAddToQueue', async () => {
    const first = deferred();
    const calls: SetCurrentClimbArgs[] = [];
    const sendArgs = vi.fn(async (args: SetCurrentClimbArgs) => {
      calls.push(args);
      if (calls.length === 1) await first.promise;
    });
    const sendDeferredQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    // 'b' will be superseded; it carries shouldAddToQueue so its queue-add
    // must reach the server even though its setCurrentClimb is dropped.
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });
    await coalescer.enqueue({ item: makeItem('c') });

    first.resolve();
    await firstEnqueue;

    expect(sendDeferredQueueAdd).toHaveBeenCalledTimes(1);
    expect(sendDeferredQueueAdd).toHaveBeenCalledWith(makeItem('b'), undefined);
  });

  it('omits sendDeferredQueueAdd when the superseded args had no shouldAddToQueue', async () => {
    const first = deferred();
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      sendCount += 1;
      if (sendCount === 1) await first.promise;
    });
    const sendDeferredQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b') }); // no shouldAddToQueue
    await coalescer.enqueue({ item: makeItem('c') });

    first.resolve();
    await firstEnqueue;

    expect(sendDeferredQueueAdd).not.toHaveBeenCalled();
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

  // The drained call's own promise resolved when it superseded the head, so the
  // sink is the only place that can say WHICH move never landed.
  it('hands onDrainError the drained call’s args', async () => {
    const first = deferred();
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      sendCount += 1;
      if (sendCount === 1) await first.promise;
      if (sendCount === 2) throw new Error('drain failed');
    });
    const onDrainError = vi.fn();
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, onDrainError });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a'), correlationId: 'corr-a' });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true, correlationId: 'corr-b' });
    first.resolve();
    await firstEnqueue;

    expect(onDrainError).toHaveBeenCalledWith(expect.any(Error), {
      item: makeItem('b'),
      shouldAddToQueue: true,
      correlationId: 'corr-b',
    });
  });

  it('keeps sending later activations when the drain-error sink throws', async () => {
    const first = deferred();
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      sendCount += 1;
      if (sendCount === 1) await first.promise;
      if (sendCount === 2) throw new Error('drain failed');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const coalescer = createSetCurrentClimbCoalescer({
      sendArgs,
      onDrainError: () => {
        throw new Error('sink bug');
      },
    });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b') });
    first.resolve();
    await firstEnqueue;
    await coalescer.enqueue({ item: makeItem('c') });

    expect(sendArgs.mock.calls.map(([args]) => args.item?.uuid)).toEqual(['a', 'b', 'c']);
    consoleError.mockRestore();
  });

  it('returns to idle state after drain so a later enqueue starts fresh', async () => {
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs });

    await coalescer.enqueue({ item: makeItem('a') });
    await coalescer.enqueue({ item: makeItem('b') });

    expect(sendArgs).toHaveBeenCalledTimes(2);
  });

  it('captures getContext() at enqueue time and threads it to sendArgs (drain uses captured, not current)', async () => {
    const first = deferred();
    let currentSession = 'sess-A';
    const sendCalls: Array<{ uuid: string; ctx: string }> = [];
    const sendArgs = vi.fn(async (args: SetCurrentClimbArgs, ctx: string) => {
      sendCalls.push({ uuid: args.item?.uuid ?? '', ctx });
      if (sendCalls.length === 1) await first.promise;
    });
    const coalescer = createSetCurrentClimbCoalescer<string>({
      getContext: () => currentSession,
      sendArgs,
    });

    // First enqueue captures sess-A; the call is in-flight.
    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();

    // Second enqueue: still in sess-A.
    await coalescer.enqueue({ item: makeItem('b') });

    // Session flips before the drain runs.
    currentSession = 'sess-B';

    first.resolve();
    await firstEnqueue;

    // First call captured sess-A; the drained second call ALSO carries
    // sess-A — the context the enqueue happened in, not the current one.
    expect(sendCalls).toEqual([
      { uuid: 'a', ctx: 'sess-A' },
      { uuid: 'b', ctx: 'sess-A' },
    ]);
  });

  it('sendDeferredQueueAdd receives the captured context of the superseded args (not the current)', async () => {
    const first = deferred();
    let currentSession = 'sess-A';
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs, _ctx: string) => {
      if (sendArgs.mock.calls.length === 1) await first.promise;
    });
    const supersedeCalls: Array<{ uuid: string; ctx: string }> = [];
    const sendDeferredQueueAdd = vi.fn(async (item: ClimbQueueItem, ctx: string) => {
      supersedeCalls.push({ uuid: item.uuid, ctx });
    });
    const coalescer = createSetCurrentClimbCoalescer<string>({
      getContext: () => currentSession,
      sendArgs,
      sendDeferredQueueAdd,
    });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();

    // 'b' enqueued under sess-A with shouldAddToQueue.
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });

    // Session flips to B before 'c' supersedes 'b'.
    currentSession = 'sess-B';
    await coalescer.enqueue({ item: makeItem('c') });

    first.resolve();
    await firstEnqueue;

    // Supersede fired against the SUPERSEDED entry's captured session (A),
    // not the current (B) — even though sess-B is what's active when the
    // supersede event happens.
    expect(supersedeCalls).toEqual([{ uuid: 'b', ctx: 'sess-A' }]);
  });

  it('defaults context to undefined when getContext is omitted', async () => {
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs, _ctx: void) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs });

    await coalescer.enqueue({ item: makeItem('a') });

    expect(sendArgs).toHaveBeenCalledWith({ item: makeItem('a') }, undefined);
  });
});

// The second way a pending activation loses its setCurrentClimb: it drains, and
// the drained send rejects (rate limit, socket blip). On `main` that lost the
// queue-add outright — the slot existed on the picker's device and nowhere else
// (#3936).
describe('createSetCurrentClimbCoalescer — drained-then-rejected recovery', () => {
  // Drives one held first send, one drained send whose outcome the test picks.
  function harness(drainOutcome: 'reject' | 'resolve', deferredAdd?: (item: ClimbQueueItem) => Promise<void>) {
    const first = deferred();
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      sendCount += 1;
      if (sendCount === 1) {
        await first.promise;
        return;
      }
      if (drainOutcome === 'reject') throw new Error('RATE_LIMITED');
    });
    const sendDeferredQueueAdd = vi.fn(deferredAdd ?? (async (_item: ClimbQueueItem) => {}));
    const onDrainError = vi.fn();
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd, onDrainError });
    return { first, sendArgs, sendDeferredQueueAdd, onDrainError, coalescer };
  }

  it('fires the deferred queue-add when a drained pending call rejects', async () => {
    const { first, sendDeferredQueueAdd, coalescer } = harness('reject');

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    // 'b' is the tail of the burst: it drains and its SET_CURRENT_CLIMB is
    // throttled away. Its queue slot has to reach the server anyway.
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });

    first.resolve();
    await firstEnqueue;

    expect(sendDeferredQueueAdd).toHaveBeenCalledTimes(1);
    expect(sendDeferredQueueAdd).toHaveBeenCalledWith(makeItem('b'), undefined);
  });

  it('does not fire the deferred add for a drained POINTER-ONLY call', async () => {
    const { first, sendDeferredQueueAdd, coalescer } = harness('reject');

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    // No shouldAddToQueue: a rapid queue swipe moves the pointer only. Adding
    // anything here would inject a phantom slot on every throttled swipe.
    await coalescer.enqueue({ item: makeItem('b') });

    first.resolve();
    await firstEnqueue;

    expect(sendDeferredQueueAdd).not.toHaveBeenCalled();
  });

  it('does not fire the deferred add when the drained call succeeds', async () => {
    const { first, sendDeferredQueueAdd, coalescer } = harness('resolve');

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });

    first.resolve();
    await firstEnqueue;

    // The setCurrentClimb landed and carried shouldAddToQueue with it — a
    // second ADD here would duplicate every coalesced burst's tail.
    expect(sendDeferredQueueAdd).not.toHaveBeenCalled();
  });

  it('still reports the drain failure to onDrainError', async () => {
    const { first, onDrainError, coalescer } = harness('reject');

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });

    first.resolve();
    await firstEnqueue;

    expect(onDrainError).toHaveBeenCalledTimes(1);
    expect(onDrainError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  // Mobile holds a lost slot back while it waits to re-send the move: an ADD
  // landing before the rejoin snapshot is read would spoil it (#6783 QA).
  it('skips its deferred queue-add when onDrainError claims it, and fires it when the sink throws', async () => {
    const claimed = harness('reject');
    claimed.onDrainError.mockReturnValue(true);
    const claimedEnqueue = claimed.coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await claimed.coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });
    claimed.first.resolve();
    await claimedEnqueue;
    expect(claimed.sendDeferredQueueAdd).not.toHaveBeenCalled();

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const throwing = harness('reject');
    throwing.onDrainError.mockImplementation(() => {
      throw new Error('sink bug');
    });
    const throwingEnqueue = throwing.coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await throwing.coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });
    throwing.first.resolve();
    await throwingEnqueue;
    expect(throwing.sendDeferredQueueAdd).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it('does not await the deferred add (a backing-off ADD must not wedge the drain)', async () => {
    // A rate-limited ADD can sit in the transport's back-off for seconds.
    const { first, sendArgs, sendDeferredQueueAdd, coalescer } = harness(
      'reject',
      () => new Promise<void>(() => {}), // never settles
    );

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });

    first.resolve();
    await firstEnqueue; // resolves despite the never-settling ADD
    expect(sendDeferredQueueAdd).toHaveBeenCalledTimes(1);

    // inFlight was released, so a later activation is SENT, not parked pending.
    // (The harness keeps rejecting, hence the rejects.toThrow — what matters is
    // that sendArgs ran at all rather than the call sitting in `pending`.)
    await expect(coalescer.enqueue({ item: makeItem('c') })).rejects.toThrow('RATE_LIMITED');
    expect(sendArgs).toHaveBeenCalledTimes(3);
  });

  it('routes a SYNCHRONOUS throw from the deferred add to the error sink instead of wedging', async () => {
    const first = deferred();
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      sendCount += 1;
      if (sendCount === 1) {
        await first.promise;
        return;
      }
      if (sendCount === 2) throw new Error('RATE_LIMITED');
    });
    // Not `async`: the option type promises a Promise but nothing enforces it.
    // Unguarded, this throw escapes the drain's enclosing `finally` and leaves
    // inFlight stuck true forever.
    const sendDeferredQueueAdd = vi.fn((_item: ClimbQueueItem): Promise<void> => {
      throw new Error('sync boom');
    });
    const onDeferredQueueAddError = vi.fn();
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd, onDeferredQueueAddError });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });

    first.resolve();
    await firstEnqueue;

    expect(onDeferredQueueAddError).toHaveBeenCalledWith(expect.any(Error));
    // Not wedged: a later activation is still sent.
    await coalescer.enqueue({ item: makeItem('c') });
    expect(sendArgs).toHaveBeenCalledTimes(3);
  });

  it('uses the DRAINED entry captured context, not the current one', async () => {
    const first = deferred();
    let currentSession = 'sess-A';
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs, _ctx: string) => {
      sendCount += 1;
      if (sendCount === 1) {
        await first.promise;
        return;
      }
      throw new Error('RATE_LIMITED');
    });
    const addCalls: Array<{ uuid: string; ctx: string }> = [];
    const sendDeferredQueueAdd = vi.fn(async (item: ClimbQueueItem, ctx: string) => {
      addCalls.push({ uuid: item.uuid, ctx });
    });
    const coalescer = createSetCurrentClimbCoalescer<string>({
      getContext: () => currentSession,
      sendArgs,
      sendDeferredQueueAdd,
      onDrainError: () => {},
    });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a') });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });
    // The session flips while 'b' is parked as pending.
    currentSession = 'sess-B';

    first.resolve();
    await firstEnqueue;

    expect(addCalls).toEqual([{ uuid: 'b', ctx: 'sess-A' }]);
  });

  // The disjointness that actually holds. It is NOT "one recovery per queue
  // item": the head and a later pending entry can carry the same item (double-
  // tapping one queue row does exactly that, since mobile's dispatchSetCurrent
  // always sets shouldAddToQueue), and then both the caller-side recovery and
  // the coalescer's deferred add fire for it. The server's add is idempotent by
  // uuid, so the second one is a no-op.
  it('never recovers the head-of-burst args itself — that rejection belongs to the caller', async () => {
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      throw new Error('RATE_LIMITED');
    });
    const sendDeferredQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd });

    // No pending entry: a lone activation whose send rejects.
    await expect(coalescer.enqueue({ item: makeItem('a'), shouldAddToQueue: true })).rejects.toThrow('RATE_LIMITED');

    expect(sendDeferredQueueAdd).not.toHaveBeenCalled();
  });

  it('recovers a drained entry even when the head rejection also reaches the caller (same item)', async () => {
    const first = deferred();
    let sendCount = 0;
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {
      sendCount += 1;
      if (sendCount === 1) {
        await first.promise;
        throw new Error('RATE_LIMITED head');
      }
      throw new Error('RATE_LIMITED drain');
    });
    const sendDeferredQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd, onDrainError: () => {} });

    // Double-tapping one queue row: the same item is the burst head AND the
    // pending entry.
    const firstEnqueue = coalescer.enqueue({ item: makeItem('a'), shouldAddToQueue: true });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('a'), shouldAddToQueue: true });

    first.resolve();
    // The head's rejection still propagates, so a caller-side recovery can run.
    await expect(firstEnqueue).rejects.toThrow('RATE_LIMITED head');
    // And the drained copy is recovered here. Both paths firing for one item is
    // acceptable: the server skips a duplicate uuid.
    expect(sendDeferredQueueAdd).toHaveBeenCalledTimes(1);
  });
});

describe('createSetCurrentClimbCoalescer — F3 placement', () => {
  it('carries placement through to sendArgs', async () => {
    const sendArgs = vi.fn(async (_args: SetCurrentClimbArgs) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs });

    await coalescer.enqueue({ item: makeItem('a'), shouldAddToQueue: false, placement: 'STEP' });

    expect(sendArgs).toHaveBeenCalledWith(
      { item: makeItem('a'), shouldAddToQueue: false, placement: 'STEP' },
      undefined,
    );
  });

  it('now-slot mode: three fast opens fire no deferred add for the superseded middle one', async () => {
    const first = deferred();
    const calls: SetCurrentClimbArgs[] = [];
    const sendArgs = vi.fn(async (args: SetCurrentClimbArgs) => {
      calls.push(args);
      if (calls.length === 1) await first.promise;
    });
    const sendDeferredQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a'), shouldAddToQueue: false, placement: 'NOW' });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: false, placement: 'NOW' });
    await coalescer.enqueue({ item: makeItem('c'), shouldAddToQueue: false, placement: 'NOW' });
    first.resolve();
    await firstEnqueue;

    expect(calls.map((call) => call.item?.uuid)).toEqual(['a', 'c']);
    expect(sendDeferredQueueAdd).not.toHaveBeenCalled();
  });

  it('now-slot mode: a drained open that rejects fires no deferred add either', async () => {
    const first = deferred();
    let callCount = 0;
    const sendArgs = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) await first.promise;
      else throw new Error('RATE_LIMITED');
    });
    const sendDeferredQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const onDrainError = vi.fn();
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd, onDrainError });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a'), shouldAddToQueue: false, placement: 'NOW' });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: false, placement: 'NOW' });
    first.resolve();
    await firstEnqueue;

    expect(onDrainError).toHaveBeenCalledTimes(1);
    expect(sendDeferredQueueAdd).not.toHaveBeenCalled();
  });

  it('even an open sent with shouldAddToQueue: true and a placement fires no deferred add', async () => {
    const first = deferred();
    let callCount = 0;
    const sendArgs = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) await first.promise;
    });
    const sendDeferredQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a'), placement: 'NOW' });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true, placement: 'NOW' });
    await coalescer.enqueue({ item: makeItem('c'), placement: 'NOW' });
    first.resolve();
    await firstEnqueue;

    expect(sendDeferredQueueAdd).not.toHaveBeenCalled();
  });

  it('legacy mode keeps the old residual: a superseded queue-adding open still fires its deferred add', async () => {
    const first = deferred();
    let callCount = 0;
    const sendArgs = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) await first.promise;
    });
    const sendDeferredQueueAdd = vi.fn(async (_item: ClimbQueueItem) => {});
    const coalescer = createSetCurrentClimbCoalescer({ sendArgs, sendDeferredQueueAdd });

    const firstEnqueue = coalescer.enqueue({ item: makeItem('a'), shouldAddToQueue: true });
    await Promise.resolve();
    await coalescer.enqueue({ item: makeItem('b'), shouldAddToQueue: true });
    await coalescer.enqueue({ item: makeItem('c'), shouldAddToQueue: true });
    first.resolve();
    await firstEnqueue;

    expect(sendDeferredQueueAdd).toHaveBeenCalledTimes(1);
    expect(sendDeferredQueueAdd.mock.calls[0][0].uuid).toBe('b');
  });
});
