import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { randomUUID } from 'node:crypto';
import { cncOrders, users, type CncOrder, type CncOrderArtworkItem, type CncOrderOptions } from '@boardsesh/db/schema';
import { db } from '../../db/client';
import { generateLicenceId } from './licence-id';
import { CNC_LEASE_MS, CNC_MAX_ATTEMPTS, transitionFor, type CncOrderEvent, type CncOrderStatus } from './order-state';
import { CNC_CATALOG_VERSION, type CncLicenceTier } from './catalog';

export { CNC_MAX_ATTEMPTS } from './order-state';

/**
 * Either the pooled client or an open transaction handle.
 *
 * The Stripe webhook does its order transition and its "event processed" stamp
 * in one transaction, so the reads and writes it uses have to run on the same
 * handle. Every drizzle client in the repo — including the `PgTransaction` a
 * `db.transaction` callback is handed — satisfies this shape, so the query
 * chains below stay fully typed either way.
 */
export type CncOrdersExecutor = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Database layer for CNC orders.
 *
 * Two rules hold everywhere in this file:
 *
 * 1. Every status change is a conditional `UPDATE ... WHERE id = $id AND
 *    status IN (...allowed) RETURNING *`, the allowed statuses coming from
 *    `transitionFor(event)` in `order-state.ts`. Zero rows back means someone
 *    else already moved the order (a webhook redelivery, a worker that lost
 *    its lease), so the caller no-ops instead of overwriting. Read-then-write
 *    would race.
 * 2. The order row is also the job queue, so the claim has to be atomic against
 *    other workers — hence the one transaction with `FOR UPDATE SKIP LOCKED`.
 */

/**
 * TRUE when a `generating` row has not heartbeated inside the lease window.
 *
 * `CNC_LEASE_MS / 1000` is interpolated as a bound parameter (drizzle's `sql`
 * tag parameterises any plain JS value passed through `${}`), not `sql.raw` —
 * `make_interval` still needs the explicit cast because Postgres cannot infer
 * a bound parameter's type for an `secs => $1` named argument.
 */
const leaseExpiredSql = or(
  isNull(cncOrders.heartbeatAt),
  lt(cncOrders.heartbeatAt, sql`now() - make_interval(secs => ${CNC_LEASE_MS / 1000}::double precision)`),
);

export type CreatePendingOrderInput = {
  userId: string;
  tier: CncLicenceTier;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  options: CncOrderOptions;
  artwork?: CncOrderArtworkItem[] | null;
  /** Defaults to the current {@link CNC_CATALOG_VERSION} — callers only pass this to pin an older one. */
  catalogVersion?: string;
  licenseeName: string;
  licenseeEmail: string;
  customerSiteName?: string | null;
  licenceAcceptedAt: Date;
  currency: string;
  amountCents: number;
};

/** Postgres unique-violation SQLSTATE. */
const UNIQUE_VIOLATION = '23505';

function isLicenceIdCollision(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  // postgres-js names it `constraint_name`; node-postgres names it `constraint`.
  // Both are read as strings only — anything else means this is not the error
  // we are looking for and the caller must rethrow.
  const pgError = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  if (pgError.code !== UNIQUE_VIOLATION) return false;
  const constraintName = typeof pgError.constraint_name === 'string' ? pgError.constraint_name : pgError.constraint;
  return typeof constraintName === 'string' && constraintName.includes('licence_id');
}

/**
 * Insert an order in `pending_payment`, before Stripe Checkout opens.
 *
 * The licence id is generated optimistically and retried on the unique-index
 * violation rather than checked for existence first — a check-then-insert races
 * with a concurrent purchase, and at ~29 bits a collision is rare enough that
 * the retry never costs anything in practice.
 */
