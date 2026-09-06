// Real-database tests for the CNC order row, which is both the licence record
// and the generation queue.
//
// Two properties are worth a Postgres round trip rather than a unit test:
//
//  * `claimNextJob` must hand a job to exactly one worker. Every worker polls
//    the same table, so the whole design rests on `FOR UPDATE SKIP LOCKED`
//    behaving the way the claim assumes against real MVCC.
//  * `transitionOrder`'s `WHERE status = $expected` is what makes a Stripe
//    redelivery and a late worker report harmless. If Drizzle ever stopped
//    emitting that predicate, both would silently overwrite live state.
import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { eq, sql } from 'drizzle-orm';
import { cncOrders, type CncOrder } from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  CNC_MAX_ATTEMPTS,
  claimNextJob,
  createPendingOrder,
  failStaleExhaustedJobs,
  getOrderByLicenceId,
  listOrdersForUser,
  toPublicOrder,
  transitionOrder,
} from '../services/cnc/orders';
import { CNC_CATALOG_VERSION } from '../services/cnc/catalog';
import { isLicenceId } from '../services/cnc/licence-id';

const BUYER_ID = 'cnc-buyer-1';
const OTHER_BUYER_ID = 'cnc-buyer-2';
const ALL_BUYERS = [BUYER_ID, OTHER_BUYER_ID];

const DEFAULT_OPTIONS = { panelThicknessMm: 18, gridPitchMm: 100 };

/** Numeric comparator so order-id assertions do not depend on lexical sort. */
const byId = (left: number, right: number): number => left - right;

