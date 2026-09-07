import { describe, it, expect } from 'vite-plus/test';
import type { CncOrderStatus } from '@boardsesh/shared-schema';
import {
  MAX_CONSECUTIVE_NULL_POLLS,
  ORDER_POLL_INTERVAL_MS,
  nextOrderPollInterval,
  orderRefetchInterval,
} from '../use-cnc-order-poll';

/**
 * The poll decision, asserted against the pure functions rather than around a
 * mounted component: "does polling actually stop at `preview_ready`" is the
 * question worth a test, and timers around React give a slower, flakier answer
 * to it.
 */

describe('orderRefetchInterval', () => {
  it('keeps polling while a preview or a pack is still being made', () => {
    for (const status of [
      'preview_queued',
      'preview_generating',
      'pending_payment',
      'queued',
      'generating',
    ] satisfies CncOrderStatus[]) {
      expect({ status, interval: orderRefetchInterval(status) }).toEqual({
        status,
        interval: ORDER_POLL_INTERVAL_MS,
      });
    }
  });

  it('stops at preview_ready, because the next move is the buyer’s', () => {
    // A free preview that is drawn will not change again until somebody
    // finalises it. Polling it is the same waste as polling a finished pack.
    expect(orderRefetchInterval('preview_ready')).toBe(false);
  });

  it('stops on every other settled status too', () => {
    for (const status of ['preview_failed', 'ready', 'failed', 'cancelled', 'refunded'] satisfies CncOrderStatus[]) {
      expect({ status, interval: orderRefetchInterval(status) }).toEqual({ status, interval: false });
    }
  });
});

describe('nextOrderPollInterval', () => {
  it('does not stop on a transient null — it polls the last known status', () => {
    // `cncOrder` answers null for a blip as well as for a revoked licence.
    // Reading `false` out of that would settle the page forever on a preview
    // that is still being drawn.
    for (let nullPolls = 0; nullPolls < MAX_CONSECUTIVE_NULL_POLLS; nullPolls += 1) {
      expect({ nullPolls, interval: nextOrderPollInterval('preview_generating', nullPolls) }).toEqual({
        nullPolls,
        interval: ORDER_POLL_INTERVAL_MS,
      });
    }
  });

  it('gives up after enough nulls in a row', () => {
    expect(nextOrderPollInterval('generating', MAX_CONSECUTIVE_NULL_POLLS)).toBe(false);
    expect(nextOrderPollInterval('generating', MAX_CONSECUTIVE_NULL_POLLS + 3)).toBe(false);
  });

  it('still stops on a settled status however many nulls came before it', () => {
    for (const status of ['preview_ready', 'ready', 'failed', 'cancelled', 'refunded'] satisfies CncOrderStatus[]) {
      expect({ status, interval: nextOrderPollInterval(status, 0) }).toEqual({ status, interval: false });
    }
  });
});