export async function createPendingOrder(input: CreatePendingOrderInput): Promise<CncOrder> {
  const maxLicenceIdAttempts = 5;
  for (let attempt = 1; attempt <= maxLicenceIdAttempts; attempt += 1) {
    try {
      const [order] = await db
        .insert(cncOrders)
        .values({
          licenceId: generateLicenceId(),
          userId: input.userId,
          tier: input.tier,
          status: 'pending_payment',
          boardName: input.boardName,
          layoutId: input.layoutId,
          sizeId: input.sizeId,
          setIds: input.setIds,
          options: input.options,
          artwork: input.artwork ?? null,
          catalogVersion: input.catalogVersion ?? CNC_CATALOG_VERSION,
          licenseeName: input.licenseeName,
          licenseeEmail: input.licenseeEmail,
          customerSiteName: input.customerSiteName ?? null,
          licenceAcceptedAt: input.licenceAcceptedAt,
          currency: input.currency,
          amountCents: input.amountCents,
        })
        .returning();
      return order;
    } catch (error) {
      if (!isLicenceIdCollision(error) || attempt === maxLicenceIdAttempts) throw error;
    }
  }
  // Unreachable: the loop either returns or rethrows on its last attempt.
  throw new Error('[cnc-orders] exhausted licence id attempts');
}

export async function getOrderByLicenceId(licenceId: string): Promise<CncOrder | null> {
  const [order] = await db.select().from(cncOrders).where(eq(cncOrders.licenceId, licenceId)).limit(1);
  return order ?? null;
}

/** One order by row id. The Stripe webhook's lookup: sessions carry `metadata.orderId`. */
export async function getOrderById(orderId: number, executor: CncOrdersExecutor = db): Promise<CncOrder | null> {
  const [order] = await executor.select().from(cncOrders).where(eq(cncOrders.id, orderId)).limit(1);
  return order ?? null;
}

/**
 * One order by Stripe PaymentIntent id.
 *
 * `charge.refunded` arrives with a charge and its payment intent, and no
 * session at all — the checkout that produced it may have been months ago — so
 * this is the only handle a refund gives us on the order.
 */
export async function getOrderByPaymentIntentId(
  paymentIntentId: string,
  executor: CncOrdersExecutor = db,
): Promise<CncOrder | null> {
  const [order] = await executor
    .select()
    .from(cncOrders)
    .where(eq(cncOrders.stripePaymentIntentId, paymentIntentId))
    .limit(1);
  return order ?? null;
}

/**
 * Record which Checkout Session an order was sent to.
 *
 * Not a transition: the order is already `pending_payment` and stays there —
 * opening a checkout is not a payment. The status is still in the WHERE so a
 * session id can never be stamped onto an order that has meanwhile been paid,
 * cancelled or refunded; that would only ever be a bug, and overwriting is the
 * worst way to find out about it.
 *
 * Returns null when nothing matched, which the caller treats the way it treats
 * a lost transition race: log it, do not fail the buyer's checkout. The session
 * id is a support convenience — the webhook finds the order by
 * `metadata.orderId` regardless.
 */
export async function attachCheckoutSession(orderId: number, sessionId: string): Promise<CncOrder | null> {
  const [order] = await db
    .update(cncOrders)
    .set({ stripeCheckoutSessionId: sessionId, updatedAt: new Date() })
    .where(and(eq(cncOrders.id, orderId), eq(cncOrders.status, 'pending_payment')))
    .returning();
  return order ?? null;
}

/** A buyer's orders, newest first. Served by `cnc_orders_user_created_idx`. */
export async function listOrdersForUser(userId: string): Promise<CncOrder[]> {
  return db.select().from(cncOrders).where(eq(cncOrders.userId, userId)).orderBy(desc(cncOrders.createdAt));
}

/**
 * The signed-in account's own email, read fresh at call time.
 *
 * Never `licenseeEmail`: that field is buyer-typed free text kept as the
 * licence record (it can be a teammate, a client, anyone the wall is built
 * for), while Stripe's `customer_email` and the first "order received" mail
 * both need the account the payment is actually tied to. Returns null for an
 * order whose account has since been deleted (`cnc_orders.user_id` is
 * `set null` on account deletion) rather than throwing — callers fall back to
 * `licenseeEmail` in that case.
 */
export async function getAccountEmail(userId: string): Promise<string | null> {
  const [account] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return account?.email ?? null;
}

