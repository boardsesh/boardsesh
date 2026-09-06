import type { IncomingMessage, ServerResponse } from 'http';
import type { CncOrder } from '@boardsesh/db/schema';
import { applyCorsHeaders } from './cors';
import { sendJson } from './http-utils';
import { validateToken } from '../middleware/auth';
import { logger } from '../utils/logger';
import { getFromS3, isS3Configured } from '../storage/s3';
import { getOrderByLicenceId, recordDownload } from '../services/cnc/orders';
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

/** The pack's filename on the buyer's disk. Licence id only — it is already printed inside every file. */
function attachmentFilename(licenceId: string): string {
  return `boardsesh-build-plans-${licenceId}.zip`;
}

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

  // Checked before the status, because `refunded` is also "not ready" and the
  // buyer deserves the accurate answer: this is over, not pending.
  if (order.status === 'refunded' || order.refundedAt !== null) {
    sendJson(res, 403, { error: 'This order was refunded, so the pack is no longer available.' });
    return;
  }
  if (order.status !== 'ready' || !order.zipKey) {
    sendJson(res, 409, { error: 'This pack is not ready to download yet.' });
    return;
  }

  if (!isS3Configured('private')) {
    logger.error('[cnc-download] the private bucket is not configured; cannot serve a pack');
    sendJson(res, 503, { error: 'Downloads are unavailable right now.' });
    return;
  }

  const object = await getFromS3('private', order.zipKey);
  if (!object) {
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

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${attachmentFilename(order.licenceId)}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(object.contentLength != null ? { 'Content-Length': String(object.contentLength) } : {}),
  });
  object.stream.pipe(res);

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