async function insertUser(userId: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${userId}, ${userId + '@test.com'}, ${'Buyer ' + userId}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function clearFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM "cnc_orders" WHERE "user_id" IN (${BUYER_ID}, ${OTHER_BUYER_ID})`);
  await db.execute(sql`DELETE FROM "users" WHERE "id" IN (${BUYER_ID}, ${OTHER_BUYER_ID})`);
}

async function createOrder(userId = BUYER_ID): Promise<CncOrder> {
  return createPendingOrder({
    userId,
    tier: 'personal',
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: DEFAULT_OPTIONS,
    catalogVersion: CNC_CATALOG_VERSION,
    licenseeName: 'Test Buyer',
    licenseeEmail: 'buyer@example.com',
    licenceAcceptedAt: new Date(),
    currency: 'AUD',
    amountCents: 14900,
  });
}

/** Put an order straight into the queue, the way the paid webhook does. */
async function queueOrder(userId = BUYER_ID): Promise<CncOrder> {
  const order = await createOrder(userId);
  const queued = await transitionOrder(order.id, 'checkoutCompleted', {
    queuedAt: new Date(),
    paidAt: new Date(),
  });
  if (!queued) throw new Error('failed to queue fixture order');
  return queued;
}

async function readOrder(orderId: number): Promise<CncOrder | null> {
  const [order] = await db.select().from(cncOrders).where(eq(cncOrders.id, orderId)).limit(1);
  return order ?? null;
}

/** Age a claimed job's heartbeat past the lease window, on the database clock. */
async function expireLease(orderId: number): Promise<void> {
  await db.execute(sql`
    UPDATE "cnc_orders"
    SET "heartbeat_at" = now() - interval '11 minutes', "claimed_at" = now() - interval '11 minutes'
    WHERE "id" = ${orderId}
  `);
}

/**
 * Hold the claim's chosen row lock open on a separate connection, the way a
 * worker mid-claim does, and hand back a release function. Resolves only once
 * the lock is actually held so the caller cannot run early.
 */
function parkClaimHoldingRowLock(): Promise<{ lockedOrderId: number | null; release: () => void }> {
  return new Promise((resolveOuter, rejectOuter) => {
    let release!: () => void;
    const parked = new Promise<void>((resolveInner) => {
      release = resolveInner;
    });

    void db
      .transaction(async (tx) => {
        const rows = await tx
          .select({ id: cncOrders.id })
          .from(cncOrders)
          .where(eq(cncOrders.status, 'queued'))
          .orderBy(sql`${cncOrders.queuedAt} ASC NULLS FIRST`)
          .limit(1)
          .for('update', { skipLocked: true });

        resolveOuter({ lockedOrderId: rows[0]?.id ?? null, release });
        await parked;
      })
      .catch(rejectOuter);
  });
}

describe('CNC orders (real Postgres)', () => {
  const parked: Array<() => void> = [];

  beforeEach(async () => {
    await clearFixtures();
    for (const userId of ALL_BUYERS) await insertUser(userId);
  });

  afterEach(async () => {
    // Always let parked transactions finish, or the pool leaks a connection
    // into the next test.
    for (const release of parked.splice(0)) release();
    await clearFixtures();
  });

  describe('createPendingOrder', () => {
    it('writes an unpaid order with a fresh licence id', async () => {
      const order = await createOrder();

      expect(order.status).toBe('pending_payment');
      expect(isLicenceId(order.licenceId)).toBe(true);
      expect(order.attempts).toBe(0);
      expect(order.generation).toBe(1);
      expect(order.downloadCount).toBe(0);
      expect(order.queuedAt).toBeNull();
      expect(order.options).toEqual(DEFAULT_OPTIONS);
      expect(order.catalogVersion).toBe(CNC_CATALOG_VERSION);
    });

    it('is findable by its licence id and listed newest-first for its buyer', async () => {
      const first = await createOrder();
      const second = await createOrder();
      await createOrder(OTHER_BUYER_ID);

      expect((await getOrderByLicenceId(first.licenceId))?.id).toBe(first.id);
      expect(await getOrderByLicenceId('BS-CNC-ZZZZZZ')).toBeNull();

      const listed = await listOrdersForUser(BUYER_ID);
      expect(listed.map((order) => order.id).sort(byId)).toEqual([first.id, second.id].sort(byId));
      // Another buyer's order never appears in this list.
      expect(listed.every((order) => order.userId === BUYER_ID)).toBe(true);
    });
  });

  describe('transitionOrder', () => {
    it('applies the patch when the event is legal from the current status', async () => {
      const order = await createOrder();
      const paidAt = new Date();

      const moved = await transitionOrder(order.id, 'checkoutCompleted', {
        queuedAt: paidAt,
        paidAt,
        stripePaymentIntentId: 'pi_test_1',
      });

      expect(moved?.status).toBe('queued');
      expect(moved?.stripePaymentIntentId).toBe('pi_test_1');
      expect((await readOrder(order.id))?.status).toBe('queued');
    });

    it('is a no-op when the order already moved on (webhook redelivery)', async () => {
      const order = await queueOrder();

      // The duplicate delivery fires `checkoutCompleted` again, but that event
      // is only legal from `pending_payment` and the order is `queued` now.
      const replayed = await transitionOrder(order.id, 'checkoutCompleted', {
        stripePaymentIntentId: 'pi_duplicate',
      });

      expect(replayed).toBeNull();
      const stored = await readOrder(order.id);
      expect(stored?.status).toBe('queued');
      // Critically, the losing update must not have written its payload either.
      expect(stored?.stripePaymentIntentId).toBeNull();
    });

    it('writes nothing when the event is not legal from the current status at all', async () => {
      // The checkout session lapsed, so the order is cancelled — not one of
      // `checkoutCompleted`'s allowed `from` statuses (`pending_payment` only).
      const order = await createOrder();
      const cancelled = await transitionOrder(order.id, 'checkoutExpired', {});
      expect(cancelled?.status).toBe('cancelled');

      const paymentCompleted = await transitionOrder(order.id, 'checkoutCompleted', {
        paidAt: new Date(),
        stripePaymentIntentId: 'pi_late',
      });

      expect(paymentCompleted).toBeNull();
      const stored = await readOrder(order.id);
      expect(stored?.status).toBe('cancelled');
      expect(stored?.paidAt).toBeNull();
      expect(stored?.stripePaymentIntentId).toBeNull();
    });

    it('returns null for an order that does not exist', async () => {
      expect(await transitionOrder(-1, 'claim', {})).toBeNull();
    });
  });

  describe('claimNextJob', () => {
    it('claims the oldest queued job and stamps the lease', async () => {
      const order = await queueOrder();

      const claimed = await claimNextJob('worker-a', new Date());

      expect(claimed?.id).toBe(order.id);
      expect(claimed?.status).toBe('generating');
      expect(claimed?.attempts).toBe(1);
      expect(claimed?.workerId).toBe('worker-a');
      expect(claimed?.claimToken).toBeTruthy();
      expect(claimed?.heartbeatAt).not.toBeNull();
    });

    it('returns null when nothing is queued', async () => {
      await createOrder();
      expect(await claimNextJob('worker-a', new Date())).toBeNull();
    });

    it('hands two concurrent workers different rows', async () => {
      const first = await queueOrder();
      const second = await queueOrder();

      const [claimA, claimB] = await Promise.all([
        claimNextJob('worker-a', new Date()),
        claimNextJob('worker-b', new Date()),
      ]);

      expect(claimA).not.toBeNull();
      expect(claimB).not.toBeNull();
      expect(claimA?.id).not.toBe(claimB?.id);
      expect([claimA!.id, claimB!.id].sort(byId)).toEqual([first.id, second.id].sort(byId));
    });

    it('skips past a row another worker is mid-claim on rather than blocking', async () => {
      // Deterministic version of the race above: worker A's transaction is
      // parked holding the oldest row's lock while worker B runs for real.
      const first = await queueOrder();
      const second = await queueOrder();

      const parkedClaim = await parkClaimHoldingRowLock();
      parked.push(parkedClaim.release);
      expect(parkedClaim.lockedOrderId).toBe(first.id);

      const claimed = await claimNextJob('worker-b', new Date());
      expect(claimed?.id).toBe(second.id);

      parkedClaim.release();
    });

    it('gets nothing, rather than blocking, when the only job is being claimed', async () => {
      await queueOrder();

      const parkedClaim = await parkClaimHoldingRowLock();
      parked.push(parkedClaim.release);

      expect(await claimNextJob('worker-b', new Date())).toBeNull();

      parkedClaim.release();
    });

    it('does not re-hand a job whose lease is still live', async () => {
      await queueOrder();
      const claimed = await claimNextJob('worker-a', new Date());
      expect(claimed).not.toBeNull();

      // The claim stamped heartbeat_at to now, which is exactly the qual a
      // second claimer's EvalPlanQual recheck evaluates.
      expect(await claimNextJob('worker-b', new Date())).toBeNull();
    });

    it('reclaims a job whose worker died, bumping attempts and rotating the token', async () => {
      await queueOrder();
      const firstClaim = await claimNextJob('worker-a', new Date());
      expect(firstClaim?.attempts).toBe(1);
      await expireLease(firstClaim!.id);

      const reclaim = await claimNextJob('worker-b', new Date());

      expect(reclaim?.id).toBe(firstClaim?.id);
      expect(reclaim?.attempts).toBe(2);
      expect(reclaim?.workerId).toBe('worker-b');
      // A stale token is how a complete/fail report from worker-a is recognised
      // and ignored once worker-b owns the job.
      expect(reclaim?.claimToken).not.toBe(firstClaim?.claimToken);
    });

    it('fails a job whose lease goes stale after the last attempt instead of stranding it', async () => {
      const order = await queueOrder();
      // Third claim = the attempt budget spent.
      for (let attempt = 1; attempt <= CNC_MAX_ATTEMPTS; attempt += 1) {
        const claimed = await claimNextJob(`worker-${attempt}`, new Date());
        expect(claimed?.attempts).toBe(attempt);
        await expireLease(order.id);
      }

      // The next poll reaps it rather than claiming it a fourth time.
      expect(await claimNextJob('worker-4', new Date())).toBeNull();

      const stored = await readOrder(order.id);
      expect(stored?.status).toBe('failed');
      expect(stored?.attempts).toBe(CNC_MAX_ATTEMPTS);
      expect(stored?.claimToken).toBeNull();
      expect(stored?.lastError).toContain('Lease expired');
    });

    it('leaves a live job alone when the reaper runs', async () => {
      await queueOrder();
      const claimed = await claimNextJob('worker-a', new Date());

      expect(await failStaleExhaustedJobs()).toEqual([]);
      expect((await readOrder(claimed!.id))?.status).toBe('generating');
    });
  });

  describe('toPublicOrder', () => {
    it('strips every internal column, including the object key and Stripe/lease bookkeeping', async () => {
      const order = await queueOrder();
      const claimed = await claimNextJob('worker-a', new Date());
      const withInternals = await transitionOrder(claimed!.id, 'complete', {
        generatedAt: new Date(),
        zipKey: `cnc-packs/${BUYER_ID}/${order.licenceId}.zip`,
        fingerprintManifest: { seed: 'deadbeef', channels: { jitter: 0.004 } },
        lastError: 'ezdxf blew up in writer.py line 42',
      });

      const publicOrder = toPublicOrder(withInternals!);

      expect(publicOrder).not.toHaveProperty('fingerprintManifest');
      expect(publicOrder).not.toHaveProperty('claimToken');
      expect(publicOrder).not.toHaveProperty('workerId');
      expect(publicOrder).not.toHaveProperty('lastError');
      // The object store path never leaves the backend — downloads go through
      // a signed-URL route, not the raw key.
      expect(publicOrder).not.toHaveProperty('zipKey');
      expect(publicOrder).not.toHaveProperty('stripeCheckoutSessionId');
      expect(publicOrder).not.toHaveProperty('stripePaymentIntentId');
      expect(publicOrder).not.toHaveProperty('claimedAt');
      expect(publicOrder).not.toHaveProperty('heartbeatAt');
      expect(publicOrder).not.toHaveProperty('attempts');
      // Everything the buyer legitimately sees survives.
      expect(publicOrder.licenceId).toBe(order.licenceId);
      expect(publicOrder.status).toBe('ready');
      // And no leftover reference to the secret values anywhere in the payload.
      expect(JSON.stringify(publicOrder)).not.toContain('deadbeef');
      expect(JSON.stringify(publicOrder)).not.toContain('writer.py');
      expect(JSON.stringify(publicOrder)).not.toContain(order.licenceId + '.zip');
    });
  });
});
