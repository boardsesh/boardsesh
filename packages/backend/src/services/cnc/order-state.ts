/**
 * The CNC order lifecycle as pure data plus the three predicates the DB layer
 * and the worker routes need.
 *
 * Nothing here touches the database on purpose. Every real transition is a
 * conditional `UPDATE ... WHERE id = $id AND status IN (...allowed)` (see
 * `transitionOrder` in `orders.ts`, which reads `allowed` and the written
 * status off this table via {@link transitionFor}), so this module's job is
 * to say which (status, event) pairs are legal at all — the database decides
 * who actually won the race.
 */

export type CncOrderStatus =
  | 'preview_queued'
  | 'preview_generating'
  | 'preview_ready'
  | 'preview_failed'
  | 'pending_payment'
  | 'queued'
  | 'generating'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'refunded';

/**
 * Which artifact a generation job produces.
 *
 * The order row is one queue carrying both, so almost everything downstream —
 * the claim, the job payload, the completion report, the download route — takes
 * this rather than re-deriving it from a status. `full` is the paid pack;
 * `preview` is the free watermarked raster the buyer iterates on.
 */
export type CncDeliverable = 'full' | 'preview';

/** Which deliverable a claimed row is generating, from its status. */
export function deliverableForStatus(status: CncOrderStatus): CncDeliverable {
  return status.startsWith('preview') ? 'preview' : 'full';
}

/** `'new'` is the pre-insert state: there is no row yet. */
export type CncOrderFromStatus = CncOrderStatus | 'new';

export type CncOrderEvent =
  | 'previewRequested'
  | 'previewClaim'
  | 'previewComplete'
  | 'previewFail'
  | 'finalise'
  | 'finaliseFailed'
  | 'checkoutCompleted'
  | 'checkoutExpired'
  | 'checkoutFailed'
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
   * runtime state — only `fail` and `previewFail`, which both route through
   * {@link nextStatusAfterFailure}.
   */
  to: CncOrderStatus | null;
  why: string;
};