/**
 * Columns a transition may write. `updatedAt` is handled by {@link
 * transitionOrder} directly, and `status` is not a patch field at all: the
 * caller passes an event, and `transitionOrder` reads the target status off
 * `CNC_ORDER_TRANSITIONS` (via `transitionFor`) so it can never drift from the
 * state machine.
 *
 * `status` is the sole exception, and only for `fail`: that event's target
 * depends on the runtime attempt count (see `nextStatusAfterFailure`), which
 * the transition table represents as `to: null`. Every other event ignores
 * this field.
 */
export type CncOrderPatch = {
  status?: CncOrderStatus;
  queuedAt?: Date | null;
  claimedAt?: Date | null;
  heartbeatAt?: Date | null;
  workerId?: string | null;
  claimToken?: string | null;
  attempts?: number;
  lastError?: string | null;
  generation?: number;
  stripeCheckoutSessionId?: string | null;
  stripePaymentIntentId?: string | null;
  // Writable by the paid webhook, which records what Stripe ACTUALLY charged
  // rather than the catalogue price the order was reserved at — with Stripe Tax
  // on, those are different numbers.
  amountCents?: number | null;
  currency?: string | null;
  paidAt?: Date | null;
  refundedAt?: Date | null;
  generatedAt?: Date | null;
  zipKey?: string | null;
  zipSizeBytes?: number | null;
  zipSha256?: string | null;
  fingerprintManifest?: Record<string, unknown> | null;
};

export type TransitionOrderOptions = {
  /**
   * Require the row to still hold this claim token.
   *
   * The worker's complete and fail reports pass it. Without it the UPDATE would
   * be conditional on status alone, and a worker whose lease expired mid-job
   * could still land its report on the row a replacement is now generating —
   * the replacement's own claim leaves the status at `generating`, so a
   * status-only guard matches. Folding the token into the same statement is
   * what makes "this report belongs to the current lease" atomic instead of a
   * read the reclaim can race.
   */
  claimToken?: string;
  /**
   * Run the UPDATE inside a caller's transaction. The Stripe webhook passes
   * its transaction handle so the status change and the "event processed"
   * stamp either both commit or neither does.
   */
  executor?: CncOrdersExecutor;
};

/**
 * Fire `event` on an order, atomically.
 *
 * The state machine, not the caller, decides both halves of the UPDATE: the
 * conditional's allowed statuses come from `transitionFor(event).from`, and
 * the written status comes from `transitionFor(event).to` (or, for `fail`
 * alone, `patch.status`, since that target is runtime-computed). Callers pass
 * an event, never a raw target status, so an order can never be pushed into a
 * status the table does not allow from wherever it currently sits.
 *
 * Returns null when the row was not in one of the allowed statuses — already
 * moved, the event does not apply from the current state, or the row never
 * existed. Callers treat that as a no-op, which is what makes Stripe
 * redeliveries, late worker reports and a stray invalid event harmless.
 *
 * Pass `options.executor` to run inside a caller's transaction. The Stripe
 * webhook does, so the status change and the "event processed" stamp either
 * both commit or neither does.
 */
export async function transitionOrder(
  orderId: number,
  event: CncOrderEvent,
  patch: CncOrderPatch = {},
  { claimToken, executor = db }: TransitionOrderOptions = {},
): Promise<CncOrder | null> {
  const transition = transitionFor(event);
  // 'new' is the pre-insert state — there is no row to condition an UPDATE on
  // — so it never belongs in the allowed-from list here. Only
  // `createCheckoutSession` lists it, and that event goes through
  // `createPendingOrder` instead of `transitionOrder`.
  const allowedFromStatuses = transition.from.filter((status): status is CncOrderStatus => status !== 'new');
  if (allowedFromStatuses.length === 0) {
    throw new Error(`[cnc-orders] "${event}" has no existing-row transition; use createPendingOrder instead`);
  }

  const targetStatus = transition.to ?? patch.status;
  if (!targetStatus) {
    throw new Error(`[cnc-orders] "${event}"'s target status is runtime-computed; pass patch.status`);
  }

  const { status: _statusOverride, ...columns } = patch;

  const [order] = await executor
    .update(cncOrders)
    .set({ ...columns, status: targetStatus, updatedAt: new Date() })
    .where(
      and(
        eq(cncOrders.id, orderId),
        inArray(cncOrders.status, allowedFromStatuses),
        ...(claimToken ? [eq(cncOrders.claimToken, claimToken)] : []),
      ),
    )
    .returning();
  return order ?? null;
}

