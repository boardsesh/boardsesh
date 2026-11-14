import { BrowserBackendConsumerError } from './browser-backend-consumer';

export type BrowserHttpOperation = Readonly<{
  /** View freshness supplies intent before a request; it is not a delivery. */
  assertView: (this: void) => void;
  /** Reserve capacity before a request may perform a network mutation. */
  beginRequest: (this: void) => Readonly<{
    admit: (this: void, result: unknown) => void;
    discard: (this: void) => void;
  }>;
  /** After every caller-owned await, recheck every original network delivery. */
  assertDeliveries: (this: void) => void;
  dispose: (this: void) => void;
}>;

/** An operation never acquires a new view or looks up a newer result receipt.
 * Host I/O must capture immutable delivery guards from its actual decoder. */
export function createBrowserHttpOperation(options: {
  readonly assertView: (this: void) => void;
  readonly captureDelivery: (this: void, result: unknown) => (() => void) | null;
  readonly signal?: AbortSignal;
}): BrowserHttpOperation {
  const { assertView: assertOriginalView, captureDelivery, signal } = options;
  const deliveries: (() => void)[] = [];
  const pending = new Set<object>();
  let closed = false;
  const assertView = () => {
    if (closed || signal?.aborted) throw new BrowserBackendConsumerError('superseded');
    assertOriginalView();
  };
  return Object.freeze({
    assertView,
    beginRequest() {
      assertView();
      if (deliveries.length + pending.size >= 64) throw new BrowserBackendConsumerError('unavailable');
      const request = Object.freeze({});
      pending.add(request);
      return Object.freeze({
        admit(result: unknown) {
          if (!pending.delete(request)) throw new BrowserBackendConsumerError('superseded');
          assertView();
          const assertDelivery = captureDelivery(result);
          if (!assertDelivery) throw new BrowserBackendConsumerError('superseded');
          assertView();
          assertDelivery();
          deliveries.push(assertDelivery);
        },
        discard() {
          pending.delete(request);
        },
      });
    },
    assertDeliveries() {
      assertView();
      if (!deliveries.length || pending.size) throw new BrowserBackendConsumerError('unavailable');
      for (const assertDelivery of deliveries) assertDelivery();
      assertView();
    },
    dispose() {
      closed = true;
      deliveries.length = 0;
      pending.clear();
    },
  });
}
