import { describe, expect, it, vi } from 'vitest';
import { createBrowserHttpOperation } from '../browser-backend-http-operation';

function fixture() {
  let view = 1;
  let clock = 0;
  const originalView = view;
  const receipts = new WeakMap<object, { deadline: number }>();
  const capture = vi.fn((result: unknown) => {
    if (result === null || typeof result !== 'object') return null;
    const original = receipts.get(result);
    if (!original) return null;
    return () => {
      if (clock >= original.deadline) throw new Error('Original delivery expired');
    };
  });
  const errorReceipts = new WeakMap<object, { deadline: number; requestIdentity: AbortSignal }>();
  const captureError = vi.fn((error: unknown, requestIdentity: AbortSignal) => {
    if (error === null || typeof error !== 'object') return null;
    const original = errorReceipts.get(error);
    if (!original || original.requestIdentity !== requestIdentity) return null;
    return () => {
      if (clock >= original.deadline) throw new Error('Original error expired');
    };
  });
  const controller = new AbortController();
  const options = {
    assertView: () => {
      if (view !== originalView) throw new Error('Original view retired');
    },
    captureDelivery: capture,
    captureErrorDelivery: captureError,
    signal: controller.signal,
  };
  const operation = createBrowserHttpOperation(options);
  return {
    operation,
    controller,
    options,
    capture,
    captureError,
    deliverError(requestIdentity: AbortSignal, deadline = 100) {
      const error = new Error('Owned synthetic server rejection');
      errorReceipts.set(error, { deadline, requestIdentity });
      return error;
    },
    relabelError(error: object, requestIdentity: AbortSignal, deadline: number) {
      errorReceipts.set(error, { deadline, requestIdentity });
    },
    setClock: (milliseconds: number) => (clock = milliseconds),
    retire: () => view++,
    deliver(deadline = 100) {
      const result = { owned: 'synthetic decoded SDK result' };
      receipts.set(result, { deadline });
      return result;
    },
    relabel(result: object, deadline: number) {
      receipts.set(result, { deadline });
    },
  };
}

describe('original browser HTTP operation lifetime', () => {
  it('does not treat a current view as a completed network delivery', () => {
    const { operation } = fixture();
    expect(() => operation.assertView()).not.toThrow();
    expect(() => operation.assertDeliveries()).toThrow();
  });
  it('retains every original delivery through later awaits and same-object relabeling', async () => {
    const current = fixture();
    const first = current.deliver(100);
    current.operation.beginRequest().admit(first);
    current.relabel(first, 200);
    current.operation.beginRequest().admit(current.deliver(200));
    await Promise.resolve();
    current.setClock(100);
    expect(() => current.operation.assertView()).not.toThrow();
    expect(() => current.operation.assertDeliveries()).toThrow('Original delivery expired');
  });
  it('refuses copied results without granting delivery authority', () => {
    const current = fixture();
    const result = current.deliver();
    expect(() => current.operation.beginRequest().admit({ ...result })).toThrow();
    expect(() => current.operation.assertDeliveries()).toThrow();
  });
  it('an unfinished second request cannot qualify the operation through the first result', () => {
    const current = fixture();
    current.operation.beginRequest().admit(current.deliver());
    const pending = current.operation.beginRequest();
    expect(() => current.operation.assertDeliveries()).toThrow();
    pending.admit(current.deliver());
    expect(() => current.operation.assertDeliveries()).not.toThrow();
  });
  it('reserves bounded capacity before concurrent requests may send', () => {
    const current = fixture();
    const pending = Array.from({ length: 64 }, () => current.operation.beginRequest());
    expect(() => current.operation.beginRequest()).toThrow();
    pending[0].discard();
    const replacement = current.operation.beginRequest();
    expect(() => current.operation.beginRequest()).toThrow();
    pending.slice(1).forEach((request) => request.discard());
    replacement.admit(current.deliver());
    expect(() => current.operation.assertDeliveries()).not.toThrow();
  });
  it('cannot admit a discarded or already completed request again', () => {
    const current = fixture();
    const request = current.operation.beginRequest();
    request.admit(current.deliver());
    expect(() => request.admit(current.deliver())).toThrow();
    const discarded = current.operation.beginRequest();
    discarded.discard();
    expect(() => discarded.admit(current.deliver())).toThrow();
    expect(() => current.operation.assertDeliveries()).not.toThrow();
  });
  it.each(['view', 'abort', 'dispose'] as const)('%s retirement refuses pending and delivered work', (change) => {
    const current = fixture();
    current.operation.beginRequest().admit(current.deliver());
    const pending = current.operation.beginRequest();
    if (change === 'view') current.retire();
    else if (change === 'abort') current.controller.abort();
    else current.operation.dispose();
    expect(() => current.operation.assertView()).toThrow();
    expect(() => current.operation.assertDeliveries()).toThrow();
    expect(() => pending.admit(current.deliver())).toThrow();
    expect(() => current.operation.beginRequest()).toThrow();
  });
  it('captures the constructor signal instead of adopting a replacement', () => {
    const current = fixture();
    current.options.assertView = () => {};
    current.options.captureDelivery = vi.fn(() => () => {});
    current.options.signal = new AbortController().signal;
    current.controller.abort();
    expect(() => current.operation.beginRequest()).toThrow();
    expect(current.options.captureDelivery).not.toHaveBeenCalled();
  });
  it('captures constructor callbacks instead of a later caller-supplied approval', () => {
    const current = fixture();
    current.options.captureDelivery = vi.fn(() => () => {});
    expect(() => current.operation.beginRequest().admit({ claimed: 'unobserved result' })).toThrow();
    expect(current.options.captureDelivery).not.toHaveBeenCalled();
    current.options.assertView = () => {};
    current.retire();
    expect(() => current.operation.beginRequest()).toThrow('Original view retired');
  });
});

