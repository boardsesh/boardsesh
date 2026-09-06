// The JS-side line for native board renders (issue #5187).
//
// The bug this module exists for: every mounted board surface handed its render
// straight to Expo's shared serial queue, and a row that scrolled away never
// took its render back. So the four properties asserted here are the whole
// point — only `maxDispatched` renders are inside native at once, the play
// board goes ahead of queued thumbnails, a request whose consumers all let go
// before dispatch is never asked for at all, and a slot is freed no matter how
// its render ended.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  requestRender,
  isRenderCancelled,
  RenderCancelledError,
  setRenderConcurrency,
  getRenderConcurrency,
  _resetRenderSchedulerForTests,
  _renderSchedulerStateForTests,
} from '../render-scheduler';

type Deferred<TValue> = {
  promise: Promise<TValue>;
  resolve: (value: TValue) => void;
  reject: (reason: unknown) => void;
};

function deferred<TValue>(): Deferred<TValue> {
  let resolve!: (value: TValue) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<TValue>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** A render the test settles by hand, plus the record of whether it was started. */
type ControlledRender = {
  settlement: Deferred<string>;
  start: () => Promise<string>;
  startCount: () => number;
};

function controlledRender(): ControlledRender {
  const settlement = deferred<string>();
  let starts = 0;
  return {
    settlement,
    start: () => {
      starts += 1;
      return settlement.promise;
    },
    startCount: () => starts,
  };
}

/** Let the scheduler's settle → pump chain run to completion. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  _resetRenderSchedulerForTests();
});

describe('dispatching under the one-render cap', () => {
  it('starts the first render on the spot and holds the second in the queue', () => {
    const first = controlledRender();
    let startedBeforeRequestReturned = false;
    requestRender('key-first', 'full', () => {
      startedBeforeRequestReturned = true;
      return first.settlement.promise;
    });
    // The whole reason dispatch is synchronous: the first render on a surface
    // must start on the same tick it always did.
    expect(startedBeforeRequestReturned).toBe(true);

    const second = controlledRender();
    requestRender('key-second', 'full', second.start);

    expect(second.startCount()).toBe(0);
    expect(_renderSchedulerStateForTests()).toEqual({
      dispatchedKeys: ['key-first'],
      queuedKeys: ['key-second'],
      maxDispatched: 1,
    });
  });

  it('dispatches the queued render as soon as the running one resolves', async () => {
    const first = controlledRender();
    const second = controlledRender();
    const firstHandle = requestRender('key-first', 'full', first.start);
    requestRender('key-second', 'full', second.start);

    first.settlement.resolve('file:///first.png');
    await expect(firstHandle.promise).resolves.toBe('file:///first.png');

    expect(second.startCount()).toBe(1);
    expect(_renderSchedulerStateForTests()).toMatchObject({
      dispatchedKeys: ['key-second'],
      queuedKeys: [],
    });
  });

  it('frees the slot when the running render rejects, not only when it succeeds', async () => {
    const failing = controlledRender();
    const next = controlledRender();
    const failingHandle = requestRender('key-failing', 'full', failing.start);
    requestRender('key-next', 'full', next.start);

    failing.settlement.reject(new Error('Rust render failed with code -2'));
    await expect(failingHandle.promise).rejects.toThrow('Rust render failed with code -2');

    expect(next.startCount()).toBe(1);
    expect(_renderSchedulerStateForTests().dispatchedKeys).toEqual(['key-next']);
  });

  it('rejects and frees the slot when start throws synchronously', async () => {
    const next = controlledRender();
    const throwingHandle = requestRender('key-throwing', 'full', () => {
      throw new Error('renderHoldsOverlay is not a function');
    });
    requestRender('key-next', 'full', next.start);

    await expect(throwingHandle.promise).rejects.toThrow('renderHoldsOverlay is not a function');

    // Without this the scheduler would hold its only slot for the rest of the
    // JS lifetime and no board would ever draw again.
    expect(next.startCount()).toBe(1);
    expect(_renderSchedulerStateForTests().dispatchedKeys).toEqual(['key-next']);
  });

  // A native module method that hands back a bare string rather than a promise
  // (an older binary, a web shim) would blow up on `.then` and wedge the only
  // slot for the rest of the JS lifetime — every board on the device, blank.
  it('resolves a start that returns a plain value instead of a promise', async () => {
    const nonThenableHandle = requestRender(
      'key-non-thenable',
      'full',
      () => 'file:///non-thenable.png' as unknown as Promise<string>,
    );
    const queued = controlledRender();
    requestRender('key-queued', 'full', queued.start);
    expect(queued.startCount()).toBe(0);

    await expect(nonThenableHandle.promise).resolves.toBe('file:///non-thenable.png');

    expect(queued.startCount()).toBe(1);
    expect(_renderSchedulerStateForTests().dispatchedKeys).toEqual(['key-queued']);

    queued.settlement.resolve('file:///queued.png');
    await flushMicrotasks();
    expect(_renderSchedulerStateForTests().dispatchedKeys).toEqual([]);
  });
});

describe('joining one request per cache key', () => {
  it('starts one render for two consumers and hands both the same result', async () => {
    const shared = controlledRender();
    const firstConsumer = requestRender('key-shared', 'thumbnail', shared.start);
    const secondConsumer = requestRender('key-shared', 'thumbnail', shared.start);

    expect(shared.startCount()).toBe(1);

    shared.settlement.resolve('file:///shared.png');
    await expect(firstConsumer.promise).resolves.toBe('file:///shared.png');
    await expect(secondConsumer.promise).resolves.toBe('file:///shared.png');
    expect(shared.startCount()).toBe(1);
  });
});

describe('withdrawing a request that has not been dispatched', () => {
  it('never asks for a queued render whose last consumer let go', async () => {
    const running = controlledRender();
    const abandoned = controlledRender();
    requestRender('key-running', 'full', running.start);
    const abandonedHandle = requestRender('key-abandoned', 'full', abandoned.start);

    abandonedHandle.release();

    await expect(abandonedHandle.promise).rejects.toBeInstanceOf(RenderCancelledError);
    await abandonedHandle.promise.catch((error: unknown) => {
      expect(isRenderCancelled(error)).toBe(true);
    });
    expect(_renderSchedulerStateForTests().queuedKeys).toEqual([]);

    // …and it stays unasked once the slot frees up. This is the scroll-away
    // row whose render used to run anyway, ahead of the play board.
    running.settlement.resolve('file:///running.png');
    await flushMicrotasks();
    expect(abandoned.startCount()).toBe(0);
  });

  it('keeps a queued request alive while another consumer still wants it', async () => {
    const running = controlledRender();
    const shared = controlledRender();
    requestRender('key-running', 'full', running.start);
    const leavingConsumer = requestRender('key-shared', 'full', shared.start);
    const stayingConsumer = requestRender('key-shared', 'full', shared.start);

    leavingConsumer.release();
    // Idempotent: a second release from the same consumer must not take the
    // other consumer's claim with it (a hook effect cleanup can run twice).
    leavingConsumer.release();

    expect(_renderSchedulerStateForTests().queuedKeys).toEqual(['key-shared']);

    running.settlement.resolve('file:///running.png');
    await flushMicrotasks();
    expect(shared.startCount()).toBe(1);
    shared.settlement.resolve('file:///shared.png');
    await expect(stayingConsumer.promise).resolves.toBe('file:///shared.png');
  });

  it('lets a dispatched render finish even after its consumer releases it', async () => {
    const running = controlledRender();
    const runningHandle = requestRender('key-running', 'play', running.start);

    runningHandle.release();

    // Native cannot be cancelled, so the result still lands — and is cached for
    // the next visit rather than thrown away.
    running.settlement.resolve('file:///running.png');
    await expect(runningHandle.promise).resolves.toBe('file:///running.png');
  });

  // Vitest fails the run on an unhandled rejection, so the assertion here is
  // the test passing at all: the scheduler attaches its own no-op catch, and
  // nothing below ever attaches one.
  it('does not surface a cancelled request as an unhandled rejection', async () => {
    const running = controlledRender();
    const abandoned = controlledRender();
    requestRender('key-running', 'full', running.start);
    const abandonedHandle = requestRender('key-abandoned', 'thumbnail', abandoned.start);

    abandonedHandle.release();
    await flushMicrotasks();

    expect(abandoned.startCount()).toBe(0);
  });
});

describe('ordering the queue', () => {
  it('draws the play board first, then full surfaces, then thumbnails in arrival order', async () => {
    const occupant = controlledRender();
    const firstThumbnail = controlledRender();
    const fullSurface = controlledRender();
    const secondThumbnail = controlledRender();
    const playBoard = controlledRender();
    const occupantHandle = requestRender('key-occupant', 'full', occupant.start);
    requestRender('key-thumbnail-first', 'thumbnail', firstThumbnail.start);
    requestRender('key-full', 'full', fullSurface.start);
    requestRender('key-thumbnail-second', 'thumbnail', secondThumbnail.start);
    requestRender('key-play', 'play', playBoard.start);

    const dispatchOrder: string[] = [];
    const settleAndRecord = async (render: ControlledRender, uri: string) => {
      render.settlement.resolve(uri);
      await flushMicrotasks();
      dispatchOrder.push(..._renderSchedulerStateForTests().dispatchedKeys);
    };

    await settleAndRecord(occupant, 'file:///occupant.png');
    await settleAndRecord(playBoard, 'file:///play.png');
    await settleAndRecord(fullSurface, 'file:///full.png');
    await settleAndRecord(firstThumbnail, 'file:///thumbnail-first.png');

    // FIFO inside a level, not LIFO: FlashList's newest rows are the
    // below-viewport prefetch rows, so newest-first would draw the wrong ones.
    expect(dispatchOrder).toEqual(['key-play', 'key-full', 'key-thumbnail-first', 'key-thumbnail-second']);
    await expect(occupantHandle.promise).resolves.toBe('file:///occupant.png');
  });

  it('promotes a queued full surface that becomes the play board, and never demotes it again', async () => {
    const occupant = controlledRender();
    const olderFull = controlledRender();
    const peekBecomingPlay = controlledRender();
    const occupantHandle = requestRender('key-occupant', 'full', occupant.start);
    requestRender('key-older-full', 'full', olderFull.start);
    requestRender('key-peek', 'full', peekBecomingPlay.start);

    // The carousel commits: the same key is now the board the climber is
    // looking at, so a second consumer asks for it as `play`.
    const playConsumer = requestRender('key-peek', 'play', peekBecomingPlay.start);
    // …and swipes on, releasing that consumer while the peek row stays mounted.
    playConsumer.release();

    occupant.settlement.resolve('file:///occupant.png');
    await expect(occupantHandle.promise).resolves.toBe('file:///occupant.png');

    expect(_renderSchedulerStateForTests()).toMatchObject({
      dispatchedKeys: ['key-peek'],
      queuedKeys: ['key-older-full'],
    });
    expect(olderFull.startCount()).toBe(0);
  });
});

describe('the dispatch window', () => {
  it('lets a second queued render through the moment the window widens', async () => {
    const first = controlledRender();
    const second = controlledRender();
    requestRender('key-first', 'full', first.start);
    requestRender('key-second', 'full', second.start);
    expect(second.startCount()).toBe(0);

    setRenderConcurrency(2);

    expect(second.startCount()).toBe(1);
    expect(getRenderConcurrency()).toBe(2);
    expect(_renderSchedulerStateForTests()).toMatchObject({
      dispatchedKeys: ['key-first', 'key-second'],
      queuedKeys: [],
    });
  });

  it('clamps a bad constant instead of letting it turn the queue back off', () => {
    setRenderConcurrency(0);
    expect(getRenderConcurrency()).toBe(1);

    setRenderConcurrency(-5);
    expect(getRenderConcurrency()).toBe(1);

    setRenderConcurrency(99);
    expect(getRenderConcurrency()).toBe(4);

    setRenderConcurrency(2.9);
    expect(getRenderConcurrency()).toBe(2);
  });

  it('ignores a non-finite report rather than adopting it', () => {
    setRenderConcurrency(3);
    setRenderConcurrency(Number.NaN);
    expect(getRenderConcurrency()).toBe(3);

    setRenderConcurrency(Number.POSITIVE_INFINITY);
    expect(getRenderConcurrency()).toBe(3);
  });
});

describe('a settle that arrives after a reset', () => {
  it('leaves the request that came after the reset dispatched and counted once', async () => {
    const beforeReset = controlledRender();
    requestRender('key-before-reset', 'play', beforeReset.start);

    _resetRenderSchedulerForTests();

    const afterReset = controlledRender();
    const afterResetHandle = requestRender('key-after-reset', 'play', afterReset.start);
    expect(afterReset.startCount()).toBe(1);

    // The forgotten render finally answers. It must not delete the new entry or
    // free a slot it no longer owns.
    beforeReset.settlement.resolve('file:///before-reset.png');
    await flushMicrotasks();

    expect(_renderSchedulerStateForTests()).toEqual({
      dispatchedKeys: ['key-after-reset'],
      queuedKeys: [],
      maxDispatched: 1,
    });
    expect(afterResetHandle.snapshot().dispatchedCount).toBe(1);

    afterReset.settlement.resolve('file:///after-reset.png');
    await expect(afterResetHandle.promise).resolves.toBe('file:///after-reset.png');
    expect(_renderSchedulerStateForTests().dispatchedKeys).toEqual([]);
  });
});

describe('the snapshot the stall telemetry reads', () => {
  it('separates a render inside native from one still waiting in the queue', () => {
    const running = controlledRender();
    const waiting = controlledRender();
    const runningHandle = requestRender('key-running', 'play', running.start);
    const waitingHandle = requestRender('key-waiting', 'play', waiting.start);

    const runningSnapshot = runningHandle.snapshot();
    expect(runningSnapshot.state).toBe('dispatched');
    expect(runningSnapshot.dispatchedCount).toBe(1);
    expect(runningSnapshot.msWaiting).toBeGreaterThanOrEqual(0);

    const waitingSnapshot = waitingHandle.snapshot();
    expect(waitingSnapshot.state).toBe('queued');
    expect(waitingSnapshot.queueDepth).toBeGreaterThanOrEqual(1);
    expect(waitingSnapshot.dispatchedCount).toBe(1);
    expect(waitingSnapshot.msWaiting).toBeGreaterThanOrEqual(0);
  });
});
