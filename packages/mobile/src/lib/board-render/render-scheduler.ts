/**
 * The JS-side line for native board renders (issue #5187).
 *
 * Every Expo `AsyncFunction` without its own queue runs on ONE shared serial
 * queue per platform (`expo.modules.AsyncFunctionQueue` on iOS, a single
 * HandlerThread on Android), and `renderHoldsOverlay` is one of them. Before
 * this module, every mounted board surface — the play board, the carousel's
 * peek, and every list thumbnail — handed its render to native the moment it
 * mounted, and a row that scrolled away never took its render back. A fast
 * scroll through unseen climbs therefore queued one native render per row,
 * and the play board a climber then opened waited behind all of them. Low
 * Power Mode lowers the CPU clock, which stretched that line from "a second"
 * to "the holds never seem to come"; nothing measured it, because the only
 * render telemetry starts once the overlay `<Image>` mounts.
 *
 * So renders now wait HERE, where they can be ordered and withdrawn, and only
 * `maxDispatched` of them are inside native at a time:
 *
 * - `play` before `full` before `thumbnail`, FIFO within a level. Not LIFO for
 *   thumbnails: the queue only ever holds requests from currently mounted
 *   instances (each hook instance holds at most one undispatched request, and
 *   releases it when its key moves on), and FlashList's most recently mounted
 *   rows are the below-viewport prefetch rows, so newest-first would draw
 *   those before the rows the climber is looking at.
 * - A request whose last consumer releases it before dispatch is dropped and
 *   its `start` closure freed — the render is never asked for. A request
 *   already inside native runs to completion regardless (native cannot be
 *   cancelled) and its result still lands in the overlay index for the next
 *   visit.
 * - Priority upgrades are sticky. The real case is the carousel: a neighbour's
 *   overlay is requested as `full` while it peeks, then the same key becomes
 *   the `play` board on commit; a release never downgrades.
 * - Dispatch is synchronous when a slot is free, so the first render on a
 *   surface starts on the same tick it always did; only requests past the cap
 *   wait. Invariant: the queue is non-empty only while every slot is taken.
 *
 * Pure TypeScript, no React, generic over the result — this module knows
 * nothing about overlay files or the native module, so it can sit below the
 * hook without a cycle.
 */

export type RenderPriority = 'play' | 'full' | 'thumbnail';

/** Where a request is waiting; the discriminator the stall telemetry reports. */
export type RenderStallState = 'queued' | 'dispatched';

export type RenderQueueSnapshot = {
  /** Whether this request is still in our queue or already inside native. */
  state: RenderStallState;
  /** Requests waiting in the queue, this one included when it is queued. */
  queueDepth: number;
  /** Requests handed to native and not yet answered. */
  dispatchedCount: number;
  /** Milliseconds since this request was first asked for. */
  msWaiting: number;
};

export type RenderRequestHandle<T> = {
  promise: Promise<T>;
  /**
   * This consumer no longer wants the result. Idempotent. When the last
   * consumer of a QUEUED request releases it, the request is dropped and the
   * promise rejects with `RenderCancelledError`.
   */
  release: () => void;
  /** Read the request's position for telemetry; cheap and side-effect free. */
  snapshot: () => RenderQueueSnapshot;
};

/**
 * The rejection a consumer sees when it (or a sibling consumer) released a
 * queued request. Never a failure: the render was not attempted. Consumers
 * check `isRenderCancelled` FIRST in their catch, before any logging or
 * telemetry.
 */
export class RenderCancelledError extends Error {
  constructor(key: string) {
    super(`render cancelled before dispatch: ${key}`);
    this.name = 'RenderCancelledError';
  }
}

export function isRenderCancelled(error: unknown): error is RenderCancelledError {
  return error instanceof RenderCancelledError;
}

/**
 * Native renders outstanding at once. Today's store binaries run
 * `renderHoldsOverlay` on Expo's shared SERIAL queue, so a second dispatched
 * render only ever waits behind the first inside native — and a play board
 * that arrives while two thumbnails are dispatched waits behind both. One slot
 * keeps the play board's worst case at a single thumbnail; the cost is one JS
 * round-trip of idle native time between renders (tens of milliseconds at
 * most, and less than a thumbnail render). A binary whose renderer runs on its
 * own concurrent queue raises this through `setRenderConcurrency` (the module
 * reports its `renderConcurrency` constant).
 */
const DEFAULT_MAX_DISPATCHED = 1;
const MAX_DISPATCHED_CEILING = 4;

const PRIORITY_RANK: Record<RenderPriority, number> = { play: 0, full: 1, thumbnail: 2 };