describe('separate original HTTP error delivery lifetime', () => {
  it('requires the exact admitted error and never substitutes partial error data for success', () => {
    const current = fixture();
    const signal = new AbortController().signal;
    const error = current.deliverError(signal);
    current.operation.beginRequest(signal).admitError(error);
    expect(() => current.operation.assertErrorDeliveries(error)).not.toThrow();
    expect(() => current.operation.assertErrorDeliveries(new Error(error.message))).toThrow();
    expect(() => current.operation.assertDeliveries()).toThrow();
  });
  it('checks every original successful and failed delivery across a compatibility fallback', () => {
    const current = fixture();
    const signal = new AbortController().signal;
    const error = current.deliverError(signal);
    current.operation.beginRequest(signal).admitError(error);
    current.operation.beginRequest().admit(current.deliver(200));
    expect(() => current.operation.assertDeliveries()).not.toThrow();
    expect(() => current.operation.assertErrorDeliveries(error)).not.toThrow();
    current.relabelError(error, signal, 300);
    current.setClock(100);
    expect(() => current.operation.assertDeliveries()).toThrow('Original error expired');
    expect(() => current.operation.assertErrorDeliveries(error)).toThrow('Original error expired');
  });
  it('cannot replay an earlier authentic error into a later reservation', () => {
    const current = fixture();
    const firstSignal = new AbortController().signal;
    const error = current.deliverError(firstSignal);
    current.operation.beginRequest(firstSignal).admitError(error);
    current.operation.beginRequest(new AbortController().signal).admitError(error);
    expect(() => current.operation.assertErrorDeliveries(error)).toThrow();
    expect(() => current.operation.assertDeliveries()).toThrow();
  });
  it('poisons all delivery qualification after an unproven failure without rewriting that error', () => {
    const current = fixture();
    current.operation.beginRequest().admit(current.deliver());
    const unknown = new Error('Owned transport failure');
    current.operation.beginRequest().admitError(unknown);
    expect(() => current.operation.assertDeliveries()).toThrow();
    expect(() => current.operation.assertErrorDeliveries(unknown)).toThrow();
    expect(() => current.operation.beginRequest()).toThrow();
  });
  it('uses one 64-slot budget for mixed errors, successes and in-flight reservations', () => {
    const current = fixture();
    for (let index = 0; index < 32; index++) {
      const signal = new AbortController().signal;
      current.operation.beginRequest(signal).admitError(current.deliverError(signal));
    }
    for (let index = 0; index < 31; index++) current.operation.beginRequest().admit(current.deliver());
    const pending = current.operation.beginRequest();
    expect(() => current.operation.beginRequest()).toThrow();
    expect(() => current.operation.assertDeliveries()).toThrow();
    pending.discard();
    current.operation.beginRequest().admit(current.deliver());
    expect(() => current.operation.assertDeliveries()).not.toThrow();
    expect(() => current.operation.beginRequest()).toThrow();
  });
  it.each(['view', 'abort', 'dispose'] as const)('retires exact admitted errors after %s', (change) => {
    const current = fixture();
    const signal = new AbortController().signal;
    const error = current.deliverError(signal);
    current.operation.beginRequest(signal).admitError(error);
    if (change === 'view') current.retire();
    else if (change === 'abort') current.controller.abort();
    else current.operation.dispose();
    expect(() => current.operation.assertErrorDeliveries(error)).toThrow();
    expect(() => current.operation.assertDeliveries()).toThrow();
  });
  it('refuses repeated invocation signals and snapshots the original error-capture callback', () => {
    const current = fixture();
    const signal = new AbortController().signal;
    current.operation.beginRequest(signal).discard();
    expect(() => current.operation.beginRequest(signal)).toThrow();
    current.options.captureErrorDelivery = vi.fn(() => () => {});
    const error = new Error('Unobserved');
    current.operation.beginRequest().admitError(error);
    expect(current.options.captureErrorDelivery).not.toHaveBeenCalled();
    expect(() => current.operation.assertErrorDeliveries(error)).toThrow();
  });
});
