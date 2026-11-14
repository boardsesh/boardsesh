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
  const controller = new AbortController();
  const options = {
    assertView: () => {
      if (view !== originalView) throw new Error('Original view retired');
    },
    captureDelivery: capture,
    signal: controller.signal,
  };
  const operation = createBrowserHttpOperation(options);
  return {
    operation,
    controller,
    options,
    capture,
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
