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
  countOrdersCreatedSince,
  createPreviewOrder,
  failStaleExhaustedJobs,
  findPreviewOrderByConfigHash,
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

/** A fresh preview order: the first row of every purchase. */
let configHashSeed = 0;
async function createPreview(userId = BUYER_ID, configHash?: string): Promise<CncOrder> {
  configHashSeed += 1;
  return createPreviewOrder({
    userId,
    boardName: 'kilter',
    layoutId: 8,
    sizeId: 25,
    setIds: '26,27,28,29',
    options: DEFAULT_OPTIONS,
    catalogVersion: CNC_CATALOG_VERSION,
    // Unique per fixture unless a test cares: two fixtures sharing a hash would
    // make every dedupe assertion depend on creation order.
    configHash: configHash ?? `hash-${String(configHashSeed)}`,
  });
}

/**
 * Walk a preview to `preview_ready` without going through the queue.
 *
 * Driven by explicit transitions rather than by `claimNextJob`, because the
 * claim prefers full jobs: a fixture that claimed would pick up whichever paid
 * order an earlier line of the same test had already queued.
 */
async function readyPreview(userId = BUYER_ID, configHash?: string): Promise<CncOrder> {
  const order = await createPreview(userId, configHash);
  const claimToken = `fixture-token-${String(order.id)}`;
  const claimedAt = new Date();
  const claimed = await transitionOrder(order.id, 'previewClaim', {
    claimToken,
    attempts: 1,
    workerId: 'fixture-worker',
    claimedAt,
    heartbeatAt: claimedAt,
  });
  if (!claimed) throw new Error('failed to claim fixture preview');
  const ready = await transitionOrder(
    order.id,
    'previewComplete',
    {
      previewZipKey: `cnc-packs/${userId}/${order.licenceId}_preview.zip`,
      previewZipSizeBytes: 1024,
      previewGeneratedAt: new Date(),
      previewKeys: [`cnc-packs/${userId}/${order.licenceId}/preview/panel1.png`],
      previewsGenerated: 1,
    },
    { claimToken },
  );
  if (!ready) throw new Error('failed to ready fixture preview');
  return ready;
}

