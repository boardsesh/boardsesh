import type { IncomingMessage, ServerResponse } from 'http';
import type { CncOrder } from '@boardsesh/db/schema';
import { applyCorsHeaders } from './cors';
import { pipeObjectStream, sendJson } from './http-utils';
import { validateToken } from '../middleware/auth';
import { logger } from '../utils/logger';
import { getFromS3, getS3ObjectMetadata, isS3Configured } from '../storage/s3';
import { getOrderByLicenceId, recordDownload } from '../services/cnc/orders';
import { isDownloadable, type CncDeliverable } from '../services/cnc/order-state';
import { verifyDownloadGrant } from '../services/cnc/download-grant';
import { isLicenceId } from '../services/cnc/licence-id';
import { CNC_KICKER_SET_IDS, parseSetIds } from '../services/cnc/catalog';
import { captureBackendEvent } from '../services/analytics/posthog';

/**
 * GET /api/cnc/packs/:licenceId/download
 *
 * The only way a bought pack leaves object storage. There is no signed
 * object-store URL anywhere in this system: every download re-checks ownership
 * and refund status at the moment it is served, which is what makes a refund
 * take effect immediately and what keeps a link out of an inbox from working
 * for whoever it is forwarded to.
 *
 * Two ways to authenticate, because there are two callers:
 * - **Bearer token** — the app, cross-origin, which is why this route does CORS
 *   the same way `user-data-export.ts` does.
 * - **`?token=` grant** — a browser navigation, which cannot carry a header.
 *   Minted by `Mutation.createCncDownloadGrant`, good for five minutes, bound
 *   to one order and one user, and still re-checked against the order here.
 *
 * Status codes:
 * - **404** for a licence that does not exist AND for one belonging to someone
 *   else, identically. A licence id identifies an order; it never grants access
 *   to one, and distinguishing the two would turn the id space into an oracle.
 * - **409** when the pack is not `ready` — still queued, generating, or failed.
 * - **403** once the order is refunded. Distinct from 409 on purpose: the buyer
 *   is not waiting for anything, and the order page says so.
 */

/** Nothing about which of the two auth paths failed. Both mean "sign in again". */
const UNAUTHORIZED = { error: 'Authentication required' };

type Requester = { userId: string; via: 'bearer' | 'grant'; grantOrderId?: number };

/**
 * Who is asking, or null having already answered.
 *
 * The grant path is tried first only when there is no Authorization header, so
 * a signed-in app never pays for the HMAC.
 */
async function identifyRequester(req: IncomingMessage, res: ServerResponse, url: URL): Promise<Requester | null> {
  const authHeader = req.headers.authorization;
  const bearer = typeof authHeader === 'string' ? /^Bearer\s+(.+)$/i.exec(authHeader)?.[1] : undefined;

  if (bearer) {
    const auth = await validateToken(bearer);
    if (!auth) {
      sendJson(res, 401, UNAUTHORIZED);
      return null;
    }
    return { userId: auth.userId, via: 'bearer' };
  }

  const grantToken = url.searchParams.get('token');
  if (grantToken) {
    const claims = verifyDownloadGrant(grantToken, new Date());
    if (!claims) {
      // Expired, forged, or minted before a secret rotation. All the same to
      // the holder: ask for a new one.
      sendJson(res, 401, { error: 'This download link has expired. Open the order page for a fresh one.' });
      return null;
    }
    return { userId: claims.userId, via: 'grant', grantOrderId: claims.orderId };
  }

  sendJson(res, 401, UNAUTHORIZED);
  return null;
}

/**
 * The only object keys a pack may be served from.
 *
 * `zipKey` is written by the worker's completion report and is matched against
 * `cncPackOutputKey` there, so a key outside this shape means something already
 * went wrong upstream. Re-checking it here is what keeps that upstream bug from
 * becoming an arbitrary read: the private bucket also holds user data exports,
 * and this route streams whatever key the row names to an authenticated caller.
 * Cheap, local, and it fails closed.
 */
const PACK_KEY_PATTERN = /^cnc-packs\/[A-Za-z0-9._-]+\/BS-CNC-[A-Z0-9]{6}\.zip$/;

/** The same rule for the preview zip, which lives beside the pack as `_preview.zip`. */
const PREVIEW_ZIP_KEY_PATTERN = /^cnc-packs\/[A-Za-z0-9._-]+\/BS-CNC-[A-Z0-9]{6}_preview\.zip$/;

/** And for one watermarked PNG, which lives in a directory under the licence. */
const PREVIEW_IMAGE_KEY_PATTERN = /^cnc-packs\/[A-Za-z0-9._-]+\/BS-CNC-[A-Z0-9]{6}\/preview\/[A-Za-z0-9._-]+\.png$/;

/** The pack's filename on the buyer's disk. Licence id only — it is already printed inside every file. */
function attachmentFilename(licenceId: string, kind: CncDeliverable): string {
  return kind === 'preview'
    ? `boardsesh-build-plans-preview-${licenceId}.zip`
    : `boardsesh-build-plans-${licenceId}.zip`;
}

