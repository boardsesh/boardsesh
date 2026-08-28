/**
 * Primitives for the tests that drive two database transactions against each
 * other on purpose — board merges racing a follow, a serial choice racing a
 * tombstone. Shared by board-merge-tombstone.test.ts and board-presence.test.ts,
 * and pinned by deferred-rejection.test.ts.
 */

/** A promise plus the handle that resolves it, so one side can gate the other. */
export function createBarrier(): { promise: Promise<void>; release: () => void } {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** `createBarrier` that also carries a value across — usually a backend PID. */
export function createValueBarrier<Result>(): { promise: Promise<Result>; release: (result: Result) => void } {
  let release = (_result: Result): void => undefined;
  const promise = new Promise<Result>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * Attach an inert rejection handler to a promise the caller asserts on later.
 *
 * These tests deliberately leave a promise in flight across several `await`s.
 * If it rejects during one of them, Node reaches its unhandled-rejection
 * checkpoint before the assertion further down can attach a handler — vitest
 * counts that under `Errors` and exits 1 with every test still passing
 * (issue #4488, main run 31880202330).
 *
 * The promise itself is untouched: still rejected, still assertable. The
 * `await expect(...).rejects.toThrow(...)` or bare `await` below still runs,
 * still sees the same rejection, and still fails on the wrong error — so this
 * cannot hide a defect. Its contract is pinned in deferred-rejection.test.ts.
 */
export function handleLater(promise: Promise<unknown>): void {
  void promise.catch((): void => undefined);
}
