import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { eq } from 'drizzle-orm';
import { cncArtAssets, cncOrders, users, type CncOrderOptions } from '@boardsesh/db/schema';
import { db } from '../db/client';
import {
  attachAssetsToOrder,
  cncArtAssetKey,
  createArtAsset,
  getAssetForJob,
  getOwnedArtAsset,
  getOwnedArtAssets,
  isCncArtKey,
} from '../services/cnc/art-assets';

/**
 * Uploaded artwork ownership, against the real database.
 *
 * DB-backed because every property here IS a database property: a WHERE clause
 * that scopes by owner, a conditional UPDATE that refuses to steal an already
 * attached asset, and two foreign keys that deliberately behave differently
 * when their parent goes away. A mocked drizzle chain would assert the query we
 * wrote rather than the rows it returns.
 */

const DEFAULT_OPTIONS: CncOrderOptions = {
  sheetStock: '2440x1220',
  panelThicknessMm: 18,
  tnutHoleDiameterMm: 12.5,
  ledHoleDiameterMm: 12.5,
  kickerMatClearanceMm: 50,
  studClearanceOffsetMm: 60,
  gridPitchMm: 100,
  dxfFlavour: 'R12_circles',
  paper: 'A3',
  engraveHoldIds: false,
  engraveAngleTicks: false,
};

const LICENCE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
let licenceCounter = 0;

/** A distinct, well-formed licence id per row. */
function nextLicenceId(): string {
  licenceCounter += 1;
  let remaining = licenceCounter;
  let suffix = '';
  for (let position = 0; position < 6; position += 1) {
    suffix = LICENCE_ALPHABET[remaining % LICENCE_ALPHABET.length] + suffix;
    remaining = Math.floor(remaining / LICENCE_ALPHABET.length);
  }
  return `BS-CNC-${suffix}`;
}

async function insertUser(userId: string): Promise<void> {
  await db
    .insert(users)
    .values({ id: userId, email: `${userId}@cnc-art-test.local`, name: userId })
    .onConflictDoNothing();
}

async function insertOrder(userId: string) {
  const [order] = await db
    .insert(cncOrders)
    .values({
      licenceId: nextLicenceId(),
      userId,
      tier: 'personal',
      status: 'queued',
      boardName: 'kilter',
      layoutId: 8,
      sizeId: 25,
      setIds: '26,27,28,29',
      options: DEFAULT_OPTIONS,
      catalogVersion: '2026-09-06.1',
      licenseeName: 'Marco',
      licenseeEmail: 'marco@example.com',
      currency: 'AUD',
      amountCents: 14900,
    })
    .returning();
  return order;
}

/** One stored upload for `userId`. Returns the row. */
async function insertAsset(userId: string) {
  const id = randomUUID();
  return createArtAsset({
    id,
    userId,
    key: cncArtAssetKey(userId, id, 'svg'),
    mime: 'image/svg+xml',
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
  });
}

beforeEach(async () => {
  await db.delete(cncArtAssets);
  await db.delete(cncOrders);
  await insertUser('buyer-1');
  await insertUser('buyer-2');
});

describe('cncArtAssetKey', () => {
  it('produces a key the worker asset route will accept', () => {
    const key = cncArtAssetKey('buyer-1', '0b3f5a1c-1111-4222-8333-444455556666', 'svg');
    expect(key).toBe('cnc-art/buyer-1/0b3f5a1c-1111-4222-8333-444455556666.svg');
    expect(isCncArtKey(key)).toBe(true);
  });

  it('rejects a key that walks out of the artwork prefix', () => {
    // The one property that matters: the private bucket also holds user data
    // exports, so a traversal or a foreign prefix must never pass the gate.
    expect(isCncArtKey('cnc-art/buyer-1/../../exports/user-9.zip')).toBe(false);
    expect(isCncArtKey('exports/user-9.zip')).toBe(false);
  });
});