/**
 * Which deliverable the caller asked for.
 *
 * Anything that is not exactly `preview` is the full pack: the parameter is new
 * and every existing caller omits it, so defaulting the other way would have
 * turned every download in flight into a watermarked JPEG-of-a-DXF.
 */
function requestedKind(url: URL): CncDeliverable {
  return url.searchParams.get('kind') === 'preview' ? 'preview' : 'full';
}

/**
 * Count the download.
 *
 * Only the PAID pack. A preview fetch is not a purchase being used — the event
 * exists to spot a licensed file being pulled twenty times, and folding free
 * watermarked fetches into that number would make it mean nothing. The preview
 * has its own funnel event at generation.
 */
function captureDownload(order: CncOrder, via: Requester['via']): void {
  const setIds = parseSetIds(order.setIds) ?? [];
  captureBackendEvent('Build Plans Pack Downloaded', {
    // The account can be null (the licence outlives it), so the licence id is
    // the fallback identity rather than dropping the event.
    distinctId: order.userId ?? order.licenceId,
    properties: {
      tier: order.tier,
      board_name: order.boardName,
      layout_id: order.layoutId,
      size_id: order.sizeId,
      kicker: setIds.some((setId) => CNC_KICKER_SET_IDS.includes(setId)),
      has_artwork: Array.isArray(order.artwork) && order.artwork.length > 0,
      // Which download count this is, so a re-download is distinguishable from
      // a first one without joining back to the order table.
      download_index: order.downloadCount + 1,
      auth: via,
    },
  });
}

