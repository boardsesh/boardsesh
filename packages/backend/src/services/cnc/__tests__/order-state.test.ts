import { describe, it, expect } from 'vite-plus/test';
import {
  CNC_LEASE_MS,
  CNC_ORDER_TRANSITIONS,
  canRePreview,
  canTransition,
  deliverableForStatus,
  isDownloadable,
  isLeaseStale,
  nextStatusAfterFailure,
  type CncOrderEvent,
  type CncOrderFromStatus,
  type CncOrderStatus,
} from '../order-state';

const ALL_STATUSES: readonly CncOrderFromStatus[] = [
  'new',
  'preview_queued',
  'preview_generating',
  'preview_ready',
  'preview_failed',
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
  ['new', 'previewRequested'],
  ['preview_queued', 'previewClaim'],
  ['preview_generating', 'previewClaim'],
  ['preview_generating', 'previewComplete'],
  ['preview_generating', 'previewFail'],
  ['preview_ready', 'finalise'],
  ['pending_payment', 'finaliseFailed'],
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
  'previewRequested',
  'previewClaim',
  'previewComplete',
  'previewFail',
  'finalise',
  'finaliseFailed',
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

  it('leaves only the two failure events with a runtime-computed target', () => {
    const computed = CNC_ORDER_TRANSITIONS.filter((transition) => transition.to === null);
    expect(computed.map((transition) => transition.event).sort()).toEqual(['fail', 'previewFail']);
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

  it('never sells a wall nobody has previewed', () => {
    // The one property the whole preview flow exists to guarantee: the only
    // door into `pending_payment` is `finalise`, and the only status it opens
    // from is `preview_ready`.
    const intoPendingPayment = CNC_ORDER_TRANSITIONS.filter((transition) => transition.to === 'pending_payment');
    expect(intoPendingPayment.map((transition) => transition.event)).toEqual(['finalise']);
    expect(intoPendingPayment[0].from).toEqual(['preview_ready']);
  });

  it('never moves an existing row back into a preview queue', () => {
    // Re-previewing writes a NEW row. A transition would make a preview a
    // mutable thing, and the images already handed to the buyer would start
    // describing a different wall.
    for (const status of ALL_STATUSES) {
      expect(canTransition(status, 'previewRequested')).toBe(status === 'new');
    }
  });
});

describe('canRePreview', () => {
  it('lets a finished or failed preview be asked for again', () => {
    expect(canRePreview('preview_ready')).toBe(true);
    expect(canRePreview('preview_failed')).toBe(true);
  });

  it.each<CncOrderStatus>(['preview_queued', 'preview_generating', 'pending_payment', 'queued', 'ready', 'refunded'])(
    'refuses to re-preview a %s order',
    (status) => {
      expect(canRePreview(status)).toBe(false);
    },
  );
});

describe('deliverableForStatus', () => {
  it.each<CncOrderStatus>(['preview_queued', 'preview_generating', 'preview_ready', 'preview_failed'])(
    'reads %s as a preview job',
    (status) => {
      expect(deliverableForStatus(status)).toBe('preview');
    },
  );

  it.each<CncOrderStatus>(['pending_payment', 'queued', 'generating', 'ready', 'failed', 'cancelled', 'refunded'])(
    'reads %s as a full job',
    (status) => {
      expect(deliverableForStatus(status)).toBe('full');
    },
  );
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

  it('runs the same budget on the preview statuses', () => {
    expect(nextStatusAfterFailure(1, undefined, 'preview')).toBe('preview_queued');
    expect(nextStatusAfterFailure(2, undefined, 'preview')).toBe('preview_queued');
    expect(nextStatusAfterFailure(3, undefined, 'preview')).toBe('preview_failed');
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

  it.each<CncOrderStatus>([
    'preview_queued',
    'preview_generating',
    'preview_ready',
    'preview_failed',
    'pending_payment',
    'queued',
    'generating',
    'failed',
    'cancelled',
    'refunded',
  ])('blocks the full pack of a %s order', (status) => {
    expect(isDownloadable({ status, refundedAt: null })).toBe(false);
  });

  it.each<CncOrderStatus>(['preview_ready', 'pending_payment', 'queued', 'generating', 'ready', 'failed'])(
    'serves the preview of a %s order',
    (status) => {
      expect(isDownloadable({ status, refundedAt: null }, 'preview')).toBe(true);
    },
  );

  it.each<CncOrderStatus>(['preview_queued', 'preview_generating', 'preview_failed', 'cancelled', 'refunded'])(
    'blocks the preview of a %s order',
    (status) => {
      expect(isDownloadable({ status, refundedAt: null }, 'preview')).toBe(false);
    },
  );

  it('stops the preview at a refund, like everything else the order entitles them to', () => {
    expect(isDownloadable({ status: 'ready', refundedAt: new Date() }, 'preview')).toBe(false);
  });
});