type RenderRequest<T> = {
  key: string;
  priority: RenderPriority;
  /** Arrival order; the FIFO tiebreaker inside a priority level. */
  sequence: number;
  requestedAtMs: number;
  consumers: number;
  /** Nulled on dispatch and on cancel so the config closure is not retained. */
  start: (() => Promise<T>) | null;
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

// One request per key, whether queued or dispatched. `unknown` because the
// scheduler is generic per call; a key always maps back to the type its first
// caller used (the hook only ever renders overlay entries).
const requests = new Map<string, RenderRequest<unknown>>();
const queued: RenderRequest<unknown>[] = [];
const dispatched = new Map<string, RenderRequest<unknown>>();
let maxDispatched = DEFAULT_MAX_DISPATCHED;
let nextSequence = 0;

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Raise (or lower) how many renders may be inside native at once. Called once
 * the native module reports what its queue can take; clamped so a bad constant
 * cannot turn the scheduler back into "everything at once".
 */
export function setRenderConcurrency(concurrency: number): void {
  if (!Number.isFinite(concurrency)) return;
  maxDispatched = Math.min(MAX_DISPATCHED_CEILING, Math.max(1, Math.floor(concurrency)));
  pump();
}

export function getRenderConcurrency(): number {
  return maxDispatched;
}

/** The queued request that should go next: lowest priority rank, then oldest. */
function takeNextQueued(): RenderRequest<unknown> | undefined {
  if (queued.length === 0) return undefined;
  let bestIndex = 0;
  for (let index = 1; index < queued.length; index += 1) {
    const candidate = queued[index];
    const best = queued[bestIndex];
    const candidateRank = PRIORITY_RANK[candidate.priority];
    const bestRank = PRIORITY_RANK[best.priority];
    if (candidateRank < bestRank || (candidateRank === bestRank && candidate.sequence < best.sequence)) {
      bestIndex = index;
    }
  }
  return queued.splice(bestIndex, 1)[0];
}

function settle(request: RenderRequest<unknown>): void {
  // Guarded exactly like `getOrStartInflightRender`: a settle that arrives
  // after a test reset (or after the key was re-requested fresh) must not
  // remove the newer request or free a slot it does not own.
  if (dispatched.get(request.key) === request) dispatched.delete(request.key);
  if (requests.get(request.key) === request) requests.delete(request.key);
  pump();
}

function dispatch(request: RenderRequest<unknown>): void {
  const start = request.start;
  request.start = null;
  dispatched.set(request.key, request);
  let started: Promise<unknown>;
  try {
    // A `start` that throws synchronously (a native module method that is not
    // a function, a JSON.stringify that blows up) must still free the slot, or
    // the scheduler stalls for the rest of the JS lifetime.
    started = start ? start() : Promise.reject(new Error('render request has no start'));
  } catch (error) {
    started = Promise.reject(error);
  }
  started.then(
    (value) => {
      settle(request);
      request.resolve(value);
    },
    (error: unknown) => {
      settle(request);
      request.reject(error);
    },
  );
}

/** Fill free slots from the queue. Synchronous; never defers to a timer. */
function pump(): void {
  while (dispatched.size < maxDispatched) {
    const next = takeNextQueued();
    if (!next) return;
    dispatch(next);
  }
}

/**
 * Ask for the render behind `key`, joining an existing request for the same
 * key if there is one. `start` is only ever called once per request, and only
 * when a slot is free; a request released by all its consumers before then
 * never calls it.
 */
export function requestRender<T>(
  key: string,
  priority: RenderPriority,
  start: () => Promise<T>,
): RenderRequestHandle<T> {
  let request = requests.get(key) as RenderRequest<T> | undefined;
  if (!request) {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // The scheduler's own handler, so a request every consumer released (and
    // therefore nobody is listening to) cannot surface as an unhandled
    // rejection. Consumers still observe rejections through `promise`.
    promise.catch(() => {});
    request = {
      key,
      priority,
      sequence: nextSequence++,
      requestedAtMs: nowMs(),
      consumers: 0,
      start,
      promise,
      resolve,
      reject,
    };
    requests.set(key, request as RenderRequest<unknown>);
    if (dispatched.size < maxDispatched) {
      dispatch(request as RenderRequest<unknown>);
    } else {
      queued.push(request as RenderRequest<unknown>);
    }
  } else if (PRIORITY_RANK[priority] < PRIORITY_RANK[request.priority]) {
    // Sticky upgrade: the peek that became the play board. Selection scans the
    // queue on every dispatch, so nothing needs re-sorting here.
    request.priority = priority;
  }
  const joined = request;
  joined.consumers += 1;
  let released = false;
  return {
    promise: joined.promise,
    release: () => {
      if (released) return;
      released = true;
      joined.consumers -= 1;
      if (joined.consumers > 0) return;
      // Only an undispatched request can be withdrawn. `start` still being
      // set is exactly "not dispatched": dispatch nulls it first thing.
      if (joined.start === null) return;
      const queueIndex = queued.indexOf(joined as RenderRequest<unknown>);
      if (queueIndex !== -1) queued.splice(queueIndex, 1);
      if (requests.get(key) === (joined as RenderRequest<unknown>)) requests.delete(key);
      joined.start = null;
      joined.reject(new RenderCancelledError(key));
    },
    snapshot: () => ({
      state: dispatched.get(key) === (joined as RenderRequest<unknown>) ? 'dispatched' : 'queued',
      queueDepth: queued.length,
      dispatchedCount: dispatched.size,
      msWaiting: Math.max(0, Math.round(nowMs() - joined.requestedAtMs)),
    }),
  };
}

/** Test-only: forget every request. Late settles of dropped requests are ignored. */
export function _resetRenderSchedulerForTests(): void {
  requests.clear();
  queued.length = 0;
  dispatched.clear();
  maxDispatched = DEFAULT_MAX_DISPATCHED;
  nextSequence = 0;
}

/** Test-only: the scheduler's current shape. */
export function _renderSchedulerStateForTests(): {
  queuedKeys: string[];
  dispatchedKeys: string[];
  maxDispatched: number;
} {
  return {
    queuedKeys: queued.map((request) => request.key),
    dispatchedKeys: [...dispatched.keys()],
    maxDispatched,
  };
}