/**
 * Stamp a live lease, or report that the worker no longer holds one.
 *
 * Not a transition — the status does not move — but it carries the same
 * conditional-update discipline: status and claim token in the WHERE, zero rows
 * back meaning the caller lost its lease. The worker turns that into a 409 and
 * stops working on the job rather than generating a pack nothing will accept.
 *
 * `now()` is the DATABASE clock for the same reason the claim uses it: the
 * staleness predicate reads `now()`, so a worker whose clock runs slow would
 * otherwise write a heartbeat that already looks expired.
 */
export async function recordWorkerHeartbeat(orderId: number, claimToken: string): Promise<boolean> {
  const rows = await db
    .update(cncOrders)
    .set({ heartbeatAt: sql`now()`, updatedAt: new Date() })
    .where(and(eq(cncOrders.id, orderId), eq(cncOrders.status, 'generating'), eq(cncOrders.claimToken, claimToken)))
    .returning({ id: cncOrders.id });
  return rows.length > 0;
}

/**
 * Count one download.
 *
 * Incremented in SQL rather than read-modify-written: a buyer with the order
 * page open on two devices would otherwise lose one of the two counts, and the
 * number exists precisely to notice a pack being fetched far more often than
 * one wall needs.
 */
export async function recordDownload(orderId: number, now: Date): Promise<void> {
  await db
    .update(cncOrders)
    .set({
      downloadCount: sql`${cncOrders.downloadCount} + 1`,
      lastDownloadedAt: now,
      updatedAt: now,
    })
    .where(eq(cncOrders.id, orderId));
}

/**
 * Fail every job whose lease expired after its attempt budget was spent.
 *
 * The worker's poll is the reaper — there is no scheduler job — so this runs as
 * the first statement of every claim. Without it a worker that dies on its
 * third attempt leaves the row in `generating` forever: the claim's candidate
 * filter excludes `attempts >= CNC_MAX_ATTEMPTS`, so nothing else would ever
 * look at it again.
 *
 * Returns the rows it reaped so a caller can act on them. `handleClaim` runs it
 * first and mails an operator for each, because this is the only failure path
 * with no worker left alive to report it; the call inside `claimNextJob` is the
 * safety net that keeps the invariant for any other caller, and finds nothing
 * on the poll path.
 */
export async function failStaleExhaustedJobs(): Promise<CncOrder[]> {
  return db
    .update(cncOrders)
    .set({
      status: 'failed',
      lastError: 'Lease expired after the final generation attempt',
      claimToken: null,
      updatedAt: new Date(),
    })
    .where(and(eq(cncOrders.status, 'generating'), leaseExpiredSql, gte(cncOrders.attempts, CNC_MAX_ATTEMPTS)))
    .returning();
}

/**
 * Claim the next generation job for `workerId`, or return null when idle.
 *
 * Shape mirrors `claimNextCredentialForSync`: lock one candidate with `FOR
 * UPDATE SKIP LOCKED` so a second worker skips straight past it, then write the
 * claim inside the same transaction so the row is unattractive by the time the
 * lock drops.
 *
 * The write has to FALSIFY a candidate qual, not merely re-sort the row. Under
 * READ COMMITTED, SKIP LOCKED only skips rows whose lock is currently held; if
 * this transaction commits between another claimer's snapshot and its lock
 * attempt, Postgres re-evaluates the WHERE quals (never the ORDER BY) against
 * the new row version. Both quals are falsified here: `status` leaves 'queued',
 * and `heartbeat_at` is stamped to now so the stale-lease branch is false too.
 *
 * The lease stamps are written with the DATABASE clock, not `now`. The
 * staleness predicate reads `now()`, so a worker process whose clock runs slow
 * would otherwise stamp a heartbeat that already looks expired and hand its own
 * job straight to the next claimer. `now` is the caller's clock and only ever
 * lands in `updated_at`, which nothing compares against.
 */
