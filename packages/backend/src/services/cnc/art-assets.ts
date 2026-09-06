import { and, eq, inArray, isNull } from 'drizzle-orm';
import { cncArtAssets, type CncArtAsset } from '@boardsesh/db/schema';
import { db } from '../../db/client';

/**
 * Uploaded artwork: who owns it, where its bytes are, and which order bought it.
 *
 * Every read here is scoped by an owner or by an order. That is the whole point
 * of the table: without it an `assetId` in a checkout request would be an
 * unauthenticated pointer into the private bucket, which also holds user data
 * exports. An asset id on its own proves nothing, and no function in this
 * module will resolve one without also being told whose it should be.
 *
 * The upload route that creates rows lands in a later change; `createArtAsset`
 * is here now because the ownership rules only make sense next to the thing
 * that writes them.
 */

/**
 * Object-key prefix for buyer artwork in the PRIVATE bucket.
 *
 * Its own prefix rather than a folder inside an existing one: a lifecycle rule
 * that sweeps unattached uploads, and any future bulk operation on buyer
 * artwork, has to be expressible as a prefix without catching anything else.
 */
export const CNC_ART_KEY_PREFIX = 'cnc-art';

/**
 * The shape of a key this module will ever produce or accept.
 *
 * Matched rather than trusted wherever a key comes back out of storage or out
 * of an order's JSON column: a value that reached either through some future
 * bug must not be able to make the worker asset route read an arbitrary object
 * out of the private bucket.
 */
export const CNC_ART_KEY_PATTERN = new RegExp(
  `^${CNC_ART_KEY_PREFIX}/[A-Za-z0-9._-]{1,128}/[A-Za-z0-9-]{1,64}\\.[A-Za-z0-9]{1,8}$`,
);

export function isCncArtKey(key: string): boolean {
  return CNC_ART_KEY_PATTERN.test(key);
}

/** Build the canonical key for one upload. The only place a key is ever composed. */
export function cncArtAssetKey(userId: string, assetId: string, extension: string): string {
  return `${CNC_ART_KEY_PREFIX}/${userId}/${assetId}.${extension}`;
}

export type CreateArtAssetInput = {
  /** A uuid the caller generated; it is also the `<uuid>` segment of `key`. */
  id: string;
  userId: string;
  key: string;
  /** Sniffed from the stored bytes, never taken from the upload's own header. */
  mime: string;
  sizeBytes: number;
  /** Pixel dimensions for a raster upload. Null for an SVG, which has no intrinsic pixel size. */
  widthPx?: number | null;
  heightPx?: number | null;
  /** Of the STORED bytes — an SVG is sanitised and re-serialised before it is written. */
  sha256: string;
};

/**
 * Record an upload that is already in the bucket.
 *
 * Written after the object, deliberately. A row with no object behind it is a
 * broken asset the buyer can select and the generator then cannot read; an
 * object with no row is an orphan the lifecycle sweep collects. The second
 * failure is the cheap one.
 */
export async function createArtAsset(input: CreateArtAssetInput): Promise<CncArtAsset> {
  const [asset] = await db
    .insert(cncArtAssets)
    .values({
      id: input.id,
      userId: input.userId,
      key: input.key,
      mime: input.mime,
      sizeBytes: input.sizeBytes,
      widthPx: input.widthPx ?? null,
      heightPx: input.heightPx ?? null,
      sha256: input.sha256,
    })
    .returning();
  return asset;
}

/**
 * One asset, but only if it is this user's.
 *
 * Ownership is in the WHERE clause rather than checked on the returned row, so
 * there is no version of this function that hands back somebody else's asset
 * and trusts the caller to notice. A miss and a foreign asset are the same
 * `null` for the same reason `cncOrder` returns null for both: distinguishing
 * them turns the id space into an oracle for which uploads exist.
 */
export async function getOwnedArtAsset(userId: string, assetId: string): Promise<CncArtAsset | null> {
  const [asset] = await db
    .select()
    .from(cncArtAssets)
    .where(and(eq(cncArtAssets.id, assetId), eq(cncArtAssets.userId, userId)))
    .limit(1);
  return asset ?? null;
}

/**
 * Every one of these assets that belongs to this user, keyed by id.
 *
 * One query for the whole artwork list rather than one per item: checkout
 * validates up to four assets, and a per-item round trip would make the
 * ownership check the slowest part of opening a Stripe session. A caller
 * compares the map's size against what it asked for — an id that is missing is
 * either not real or not theirs, and both answers are "refuse the checkout".
 */
export async function getOwnedArtAssets(
  userId: string,
  assetIds: readonly string[],
): Promise<Map<string, CncArtAsset>> {
  const wanted = [...new Set(assetIds)];
  if (wanted.length === 0) return new Map();

  const assets = await db
    .select()
    .from(cncArtAssets)
    .where(and(eq(cncArtAssets.userId, userId), inArray(cncArtAssets.id, wanted)));

  return new Map(assets.map((asset) => [asset.id, asset]));
}

/**
 * Stamp the order that bought these assets onto them.
 *
 * Only assets that are still unattached are claimed. An asset reused in a
 * second order keeps its first order's stamp, which is what the field is for:
 * it answers "may this file be deleted", and the answer is no from the moment
 * ANY licence depends on it. Nothing downstream reads `order_id` to decide what
 * a job may fetch — the order's own artwork JSON does that — so a second order
 * losing the stamp costs nothing.
 *
 * Best-effort by design: it runs after the order row exists, and a lost write
 * here means an attached file looks like a draft to a cleanup sweep, never a
 * checkout that fails.
 */
export async function attachAssetsToOrder(orderId: number, assetIds: readonly string[]): Promise<number> {
  const wanted = [...new Set(assetIds)];
  if (wanted.length === 0) return 0;

  const attached = await db
    .update(cncArtAssets)
    .set({ orderId })
    .where(and(inArray(cncArtAssets.id, wanted), isNull(cncArtAssets.orderId)))
    .returning({ id: cncArtAssets.id });

  return attached.length;
}

/**
 * The asset one generation job is allowed to read.
 *
 * Scoped to the order rather than to a user, because the caller is the pack
 * generator: it holds the job's lease, not a session. The lease is checked by
 * the route before this runs, so the two together mean "an asset that this
 * order bought, fetched by the worker that is currently building it".
 *
 * Returns null for an asset whose row is gone — the buyer deleted their account
 * — which is not the same as an error. The order's own `artwork` JSON keeps a
 * copy of the key and mime for exactly that case, so the route falls back to it
 * and a regenerate still works after the account that uploaded the file is
 * closed.
 */
export async function getAssetForJob(orderId: number, assetId: string): Promise<CncArtAsset | null> {
  const [asset] = await db
    .select()
    .from(cncArtAssets)
    .where(and(eq(cncArtAssets.id, assetId), eq(cncArtAssets.orderId, orderId)))
    .limit(1);
  return asset ?? null;
}
