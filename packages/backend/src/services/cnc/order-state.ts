/**
 * The CNC order lifecycle as pure data plus the three predicates the DB layer
 * and the worker routes need.
 *
 * Nothing here touches the database on purpose. Every real transition is a
 * conditional `UPDATE ... WHERE id = $id AND status = $expected` (see
 * `orders.ts`), so this module's job is to say which (status, event) pairs are
 * legal at all — the database decides who actually won the race.
 */

export type CncOrderStatus =
  | 'pending_payment'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'refunded';

/** `'new'` is the pre-insert state: there is no row yet. */
export type CncOrderFromStatus = CncOrderStatus | 'new';

export type CncOrderEvent =
  | 'createCheckoutSession'
  | 'checkoutCompleted'
  | 'checkoutExpired'
  | 'claim'
  | 'complete'
  | 'fail'
  | 'refund'
  | 'regenerate';

export type CncOrderTransition = {
  event: CncOrderEvent;
  from: readonly CncOrderFromStatus[];
  /**
   * The status the event moves the order to, or null when the target depends on
   * runtime state — only `fail`, which routes through
   * {@link nextStatusAfterFailure}.
   */
  to: CncOrderStatus | null;
  why: string;
};

export const CNC_ORDER_TRANSITIONS: readonly CncOrderTransition[] = [
  {
    event: 'createCheckoutSession',
    from: ['new'],
    to: 'pending_payment',
    why: 'The row is written before Stripe Checkout opens so the webhook has something to find.',
  },
  {
    event: 'checkoutCompleted',
    from: ['pending_payment'],
    to: 'queued',
    why: 'Payment confirmed. Queueing here, not at checkout creation, is what stops unpaid orders reaching the worker.',
  },
  {
    event: 'checkoutExpired',
    from: ['pending_payment'],
    to: 'cancelled',
    why: 'The 30-minute Checkout session lapsed without payment.',
  },
  {
    event: 'claim',
    // 'generating' is here for the reclaim: a worker that died leaves a stale
    // lease, and the next claim scan takes the row back. Staleness is decided
    // by isLeaseStale, not by this table.
    from: ['queued', 'generating'],
    to: 'generating',
    why: 'A worker took the lease: attempts+1 and a fresh claim token.',
  },
  {
    event: 'complete',
    from: ['generating'],
    to: 'ready',
    why: 'The worker reported a finished pack with a matching claim token and the object verified.',
  },
  {
    event: 'fail',
    from: ['generating'],
    to: null,
    why: 'Back to the queue for another attempt, or terminal once the attempt budget is spent.',
  },
  {
    event: 'refund',
    // Every paid state, and only paid states: pending_payment was never
    // charged, cancelled never paid, and refunded is already terminal.
    from: ['queued', 'generating', 'ready', 'failed'],
    to: 'refunded',
    why: 'The charge was refunded. The pack stays generated; downloads stop.',
  },
  {
    event: 'regenerate',
    from: ['ready', 'failed'],
    to: 'queued',
    why: 'Admin rebuild: generation+1, same licence id and same object key.',
  },
];

const TRANSITIONS_BY_EVENT = new Map<CncOrderEvent, CncOrderTransition>(
  CNC_ORDER_TRANSITIONS.map((transition) => [transition.event, transition]),
);

/** True when `event` is legal from `from`. Says nothing about whether it will win the race. */
export function canTransition(from: CncOrderFromStatus, event: CncOrderEvent): boolean {
  return TRANSITIONS_BY_EVENT.get(event)?.from.includes(from) ?? false;
}

/**
 * Where a failed generation lands.
 *
 * `attempts` is the count AFTER the failed attempt — the claim already
 * incremented it — so the third failure of a three-attempt budget is terminal
 * rather than being requeued for a fourth try no one is watching.
 */
export function nextStatusAfterFailure(attempts: number, maxAttempts = 3): CncOrderStatus {
  return attempts >= maxAttempts ? 'failed' : 'queued';
}

/** How long a worker may hold a job without a heartbeat before the lease is reclaimable. */
export const CNC_LEASE_MS = 10 * 60 * 1000;

/**
 * True when a claimed job's lease has expired.
 *
 * A null heartbeat counts as stale: a row in `generating` that never reported
 * once is a worker that died between claiming and its first heartbeat, and
 * leaving it unreclaimable would strand a paid order forever.
 */
export function isLeaseStale(heartbeatAt: Date | null, now: Date, leaseMs = CNC_LEASE_MS): boolean {
  if (!heartbeatAt) return true;
  return now.getTime() - heartbeatAt.getTime() > leaseMs;
}

/**
 * Whether the buyer may download the pack.
 *
 * Both conditions are checked even though a refund moves the status away from
 * `ready`: a refund that raced an admin regenerate can leave a `ready` row with
 * `refunded_at` set, and access must fail closed in that case.
 */
export function isDownloadable(order: { status: CncOrderStatus; refundedAt: Date | null }): boolean {
  return order.status === 'ready' && order.refundedAt === null;
}