export const CNC_ORDER_TRANSITIONS: readonly CncOrderTransition[] = [
  {
    event: 'previewRequested',
    from: ['new'],
    to: 'preview_queued',
    why: 'A preview is free, so the row starts here rather than at a payment. Re-previewing a CHANGED configuration fires this again for a NEW row — a preview is an immutable snapshot of one configuration, never a row that moves backwards.',
  },
  {
    event: 'previewClaim',
    // 'preview_generating' is here for the reclaim, exactly as 'generating' is
    // on `claim`: a worker that died leaves a stale lease for the next scan.
    from: ['preview_queued', 'preview_generating'],
    to: 'preview_generating',
    why: 'A worker took the preview lease: attempts+1 and a fresh claim token.',
  },
  {
    event: 'previewComplete',
    from: ['preview_generating'],
    to: 'preview_ready',
    why: 'The watermarked preview zip and its PNGs are in the bucket. Nothing is charged and nobody is emailed — the buyer is still iterating.',
  },
  {
    event: 'previewFail',
    from: ['preview_generating'],
    to: null,
    why: 'Back to the preview queue for another attempt, or terminal once the same three-attempt budget is spent.',
  },
  {
    event: 'finalise',
    from: ['preview_ready'],
    to: 'pending_payment',
    why: 'The buyer approved the preview and picked a licence: the row takes its tier and licensee and goes on to Stripe. This is where a free preview becomes a sale.',
  },
  {
    event: 'finaliseFailed',
    from: ['pending_payment'],
    to: 'preview_ready',
    why: 'Stripe would not open a session for a finalise. The row goes back to the preview it came from rather than to `cancelled`: the preview is still valid, still paid for by nobody, and making a buyer regenerate one because of our outage would cost them a slot in the hourly preview budget.',
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
    event: 'checkoutFailed',
    from: ['pending_payment'],
    to: 'cancelled',
    why: 'Stripe would not open a session, so the row we optimistically wrote is retired rather than left looking sellable.',
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
 * The table row for `event`, so a caller can read its `from`/`to` rather than
 * re-deriving them. `orders.ts`'s `transitionOrder` is the only real caller:
 * it turns `from` into the conditional UPDATE's `status IN (...)` and `to`
 * into the written status.
 */
export function transitionFor(event: CncOrderEvent): CncOrderTransition {
  const transition = TRANSITIONS_BY_EVENT.get(event);
  if (!transition) {
    // Unreachable while CncOrderEvent and CNC_ORDER_TRANSITIONS stay in sync —
    // both are checked against ALL_EVENTS in order-state.test.ts.
    throw new Error(`[cnc-order-state] no transition defined for event "${event}"`);
  }
  return transition;
}

/**
 * How many generation attempts an order gets before it is given up on.
 *
 * Lives here, next to the transition table, rather than in `orders.ts`: it is
 * the single number both the claim (attempts < budget) and the failure
 * transition (attempts >= budget) must agree on.
 */
export const CNC_MAX_ATTEMPTS = 3;

/**
 * Where a failed generation lands.
 *
 * `attempts` is the count AFTER the failed attempt — the claim already
 * incremented it — so the third failure of a three-attempt budget is terminal
 * rather than being requeued for a fourth try no one is watching.
 *
 * A preview gets the same budget on its own pair of statuses. One function
 * rather than two so the budget can only ever be read one way; the deliverable
 * picks the pair.
 */
export function nextStatusAfterFailure(
  attempts: number,
  maxAttempts = CNC_MAX_ATTEMPTS,
  deliverable: CncDeliverable = 'full',
): CncOrderStatus {
  const spent = attempts >= maxAttempts;
  if (deliverable === 'preview') return spent ? 'preview_failed' : 'preview_queued';
  return spent ? 'failed' : 'queued';
}

/**
 * Statuses a fresh preview may be asked for from.
 *
 * Deliberately NOT a transition. Re-previewing writes a new row (see
 * `previewRequested`), so there is no (from, event) pair for it to occupy — but
 * the resolver still has to answer "may this buyer ask again?", and that answer
 * belongs next to the table rather than inlined at the call site.
 */
export const CNC_RE_PREVIEWABLE_STATUSES: readonly CncOrderStatus[] = ['preview_ready', 'preview_failed'];

/** True when an order in this status may be re-previewed (as a new row). */
export function canRePreview(status: CncOrderStatus): boolean {
  return CNC_RE_PREVIEWABLE_STATUSES.includes(status);
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
 * Statuses a preview stays downloadable from.
 *
 * `preview_ready` onward: finalising and paying does not take the preview away,
 * because the preview is the thing the buyer approved and they may well want to
 * look at it again next to the real pack. It stops at a refund, like everything
 * else the order entitles them to.
 */
const PREVIEW_DOWNLOADABLE_STATUSES: readonly CncOrderStatus[] = [
  'preview_ready',
  'pending_payment',
  'queued',
  'generating',
  'ready',
  'failed',
];

/**
 * Whether the buyer may download this deliverable.
 *
 * `refundedAt` is checked for both even though a refund moves the status away
 * from `ready`: a refund that raced an admin regenerate can leave a `ready` row
 * with `refunded_at` set, and access must fail closed in that case.
 *
 * The full pack is `ready` only. The preview is a much wider window on purpose
 * — it is watermarked, rasterised and explicitly not for manufacture, so the
 * thing it protects is the DXF, not the picture of it.
 */
export function isDownloadable(
  order: { status: CncOrderStatus; refundedAt: Date | null },
  kind: CncDeliverable = 'full',
): boolean {
  if (order.refundedAt !== null) return false;
  if (kind === 'preview') return PREVIEW_DOWNLOADABLE_STATUSES.includes(order.status);
  return order.status === 'ready';
}
