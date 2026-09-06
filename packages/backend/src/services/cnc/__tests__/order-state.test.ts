import { describe, it, expect } from 'vite-plus/test';
import {
  CNC_LEASE_MS,
  CNC_ORDER_TRANSITIONS,
  canTransition,
  isDownloadable,
  isLeaseStale,
  nextStatusAfterFailure,
  type CncOrderEvent,
  type CncOrderFromStatus,
  type CncOrderStatus,
} from '../order-state';

const ALL_STATUSES: readonly CncOrderFromStatus[] = [
  'new',
  'pending_payment',
  'queued',
  'generating',
  'ready',
  'failed',
  'cancelled',
  'refunded',
];

// The transition table from the plan, transcribed independently of the
// implementation. Anything not listed here must be rejected — that half is what
// stops an unpaid order reaching the worker or a cancelled one being generated.
const LEGAL_TRANSITIONS: ReadonlyArray<[CncOrderFromStatus, CncOrderEvent]> = [
  ['new', 'createCheckoutSession'],
  ['pending_payment', 'checkoutCompleted'],
  ['pending_payment', 'checkoutExpired'],
  ['pending_payment', 'checkoutFailed'],
  ['queued', 'claim'],
  ['generating', 'claim'],
  ['generating', 'complete'],
  ['generating', 'fail'],
  ['queued', 'refund'],
  ['generating', 'refund'],
  ['ready', 'refund'],
  ['failed', 'refund'],
  ['ready', 'regenerate'],
  ['failed', 'regenerate'],
];

const ALL_EVENTS: readonly CncOrderEvent[] = [
  'createCheckoutSession',
  'checkoutCompleted',
  'checkoutExpired',
  'checkoutFailed',
  'claim',
  'complete',
  'fail',
  'refund',
  'regenerate',
];

describe('CNC_ORDER_TRANSITIONS', () => {
  it('covers every event exactly once', () => {
    expect(CNC_ORDER_TRANSITIONS.map((transition) => transition.event).sort()).toEqual([...ALL_EVENTS].sort());
  });

  it('leaves only `fail` with a runtime-computed target', () => {
    const computed = CNC_ORDER_TRANSITIONS.filter((transition) => transition.to === null);
    expect(computed.map((transition) => transition.event)).toEqual(['fail']);
  });

  it('never lands an order back in `new`', () => {
    expect(CNC_ORDER_TRANSITIONS.some((transition) => transition.to === ('new' as CncOrderStatus))).toBe(false);
  });
});

describe('canTransition', () => {
  it.each(LEGAL_TRANSITIONS)('allows %s + %s', (from, event) => {
    expect(canTransition(from, event)).toBe(true);
  });

  it('rejects every pair the table does not list', () => {
    const legal = new Set(LEGAL_TRANSITIONS.map(([from, event]) => `${from}:${event}`));
    const wronglyAllowed: string[] = [];
    for (const from of ALL_STATUSES) {
      for (const event of ALL_EVENTS) {
        const pair = `${from}:${event}`;
        if (!legal.has(pair) && canTransition(from, event)) wronglyAllowed.push(pair);
      }
    }
    expect(wronglyAllowed).toEqual([]);
  });

  it('never lets an unpaid or cancelled order be refunded', () => {
    expect(canTransition('pending_payment', 'refund')).toBe(false);
    expect(canTransition('cancelled', 'refund')).toBe(false);
    expect(canTransition('refunded', 'refund')).toBe(false);
  });

  it('never regenerates a refunded order', () => {
    expect(canTransition('refunded', 'regenerate')).toBe(false);
  });
});

describe('nextStatusAfterFailure', () => {
  it('requeues while attempts remain', () => {
    expect(nextStatusAfterFailure(1)).toBe('queued');
    expect(nextStatusAfterFailure(2)).toBe('queued');
  });

  it('gives up on the third attempt', () => {
    expect(nextStatusAfterFailure(3)).toBe('failed');
    expect(nextStatusAfterFailure(4)).toBe('failed');
  });

  it('honours a custom budget', () => {
    expect(nextStatusAfterFailure(1, 1)).toBe('failed');
    expect(nextStatusAfterFailure(1, 5)).toBe('queued');
  });
});

describe('isLeaseStale', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');

  it('treats a fresh heartbeat as live', () => {
    expect(isLeaseStale(new Date(now.getTime() - 60_000), now)).toBe(false);
  });

  it('treats a heartbeat older than the lease window as stale', () => {
    expect(isLeaseStale(new Date(now.getTime() - CNC_LEASE_MS - 1), now)).toBe(true);
  });

  it('holds the lease right up to the boundary', () => {
    expect(isLeaseStale(new Date(now.getTime() - CNC_LEASE_MS), now)).toBe(false);
  });

  it('treats a job that never heartbeated as stale so it cannot strand', () => {
    expect(isLeaseStale(null, now)).toBe(true);
  });
});

describe('isDownloadable', () => {
  it('allows a ready pack that was not refunded', () => {
    expect(isDownloadable({ status: 'ready', refundedAt: null })).toBe(true);
  });

  it('blocks a refunded pack even when the row still reads ready', () => {
    expect(isDownloadable({ status: 'ready', refundedAt: new Date() })).toBe(false);
  });

  it.each<CncOrderStatus>(['pending_payment', 'queued', 'generating', 'failed', 'cancelled', 'refunded'])(
    'blocks a %s order',
    (status) => {
      expect(isDownloadable({ status, refundedAt: null })).toBe(false);
    },
  );
});