describe('getOwnedArtAsset', () => {
  it('returns the caller’s own asset', async () => {
    const asset = await insertAsset('buyer-1');
    await expect(getOwnedArtAsset('buyer-1', asset.id)).resolves.toMatchObject({
      id: asset.id,
      key: asset.key,
      mime: 'image/svg+xml',
      orderId: null,
    });
  });

  it('returns null for somebody else’s asset, exactly as for one that does not exist', async () => {
    const asset = await insertAsset('buyer-1');
    await expect(getOwnedArtAsset('buyer-2', asset.id)).resolves.toBeNull();
    await expect(getOwnedArtAsset('buyer-2', randomUUID())).resolves.toBeNull();
  });
});

describe('getOwnedArtAssets', () => {
  it('returns only the ids that are both real and the caller’s', async () => {
    const mine = await insertAsset('buyer-1');
    const theirs = await insertAsset('buyer-2');
    const unknownId = randomUUID();

    const owned = await getOwnedArtAssets('buyer-1', [mine.id, theirs.id, unknownId]);

    expect([...owned.keys()]).toEqual([mine.id]);
  });

  it('asks the database nothing when there are no ids', async () => {
    await expect(getOwnedArtAssets('buyer-1', [])).resolves.toEqual(new Map());
  });
});

describe('attachAssetsToOrder', () => {
  it('stamps the order onto every unattached asset', async () => {
    const first = await insertAsset('buyer-1');
    const second = await insertAsset('buyer-1');
    const order = await insertOrder('buyer-1');

    await expect(attachAssetsToOrder(order.id, [first.id, second.id])).resolves.toBe(2);

    const rows = await db.select().from(cncArtAssets).where(eq(cncArtAssets.orderId, order.id));
    expect(rows.map((row) => row.id).sort()).toEqual([first.id, second.id].sort());
  });

  it('leaves an asset stamped with the first order that bought it', async () => {
    const asset = await insertAsset('buyer-1');
    const firstOrder = await insertOrder('buyer-1');
    const secondOrder = await insertOrder('buyer-1');

    await attachAssetsToOrder(firstOrder.id, [asset.id]);
    // The field answers "may this file be deleted", and the answer is no from
    // the moment ANY licence depends on it — so the second order changes
    // nothing rather than moving the stamp off the licence that needs it.
    await expect(attachAssetsToOrder(secondOrder.id, [asset.id])).resolves.toBe(0);

    const [row] = await db.select().from(cncArtAssets).where(eq(cncArtAssets.id, asset.id));
    expect(row.orderId).toBe(firstOrder.id);
  });
});

describe('getAssetForJob', () => {
  it('returns the asset the order actually bought', async () => {
    const asset = await insertAsset('buyer-1');
    const order = await insertOrder('buyer-1');
    await attachAssetsToOrder(order.id, [asset.id]);

    await expect(getAssetForJob(order.id, asset.id)).resolves.toMatchObject({
      id: asset.id,
      key: asset.key,
      mime: 'image/svg+xml',
    });
  });

  it('returns null for an asset another order bought', async () => {
    const asset = await insertAsset('buyer-1');
    const boughtBy = await insertOrder('buyer-1');
    const otherOrder = await insertOrder('buyer-1');
    await attachAssetsToOrder(boughtBy.id, [asset.id]);

    await expect(getAssetForJob(otherOrder.id, asset.id)).resolves.toBeNull();
  });

  it('returns null once the asset row is gone, leaving the order intact', async () => {
    const asset = await insertAsset('buyer-1');
    const order = await insertOrder('buyer-1');
    await attachAssetsToOrder(order.id, [asset.id]);

    // What happens in production when a buyer closes their account:
    // `cnc_art_assets.user_id` CASCADEs while `cnc_orders.user_id` is SET NULL,
    // so the upload goes and the licence stays. That asymmetry is why the order
    // keeps its own copy of the key and mime, and why the worker asset route
    // falls back to it rather than 404ing a paid regenerate.
    await db.delete(cncArtAssets).where(eq(cncArtAssets.id, asset.id));

    await expect(getAssetForJob(order.id, asset.id)).resolves.toBeNull();
    const [survivingOrder] = await db.select().from(cncOrders).where(eq(cncOrders.id, order.id));
    expect(survivingOrder.id).toBe(order.id);
  });
});
