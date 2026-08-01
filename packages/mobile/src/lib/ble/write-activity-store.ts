export type BleWriteActivityStore = {
  /** Register a listener for boolean busy-state edges. */
  subscribe: (listener: () => void) => () => void;
  /** Whether at least one foreground JS write request is active. */
  getSnapshot: () => boolean;
  /** Begin one write request and return its idempotent release callback. */
  begin: () => () => void;
  /** Retire every token from the previous connection generation. */
  reset: () => void;
};

type WriteToken = {
  epoch: number;
  id: symbol;
};

/**
 * A tiny external store for foreground BLE write activity.
 *
 * Tokens make overlapping and write-chain-queued requests ref-count correctly.
 * The epoch makes a generation reset safe even when an adapter ignores abort
 * long enough for an old request's `finally` to release after a new write began.
 */
export function createBleWriteActivityStore(): BleWriteActivityStore {
  const listeners = new Set<() => void>();
  const activeTokenIds = new Set<symbol>();
  let epoch = 0;

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const getSnapshot = () => activeTokenIds.size > 0;

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot,
    begin() {
      const token: WriteToken = { epoch, id: Symbol('ble-write') };
      const wasWriting = getSnapshot();
      activeTokenIds.add(token.id);
      if (!wasWriting) notify();

      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (token.epoch !== epoch) return;

        const wasActive = getSnapshot();
        activeTokenIds.delete(token.id);
        if (wasActive && !getSnapshot()) notify();
      };
    },
    reset() {
      const wasWriting = getSnapshot();
      epoch += 1;
      activeTokenIds.clear();
      if (wasWriting) notify();
    },
  };
}