/** A finalised, unpaid order: what the buyer sends to Stripe. */
async function createOrder(userId = BUYER_ID): Promise<CncOrder> {
  const ready = await readyPreview(userId);
  const finalised = await transitionOrder(ready.id, 'finalise', {
    tier: 'personal',
    licenseeName: 'Test Buyer',
    licenseeEmail: 'buyer@example.com',
    licenceAcceptedAt: new Date(),
    currency: 'AUD',
    amountCents: 14900,
    // The same reset `finaliseCncOrder` writes: the pack gets its own three
    // attempts rather than inheriting whatever the preview spent.
    attempts: 0,
    claimToken: null,
    workerId: null,
    claimedAt: null,
    heartbeatAt: null,
  });
  if (!finalised) throw new Error('failed to finalise fixture order');
  return finalised;
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

/**
 * Every column of a `cnc_orders` row that a buyer is allowed to see.
 *
 * Written out rather than derived, because deriving it from the table (or from
 * `PublicCncOrder`) would re-derive whatever mistake was just made: a new
 * internal column omitted from `CncOrderInternalColumn` is carried straight
 * through by `Omit`, type-checks everywhere, and reaches the buyer. This list
 * is the one place that does not follow the schema, so adding a column breaks
 * this test until someone has decided which side of the line it sits on.
 *
 * Adding a column: put it here if the buyer may see it, or in
 * `CncOrderInternalColumn` (and `toPublicOrder`'s destructure) if not.
 */
const BUYER_VISIBLE_COLUMNS = [
  'id',
  'licenceId',
  'userId',
  'tier',
  'status',
  'boardName',
  'layoutId',
  'sizeId',
  'setIds',
  'options',
  'artwork',
  'catalogVersion',
  'licenseeName',
  'licenseeEmail',
  'customerSiteName',
  'licenceAcceptedAt',
  'currency',
  'amountCents',
  'paidAt',
  'refundedAt',
  'queuedAt',
  'generation',
  'generatedAt',
  'zipSizeBytes',
  // The pack's checksum: the buyer's own way to tell a truncated download from
  // a complete one, so it stays on their side of the line.
  'zipSha256',
  // The preview's own metadata. The KEYS are internal (they are bucket paths,
  // and the images reach the buyer as `previewImages` URLs built from their
  // basenames), but "is there a preview, how big, when" is the buyer's.
  'configHash',
  'previewZipSizeBytes',
  'previewGeneratedAt',
  'previewsGenerated',
  'downloadCount',
  'lastDownloadedAt',
  'createdAt',
  'updatedAt',
] as const;

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

  describe('createPreviewOrder', () => {
    it('writes a free preview, already queued, with a fresh licence id and nothing licensed', async () => {
      const order = await createPreview();

      expect(order.status).toBe('preview_queued');
      expect(isLicenceId(order.licenceId)).toBe(true);
      // Nothing has been sold: no tier, no licensee, no price.
      expect(order.tier).toBeNull();
      expect(order.licenseeName).toBeNull();
      expect(order.amountCents).toBeNull();
      expect(order.licenceAcceptedAt).toBeNull();
      expect(order.attempts).toBe(0);
      expect(order.generation).toBe(1);
      expect(order.downloadCount).toBe(0);
      expect(order.previewsGenerated).toBe(0);
      // Claimable the instant it exists — unlike the paid path, there is no
      // payment to wait for.
      expect(order.queuedAt).not.toBeNull();
      expect(order.options).toEqual(DEFAULT_OPTIONS);
      expect(order.catalogVersion).toBe(CNC_CATALOG_VERSION);
    });

    it('takes its tier and licensee only at finalise', async () => {
      const order = await createOrder();

      expect(order.status).toBe('pending_payment');
      expect(order.tier).toBe('personal');
      expect(order.licenseeName).toBe('Test Buyer');
      expect(order.amountCents).toBe(14900);
      expect(order.licenceAcceptedAt).not.toBeNull();
      // The same licence id it previewed under.
      expect(isLicenceId(order.licenceId)).toBe(true);
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

  describe('preview dedupe and the hourly count', () => {
    it("finds this buyer's live preview of exactly this configuration", async () => {
      const order = await createPreview(BUYER_ID, 'same-wall');

      expect((await findPreviewOrderByConfigHash(BUYER_ID, 'same-wall'))?.id).toBe(order.id);
      // Still a match while it generates, and once it is ready: both are "the
      // preview you already asked for".
      await transitionOrder(order.id, 'previewClaim', { claimToken: 'tok', attempts: 1 });
      expect((await findPreviewOrderByConfigHash(BUYER_ID, 'same-wall'))?.id).toBe(order.id);
      await transitionOrder(order.id, 'previewComplete', { previewGeneratedAt: new Date() }, { claimToken: 'tok' });
      expect((await findPreviewOrderByConfigHash(BUYER_ID, 'same-wall'))?.id).toBe(order.id);
    });

    it("never hands one buyer another buyer's preview of the same wall", async () => {
      await createPreview(OTHER_BUYER_ID, 'same-wall');
      expect(await findPreviewOrderByConfigHash(BUYER_ID, 'same-wall')).toBeNull();
    });

    it('stops matching once the preview failed, so asking again really retries', async () => {
      const order = await createPreview(BUYER_ID, 'same-wall');
      await transitionOrder(order.id, 'previewClaim', { claimToken: 'tok', attempts: 3 });
      await transitionOrder(order.id, 'previewFail', { status: 'preview_failed' }, { claimToken: 'tok' });

      expect(await findPreviewOrderByConfigHash(BUYER_ID, 'same-wall')).toBeNull();
    });

    it('stops matching once the order is being bought, so a purchase is never returned as a free preview', async () => {
      const ready = await readyPreview(BUYER_ID, 'same-wall');
      await transitionOrder(ready.id, 'finalise', { tier: 'personal' });

      expect(await findPreviewOrderByConfigHash(BUYER_ID, 'same-wall')).toBeNull();
    });

    it("counts this buyer's recent orders and nobody else's", async () => {
      await createPreview();
      await createPreview();
      await createPreview(OTHER_BUYER_ID);

      const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
      expect(await countOrdersCreatedSince(BUYER_ID, hourAgo)).toBe(2);
      expect(await countOrdersCreatedSince(OTHER_BUYER_ID, hourAgo)).toBe(1);
      // Outside the window is outside the count.
      expect(await countOrdersCreatedSince(BUYER_ID, new Date(Date.now() + 60_000))).toBe(0);
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

    it('hands out a queued preview when there is no paid work', async () => {
      const preview = await createPreview();

      const claimed = await claimNextJob('worker-a', new Date());

      expect(claimed?.id).toBe(preview.id);
      expect(claimed?.status).toBe('preview_generating');
      expect(claimed?.attempts).toBe(1);
      expect(claimed?.claimToken).toBeTruthy();
    });

    it('serves every paid pack before any free preview, however long the preview has waited', async () => {
      // The preview is older, so a plain oldest-first claim would take it. A
      // buyer who has paid must never wait behind somebody still deciding.
      const preview = await createPreview();
      const paid = await queueOrder();

      const first = await claimNextJob('worker-a', new Date());
      expect(first?.id).toBe(paid.id);
      expect(first?.status).toBe('generating');

      const second = await claimNextJob('worker-b', new Date());
      expect(second?.id).toBe(preview.id);
      expect(second?.status).toBe('preview_generating');
    });

    it('reclaims a stale preview lease and gives up on it after the same three attempts', async () => {
      const preview = await createPreview();

      for (let attempt = 1; attempt <= CNC_MAX_ATTEMPTS; attempt += 1) {
        const claimed = await claimNextJob(`worker-${String(attempt)}`, new Date());
        expect(claimed?.id).toBe(preview.id);
        expect(claimed?.attempts).toBe(attempt);
        await expireLease(preview.id);
      }

      expect(await claimNextJob('worker-4', new Date())).toBeNull();

      const stored = await readOrder(preview.id);
      // Its own terminal status, not `failed`: nothing was paid for, and the
      // buyer\'s page says "try again" rather than "we have been notified".
      expect(stored?.status).toBe('preview_failed');
      expect(stored?.claimToken).toBeNull();
    });

    it('gives the paid pack its own three attempts, whatever the preview spent', async () => {
      const preview = await createPreview();
      // The preview needed two goes.
      await claimNextJob('worker-a', new Date());
      await expireLease(preview.id);
      await claimNextJob('worker-b', new Date());
      expect((await readOrder(preview.id))?.attempts).toBe(2);

      await transitionOrder(
        preview.id,
        'previewComplete',
        { previewGeneratedAt: new Date() },
        { claimToken: (await readOrder(preview.id))!.claimToken! },
      );
      await transitionOrder(preview.id, 'finalise', {
        tier: 'personal',
        attempts: 0,
        claimToken: null,
        workerId: null,
        claimedAt: null,
        heartbeatAt: null,
      });
      await transitionOrder(preview.id, 'checkoutCompleted', { queuedAt: new Date(), paidAt: new Date() });

      const claimed = await claimNextJob('worker-c', new Date());
      expect(claimed?.id).toBe(preview.id);
      expect(claimed?.attempts).toBe(1);
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

    it('strips the preview object keys while keeping what the buyer is shown about it', async () => {
      const ready = await readyPreview();

      const publicOrder = toPublicOrder(ready);

      // The keys are bucket paths; the images reach the buyer as
      // `previewImages` URLs built from their basenames instead.
      expect(publicOrder).not.toHaveProperty('previewZipKey');
      expect(publicOrder).not.toHaveProperty('previewKeys');
      expect(JSON.stringify(publicOrder)).not.toContain('_preview.zip');
      expect(JSON.stringify(publicOrder)).not.toContain('panel1.png');
      // What they are shown survives.
      expect(publicOrder.previewGeneratedAt).not.toBeNull();
      expect(publicOrder.previewZipSizeBytes).toBe(1024);
      expect(publicOrder.previewsGenerated).toBe(1);
    });

    it('returns exactly the allow-listed columns, so a new column cannot leak in silently', async () => {
      const order = await queueOrder();
      const claimed = await claimNextJob('worker-a', new Date());
      const fullRow = await transitionOrder(claimed!.id, 'complete', {
        generatedAt: new Date(),
        zipKey: `cnc-packs/${BUYER_ID}/${order.licenceId}.zip`,
        fingerprintManifest: { seed: 'deadbeef' },
      });

      expect(Object.keys(toPublicOrder(fullRow!)).sort()).toEqual([...BUYER_VISIBLE_COLUMNS].sort());
    });
  });
});