export async function handleCncPackDownload(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const licenceId = decodeURIComponent(url.pathname.split('/')[4] ?? '');
  if (!isLicenceId(licenceId)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const requester = await identifyRequester(req, res, url);
  if (!requester) return;

  const order = await getOrderByLicenceId(licenceId);
  // One response for three different misses: no such licence, someone else's
  // licence, and a grant minted for a different order. A caller can tell none
  // of them apart, which is the point.
  if (!order || order.userId !== requester.userId) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (requester.grantOrderId !== undefined && requester.grantOrderId !== order.id) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const kind = requestedKind(url);

  // Checked before the status, because `refunded` is also "not ready" and the
  // buyer deserves the accurate answer: this is over, not pending.
  if (order.status === 'refunded' || order.refundedAt !== null) {
    sendJson(res, 403, { error: 'This order was refunded, so the pack is no longer available.' });
    return;
  }

  const notReady =
    kind === 'preview' ? 'This preview is not ready to download yet.' : 'This pack is not ready to download yet.';
  const objectKey = kind === 'preview' ? order.previewZipKey : order.zipKey;
  const expectedSize = kind === 'preview' ? order.previewZipSizeBytes : order.zipSizeBytes;
  // The same predicate `Mutation.createCncDownloadGrant` answered when it minted
  // the token, asked again at the moment of serving: a grant says who is asking,
  // never what they may have, and the order may have moved since.
  if (!isDownloadable(order, kind) || !objectKey) {
    sendJson(res, 409, { error: notReady });
    return;
  }

  const keyPattern = kind === 'preview' ? PREVIEW_ZIP_KEY_PATTERN : PACK_KEY_PATTERN;
  if (!keyPattern.test(objectKey)) {
    // Never the buyer's problem, and never something to act on: refuse to read
    // the key at all rather than find out what is there.
    logger.error('[cnc-download] order is ready but its zip key is not a pack key; refusing to read it', {
      orderId: order.id,
      licenceId: order.licenceId,
      kind,
    });
    sendJson(res, 409, { error: notReady });
    return;
  }

  if (!isS3Configured('private')) {
    logger.error('[cnc-download] the private bucket is not configured; cannot serve a pack');
    sendJson(res, 503, { error: 'Downloads are unavailable right now.' });
    return;
  }

  // HEAD before GET. The order row carries the size the worker's completion
  // reported and Boardsesh verified, so the object can be checked against it
  // before a single byte is committed to the wire — once the 200 and its
  // Content-Length are out, there is no status left to say "this is the wrong
  // file". A mismatch means the object was replaced or truncated after it was
  // accepted, and the fingerprint manifest no longer describes what is in the
  // bucket; that pack must not be handed to a buyer under a licence id.
  const metadata = await getS3ObjectMetadata('private', objectKey);
  if (!metadata) {
    // The order says ready but the object is gone. That is an operator problem
    // (a lifecycle rule, a bucket migration), not something the buyer can fix,
    // so it is loud in the log and a plain 404 to them.
    logger.error('[cnc-download] order is ready but its object is missing', {
      orderId: order.id,
      licenceId: order.licenceId,
    });
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (expectedSize != null && metadata.contentLength != null && metadata.contentLength !== expectedSize) {
    logger.error('[cnc-download] stored pack size does not match the order; refusing to serve it', {
      orderId: order.id,
      licenceId: order.licenceId,
      kind,
      expected: expectedSize,
      actual: metadata.contentLength,
    });
    sendJson(res, 500, { error: 'Downloads are unavailable right now.' });
    return;
  }

  const object = await getFromS3('private', objectKey);
  if (!object) {
    // Raced the HEAD above (a lifecycle delete between the two calls). Same
    // answer as a HEAD that found nothing.
    logger.error('[cnc-download] order is ready but its object is missing', {
      orderId: order.id,
      licenceId: order.licenceId,
    });
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${attachmentFilename(order.licenceId, kind)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(object.contentLength != null ? { 'Content-Length': String(object.contentLength) } : {}),
  });
  pipeObjectStream(object.stream, res, {
    route: 'cnc-download',
    orderId: order.id,
    licenceId: order.licenceId,
  });

  // Only the paid pack is counted. `download_count` and its analytics event are
  // about a licensed file leaving the bucket; a buyer flicking through their own
  // watermarked preview is not that, and pooling the two would make the number
  // that exists to spot over-fetching mean nothing.
  if (kind === 'full') {
    // Counted once the bytes are on their way, not once they arrive: a client
    // that aborts halfway still asked for the pack, and that is the behaviour
    // worth noticing. Both are best-effort — a failed count must never turn a
    // successful download into an error, and the response has already started.
    try {
      await recordDownload(order.id, new Date());
    } catch (error) {
      logger.warn('[cnc-download] could not record the download', { orderId: order.id, error });
    }
    captureDownload(order, requester.via);
  }
}

/**
 * GET /api/cnc/packs/:licenceId/preview/:name?token=
 *
 * One watermarked preview sheet, as an image.
 *
 * The only route in this system a browser fetches as a `<img src>`, which is
 * what shapes it: a one-hour grant instead of five minutes (see
 * `CNC_PREVIEW_IMAGE_GRANT_TTL_MS`), and a private, hour-long cache instead of
 * `no-store` — an order page holds a dozen of these and re-fetching them on
 * every scroll is a dozen HMAC verifications and a dozen bucket reads for a
 * picture that cannot change.
 *
 * `:name` is a BASENAME, never a key. It is matched against the basenames of
 * `preview_keys` — keys the worker's completion already proved sit under this
 * order's prefix — and the key that answers is the stored one. So no part of
 * what a client holds is a path into the private bucket, which also holds user
 * data exports.
 */
export async function handleCncPackPreviewImage(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!applyCorsHeaders(req, res)) return;

  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  const segments = url.pathname.split('/');
  const licenceId = decodeURIComponent(segments[4] ?? '');
  const name = decodeURIComponent(segments[6] ?? '');
  if (!isLicenceId(licenceId) || !name) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const requester = await identifyRequester(req, res, url);
  if (!requester) return;

  const order = await getOrderByLicenceId(licenceId);
  // One answer for every miss, exactly as the download route does: unknown
  // licence, somebody else's licence, or a grant minted for another order.
  if (!order || order.userId !== requester.userId) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (requester.grantOrderId !== undefined && requester.grantOrderId !== order.id) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (order.status === 'refunded' || order.refundedAt !== null) {
    sendJson(res, 403, { error: 'This order was refunded, so the preview is no longer available.' });
    return;
  }
  if (!isDownloadable(order, 'preview')) {
    sendJson(res, 409, { error: 'This preview is not ready yet.' });
    return;
  }

  const storedKeys = Array.isArray(order.previewKeys) ? order.previewKeys : [];
  const objectKey = storedKeys.find((key) => key.split('/').pop() === name);
  // A name that is not one of this order's sheets is a 404 rather than a 400:
  // the client got the list from us, so the only ways to be here are a stale
  // page and somebody guessing.
  if (!objectKey || !PREVIEW_IMAGE_KEY_PATTERN.test(objectKey)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (!isS3Configured('private')) {
    logger.error('[cnc-download] the private bucket is not configured; cannot serve a preview image');
    sendJson(res, 503, { error: 'Previews are unavailable right now.' });
    return;
  }

  const object = await getFromS3('private', objectKey);
  if (!object) {
    logger.error('[cnc-download] preview image is referenced by an order but missing from storage', {
      orderId: order.id,
      licenceId: order.licenceId,
      objectKey,
    });
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  res.writeHead(200, {
    // Always PNG: the completion refuses to store a preview key that does not
    // end in `.png`, so there is no second content type to negotiate.
    'Content-Type': 'image/png',
    // `private` because the grant in the URL makes this one buyer's image — a
    // shared cache must never hold it — and an hour because that is what the
    // grant is good for anyway.
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
    ...(object.contentLength != null ? { 'Content-Length': String(object.contentLength) } : {}),
  });
  pipeObjectStream(object.stream, res, {
    route: 'cnc-preview-image',
    orderId: order.id,
    licenceId: order.licenceId,
  });
}
