import { BrowserBackendConsumerError } from './browser-backend-consumer';

export type BrowserHttpOperation = Readonly<{
  /** View freshness supplies intent before a request; it is not a delivery. */
  assertView: (this: void) => void;
  /** Reserve capacity before a request may perform a network mutation. */
  beginRequest: (
    this: void,
    requestIdentity?: AbortSignal,
  ) => Readonly<{
    admit: (this: void, result: unknown) => void;
    admitError: (this: void, error: unknown) => void;
    discard: (this: void) => void;
  }>;
  /** Successful data needs a real success and every causal original delivery. */
  assertDeliveries: (this: void) => void;
  /** An error can authorize only its exact original failure, never success. */
  assertErrorDeliveries: (this: void, error: unknown) => void;
  dispose: (this: void) => void;
}>;

/** An operation never acquires a new view or looks up a newer result receipt.
 * Host I/O captures immutable delivery guards from its actual decoder. */
export function createBrowserHttpOperation(options: {
  readonly assertView: (this: void) => void;
  readonly captureDelivery: (this: void, result: unknown) => (() => void) | null;
  readonly captureErrorDelivery: (this: void, error: unknown, requestIdentity: AbortSignal) => (() => void) | null;
  readonly signal?: AbortSignal;
}): BrowserHttpOperation {
  const { assertView: assertOriginalView, captureDelivery, captureErrorDelivery, signal } = options;
  const deliveries: (() => void)[] = [];
  const errors = new Map<unknown, () => void>();
  const pending = new Set<object>();
  const usedIdentities = new WeakSet<AbortSignal>();
  let successes = 0;
  let unproven = false;
  let closed = false;
  const assertView = () => {
    if (closed || signal?.aborted) throw new BrowserBackendConsumerError('superseded');
    assertOriginalView();
  };
  const assertCausalDeliveries = () => {
    assertView();
    if (unproven || pending.size) throw new BrowserBackendConsumerError('unavailable');
    for (const assertDelivery of deliveries) assertDelivery();
    assertView();
  };
  return Object.freeze({
    assertView,
    beginRequest(requestIdentity = new AbortController().signal) {
      assertView();
      if (unproven || deliveries.length + pending.size >= 64) throw new BrowserBackendConsumerError('unavailable');
      if (usedIdentities.has(requestIdentity)) throw new BrowserBackendConsumerError('superseded');
      usedIdentities.add(requestIdentity);
      const request = Object.freeze({});
      pending.add(request);
      return Object.freeze({
        admit(result: unknown) {
          if (!pending.delete(request)) throw new BrowserBackendConsumerError('superseded');
          try {
            assertView();
            const assertDelivery = captureDelivery(result);
            if (!assertDelivery) throw new BrowserBackendConsumerError('superseded');
            assertView();
            assertDelivery();
            deliveries.push(assertDelivery);
            successes += 1;
          } catch (error) {
            unproven = true;
            throw error;
          }
        },
        admitError(error: unknown) {
          // Offering an unknown failure never changes the SDK's thrown object.
          if (!pending.delete(request)) {
            unproven = true;
            return;
          }
          try {
            assertView();
            if (errors.has(error)) throw new BrowserBackendConsumerError('superseded');
            const assertError = captureErrorDelivery(error, requestIdentity);
            if (!assertError) throw new BrowserBackendConsumerError('superseded');
            assertView();
            assertError();
            deliveries.push(assertError);
            errors.set(error, assertError);
          } catch {
            unproven = true;
          }
        },
        discard() {
          pending.delete(request);
        },
      });
    },
    assertDeliveries() {
      if (!successes) throw new BrowserBackendConsumerError('unavailable');
      assertCausalDeliveries();
    },
    assertErrorDeliveries(error: unknown) {
      if (!errors.has(error)) throw new BrowserBackendConsumerError('unavailable');
      assertCausalDeliveries();
    },
    dispose() {
      closed = true;
      successes = 0;
      deliveries.length = 0;
      errors.clear();
      pending.clear();
    },
  });
}