export async function claimNextJob(workerId: string, now: Date): Promise<CncOrder | null> {
  await failStaleExhaustedJobs();

  return db.transaction(async (tx) => {
    const candidates = await tx
      .select({ id: cncOrders.id, attempts: cncOrders.attempts })
      .from(cncOrders)
      .where(
        or(
          eq(cncOrders.status, 'queued'),
          and(eq(cncOrders.status, 'generating'), leaseExpiredSql, lt(cncOrders.attempts, CNC_MAX_ATTEMPTS)),
        ),
      )
      // Oldest queued first. NULLS FIRST is unreachable in practice (queued_at
      // is stamped with the status) but keeps a row that somehow lost its stamp
      // at the front rather than stranded at the back forever.
      .orderBy(sql`${cncOrders.queuedAt} ASC NULLS FIRST`)
      .limit(1)
      .for('update', { skipLocked: true });

    const candidate = candidates[0];
    if (!candidate) return null;

    const [claimed] = await tx
      .update(cncOrders)
      .set({
        status: 'generating',
        attempts: candidate.attempts + 1,
        // A fresh token per claim is what lets a complete/fail report from a
        // worker that lost its lease be recognised and ignored.
        claimToken: randomUUID(),
        workerId,
        claimedAt: sql`now()`,
        heartbeatAt: sql`now()`,
        // A reclaim (this worker taking over a stale lease) must not carry the
        // previous worker's failure forward — it read as this attempt's error
        // even though nothing has failed yet on this claim.
        lastError: null,
        updatedAt: now,
      })
      .where(eq(cncOrders.id, candidate.id))
      .returning();

    // Unreachable rather than merely unlikely: the SELECT holds the row lock for
    // the rest of this transaction. Returning null keeps the worker on its
    // no-work path if that reasoning is ever wrong.
    return claimed ?? null;
  });
}

/** Order columns that are internal to the generation pipeline and must never reach the buyer. */
type CncOrderInternalColumn =
  | 'fingerprintManifest'
  | 'claimToken'
  | 'workerId'
  | 'lastError'
  | 'zipKey'
  | 'stripeCheckoutSessionId'
  | 'stripePaymentIntentId'
  | 'claimedAt'
  | 'heartbeatAt'
  | 'attempts';

/**
 * An order as it may be shown to its buyer.
 *
 * `Omit` is a one-way guard, and it is worth being precise about which way.
 * Listing a column here and forgetting to destructure it in `toPublicOrder` IS
 * a compile error — the returned `rest` still has it and no longer matches the
 * declared return type. The other direction is silent and is the one that
 * matters: a NEW internal column added to `CncOrder` without being added to
 * `CncOrderInternalColumn` is simply carried through by `Omit`, type-checks
 * everywhere, and leaks to the buyer. Nothing in the type system notices, which
 * is why `toPublicOrder` also has a test that snapshots its output keys against
 * an explicit allowlist: adding a column to the table fails that test until
 * someone has decided whether the buyer may see it.
 *
 * `queuedAt` is deliberately not omitted — it says nothing more than where the
 * order sits in the queue.
 */
export type PublicCncOrder = Omit<CncOrder, CncOrderInternalColumn>;

/**
 * Strip everything that must never leave the backend.
 *
 * `fingerprintManifest` is the map of which covert channels carry which values
 * — publishing it would tell a leaker exactly what to strip. `claimToken` is
 * the worker's proof of lease, `workerId` is infrastructure, and `lastError`
 * carries generator internals; the API surfaces a fixed public message
 * instead. `zipKey` is the object store path — the buyer downloads through a
 * signed-URL route, never the raw key. The Stripe ids are internal payment
 * references, and `claimedAt`/`heartbeatAt`/`attempts` are worker-lease
 * bookkeeping the buyer has no use for and that would otherwise hint at
 * generator internals under retry.
 */
export function toPublicOrder(order: CncOrder): PublicCncOrder {
  const {
    fingerprintManifest: _manifest,
    claimToken: _token,
    workerId: _worker,
    lastError: _error,
    zipKey: _zipKey,
    stripeCheckoutSessionId: _checkoutSessionId,
    stripePaymentIntentId: _paymentIntentId,
    claimedAt: _claimedAt,
    heartbeatAt: _heartbeatAt,
    attempts: _attempts,
    ...rest
  } = order;
  return rest;
}
