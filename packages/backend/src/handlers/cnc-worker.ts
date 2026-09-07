import type { IncomingMessage, ServerResponse } from 'http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { CncOrder } from '@boardsesh/db/schema';
import { pipeObjectStream, readJsonBody, sendJson } from './http-utils';
import { logger } from '../utils/logger';
import { getBucketName, getFromS3, getS3ObjectMetadata, isS3Configured } from '../storage/s3';
import {
  claimNextJob,
  failStaleExhaustedJobs,
  getOrderById,
  recordWorkerHeartbeat,
  transitionOrder,
  type CncOrderPatch,
} from '../services/cnc/orders';
import {
  deliverableForStatus,
  nextStatusAfterFailure,
  type CncDeliverable,
  type CncOrderStatus,
} from '../services/cnc/order-state';
import {
  buildWorkerJob,
  cncPackOutputKey,
  cncPreviewOutputKey,
  cncPreviewPrefix,
  CncJobPayloadError,
} from '../services/cnc/job-payload';
import { getArtAssetById, getAssetForJob, isCncArtKey } from '../services/cnc/art-assets';
import { describeBoard } from '../services/cnc/catalog';
import { sendCncPackFailedAdminEmail, sendCncPackReadyEmail } from '../email/cnc-emails';
import { webPublicUrl } from '../email/email-service';
import { captureBackendEvent } from '../services/analytics/posthog';
import { CNC_KICKER_SET_IDS, parseSetIds } from '../services/cnc/catalog';

/**
 * The pack generator's job API.
 *
 * The worker is a separate private service that PULLS work: it claims a job,
 * heartbeats while it runs, and reports the result. Boardsesh never calls it to
 * start a job, which is what lets the worker scale, restart and be redeployed
 * without anything here knowing.
 *
 * Every route is bearer-authenticated with `CNC_WORKER_SECRET` and, apart from
 * the claim itself, carries the job's `claimToken` as well. The secret says
 * "you are the worker fleet"; the claim token says "you are the worker that
 * currently holds THIS job". Both are needed, because a worker that lost its
 * lease is still a legitimate member of the fleet and must not be able to
 * finish over its replacement.
 *
 * No CORS: no browser calls any of this, so there is nothing to preflight and
 * an `Access-Control-Allow-Origin` would only widen the surface.
 *
 * Status codes:
 * - **404** when `CNC_WORKER_SECRET` is unset — the API is unmounted, not
 *   broken (same convention as `apns-stats.ts`).
 * - **401** for a wrong or missing secret.
 * - **409** for a lease that is not the caller's, or a report that no longer
 *   applies. The worker's correct response is to drop the job, not retry.
 * - **503** when object storage is not configured — an operator problem, and
 *   worth retrying once it is fixed.
 */

/**
 * 2 MB. The largest body here is a completion's fingerprint manifest: a few
 * dozen per-file hashes and the per-channel values. Anything approaching this
 * is not a manifest.
 */
const MAX_WORKER_BODY_BYTES = 2_000_000;

/** How much of a generator error is kept on the order row. Enough to read; not enough to bloat the row. */
const MAX_LAST_ERROR_LENGTH = 2000;

/**
 * Constant-time comparison of two secret strings.
 *
 * Both sides are hashed first so the comparison is over two 32-byte digests
 * regardless of what was sent: `timingSafeEqual` throws on a length mismatch,
 * and guarding that with a plain length check would leak the secret's length.
 */
function matchesSecretValue(presented: string, expected: string): boolean {
  const presentedDigest = createHash('sha256').update(presented).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

/** Constant-time check of the fleet-wide bearer secret. */
function matchesWorkerSecret(presented: string, expected: string): boolean {
  return matchesSecretValue(presented, expected);
}

/**
 * Constant-time check of a job's claim token.
 *
 * The claim token is a per-claim bearer credential — presenting it is the whole
 * proof that a caller currently holds this lease — so it gets the same
 * treatment as the fleet secret rather than a plain `!==`, whose early exit
 * leaks a prefix of the live token to anyone who already has the fleet secret
 * and wants to steal a running job. A null stored token means there is no lease
 * to hold and is never matchable; short-circuiting on it leaks nothing, since
 * "this order has no live lease" is the same 409 the caller gets either way.
 */
function matchesClaimToken(presented: string, stored: string | null): boolean {
  if (stored === null) return false;
  return matchesSecretValue(presented, stored);
}

/**
 * Authorise a worker request.
 *
 * Returns false having already answered. Read from `process.env` at call time,
 * not at module load, so an operator setting the secret does not need a code
 * change to explain why the route is still 404ing in one process.
 */
function authoriseWorker(req: IncomingMessage, res: ServerResponse): boolean {
  const secret = process.env.CNC_WORKER_SECRET;
  if (!secret) {
    sendJson(res, 404, { error: 'Not found' });
    return false;
  }

  const header = req.headers.authorization;
  const presented = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header)?.[1] : undefined;
  if (!presented || !matchesWorkerSecret(presented, secret)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return false;
  }

  return true;
}

/** Read and parse a JSON body against `schema`, or answer 400 and return null. */
async function readBody<Schema extends z.ZodTypeAny>(
  req: IncomingMessage,
  res: ServerResponse,
  schema: Schema,
): Promise<z.infer<Schema> | null> {
  let raw: string;
  try {
    raw = await readJsonBody(req, MAX_WORKER_BODY_BYTES);
  } catch {
    sendJson(res, 400, { error: 'Request body too large' });
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, { error: 'Request body is not JSON' });
    return null;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    // The issue list, never the body: a completion carries the fingerprint
    // manifest, which is the one thing that must never reach a log.
    sendJson(res, 400, { error: 'Invalid request body', issues: result.error.issues.map((issue) => issue.path) });
    return null;
  }
  return result.data;
}

const ClaimBodySchema = z.object({ workerId: z.string().min(1).max(200) });

const LeaseBodySchema = z.object({ claimToken: z.string().min(1).max(200) });

const CompleteBodySchema = z.object({
  claimToken: z.string().min(1).max(200),
  zipKey: z.string().min(1).max(1024),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex characters'),
  /**
   * Nullish because a PREVIEW has none: no covert channels are written into a
   * watermarked raster, so there is nothing to record. A `full` completion that
   * omits it stores an empty manifest, which is loud in the admin view rather
   * than a rejected report from a worker that already did the work.
   */
  fingerprintManifest: z.record(z.string(), z.unknown()).nullish(),
  bomSummary: z.record(z.string(), z.unknown()).nullish(),
  previewKeys: z.array(z.string().max(1024)).nullish(),
  generatorVersion: z.string().max(200).nullish(),
});

const FailBodySchema = z.object({
  claimToken: z.string().min(1).max(200),
  errorCode: z.string().min(1).max(200),
  /**
   * Unbounded on purpose. A generator traceback is easily longer than a few
   * thousand characters, and a 400 on the failure report is the worst possible
   * answer to it: the worker cannot say what went wrong, the order sits in
   * `generating` until its lease expires, and the operator gets no email. The
   * length that matters is what is STORED, and `MAX_LAST_ERROR_LENGTH` already
   * truncates that. `MAX_WORKER_BODY_BYTES` is still the real ceiling.
   */
  message: z.string(),
  retryable: z.boolean(),
});

/** The order this report is about, or null having already answered. */
const LEASED_STATUSES: readonly CncOrderStatus[] = ['generating', 'preview_generating'];

async function loadLeasedOrder(res: ServerResponse, orderId: number, claimToken: string): Promise<CncOrder | null> {
  const order = await getOrderById(orderId);
  // A report for an order that never existed and one whose lease has moved on
  // get the same 409: either way the worker's job is gone, and the action is
  // identical (drop it). Both queues are accepted here — which of the two this
  // job is comes off the status, never off the worker's say-so.
  if (!order || !LEASED_STATUSES.includes(order.status) || !matchesClaimToken(claimToken, order.claimToken)) {
    sendJson(res, 409, { error: 'This job is no longer yours' });
    return null;
  }
  return order;
}

/** True when the private bucket is wired up; answers 503 and returns false when it is not. */
function requirePrivateBucket(res: ServerResponse): boolean {
  if (isS3Configured('private')) return true;
  logger.error('[cnc-worker] the private bucket is not configured; jobs cannot be handed out or verified');
  sendJson(res, 503, { error: 'Object storage is not configured' });
  return false;
}

/**
 * Give up on an order without the worker having asked.
 *
 * Used for a claimed order that cannot be turned into a job at all. A retry
 * would rebuild the identical unbuildable payload, so this goes straight to
 * `failed` and mails an operator rather than burning the attempt budget.
 */
async function abandonUnbuildableOrder(order: CncOrder, reason: string): Promise<void> {
  const deliverable = deliverableForStatus(order.status);
  logger.error('[cnc-worker] claimed order cannot be turned into a job; failing it', {
    orderId: order.id,
    licenceId: order.licenceId,
    deliverable,
    reason,
  });

  const failed = await transitionOrder(
    order.id,
    deliverable === 'preview' ? 'previewFail' : 'fail',
    {
      status: deliverable === 'preview' ? 'preview_failed' : 'failed',
      lastError: reason.slice(0, MAX_LAST_ERROR_LENGTH),
      claimToken: null,
    },
    { claimToken: order.claimToken ?? undefined },
  );
  if (failed) await announceFailure(failed);
}

/**
 * Tell an operator a paid pack gave up. Best-effort: the order is already
 * durable.
 *
 * A failed PREVIEW is not mailed. Nobody paid for it, the buyer sees
 * `preview_failed` on the page they are looking at and can ask again, and one
 * operator email per misconfigured wall someone is experimenting with would
 * bury the emails that mean a purchase is stuck.
 */
async function announceFailure(order: CncOrder): Promise<void> {
  if (deliverableForStatus(order.status) === 'preview') {
    logger.error('[cnc-worker] preview generation gave up', {
      orderId: order.id,
      licenceId: order.licenceId,
      attempts: order.attempts,
      lastError: order.lastError,
    });
    return;
  }

  try {
    await sendCncPackFailedAdminEmail({
      licenceId: order.licenceId,
      orderId: order.id,
      boardLabel: describeBoard(order),
      licenseeEmail: order.licenseeEmail ?? 'unknown',
      attempts: order.attempts,
      lastError: order.lastError,
    });
  } catch (error) {
    logger.warn('[cnc-worker] pack-failed admin email failed', { orderId: order.id, error });
  }
}

/**
 * POST /api/cnc/worker/claim
 *
 * Hand out at most one job. `{job: null}` is the normal answer — the worker
 * polls every few seconds and is idle most of the time, so "nothing to do" is
 * a 200 rather than a 404.
 */
async function handleClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req, res, ClaimBodySchema);
  if (!body) return;
  if (!requirePrivateBucket(res)) return;

  // Reap before claiming, and here rather than inside `claimNextJob`, because
  // an order whose worker died on its final attempt is the one failure nobody
  // ever reports: the worker is gone, so there is no `fail` call and no email.
  // `claimNextJob` still reaps as well — that keeps the invariant for any
  // future caller — but only this path knows how to tell an operator, and a
  // paid order going `failed` in silence is the whole problem.
  for (const reaped of await failStaleExhaustedJobs()) {
    logger.error('[cnc-worker] reaped a job whose lease expired after its final attempt', {
      orderId: reaped.id,
      licenceId: reaped.licenceId,
      attempts: reaped.attempts,
    });
    await announceFailure(reaped);
  }

  const now = new Date();
  const order = await claimNextJob(body.workerId, now);
  if (!order) {
    sendJson(res, 200, { job: null });
    return;
  }

  try {
    const job = buildWorkerJob(order, { bucket: getBucketName('private'), issuedAt: now });
    sendJson(res, 200, { job });
  } catch (error) {
    // The claim already happened, so the order is `generating` with this
    // process holding the lease. Fail it here rather than letting the lease
    // expire: nothing about the payload changes in ten minutes.
    const reason =
      error instanceof CncJobPayloadError || error instanceof Error
        ? error.message
        : 'Order could not be turned into a job';
    await abandonUnbuildableOrder(order, reason);
    // Still a 200 with no job: the worker did nothing wrong and should keep
    // polling. The next poll picks up the next order in the queue.
    sendJson(res, 200, { job: null });
  }
}

/**
 * POST /api/cnc/worker/jobs/:orderId/heartbeat
 *
 * Extend the lease. 409 means the lease is gone (reclaimed, completed,
 * refunded), and the worker's correct response is to abandon the job — carrying
 * on would generate a pack that nothing will accept.
 */
async function handleHeartbeat(req: IncomingMessage, res: ServerResponse, orderId: number): Promise<void> {
  const body = await readBody(req, res, LeaseBodySchema);
  if (!body) return;

  const alive = await recordWorkerHeartbeat(orderId, body.claimToken);
  if (!alive) {
    sendJson(res, 409, { error: 'This job is no longer yours' });
    return;
  }
  sendJson(res, 200, { ok: true });
}

/**
 * The completion checks that are the same for both deliverables.
 *
 * The object is verified before the order moves, because the status is what
 * unlocks a download: an order that says ready and 404s on the object is worse
 * than one that is still generating. Returns false having already answered.
 */
async function verifyUploadedObject(
  res: ServerResponse,
  orderId: number,
  expectedKey: string,
  reportedKey: string,
  reportedSize: number,
): Promise<boolean> {
  if (reportedKey !== expectedKey) {
    logger.error('[cnc-worker] completion reported a key we did not ask for', {
      orderId,
      expectedKey,
      reportedKey,
    });
    sendJson(res, 409, { error: 'The pack was not written to the key this job specified' });
    return false;
  }

  const metadata = await getS3ObjectMetadata('private', expectedKey);
  if (!metadata) {
    sendJson(res, 409, { error: 'No object exists at that key' });
    return false;
  }
  if (metadata.contentLength !== reportedSize) {
    logger.error('[cnc-worker] uploaded pack size does not match the completion report', {
      orderId,
      reported: reportedSize,
      actual: metadata.contentLength,
    });
    sendJson(res, 409, { error: 'The uploaded object size does not match the reported size' });
    return false;
  }
  return true;
}

/**
 * The preview PNG keys, or null having already answered.
 *
 * Every key has to sit under the prefix this job dictated and end in `.png`.
 * These strings are stored and later turned into reads of the private bucket by
 * the preview image route, and that bucket also holds user data exports — so a
 * worker that reported `../../exports/…` must be refused here, once, rather
 * than have every reader re-derive the rule. Belt and braces with the route's
 * own basename match, and deliberately so: this is the write.
 */
function validatePreviewKeys(
  res: ServerResponse,
  orderId: number,
  previewPrefix: string,
  reportedKeys: string[] | null | undefined,
): string[] | null {
  const keys = reportedKeys ?? [];
  const rejected = keys.filter((key) => !key.startsWith(previewPrefix) || !key.endsWith('.png'));
  if (rejected.length > 0) {
    logger.error('[cnc-worker] preview completion reported keys outside its prefix', {
      orderId,
      previewPrefix,
      rejected,
    });
    sendJson(res, 409, { error: 'Preview images must be PNGs written under the previewPrefix this job specified' });
    return null;
  }
  return keys;
}

/** Board-shaped properties every build-plans analytics event carries. */
function boardProperties(order: CncOrder): Record<string, string | number | boolean | null> {
  const setIds = parseSetIds(order.setIds) ?? [];
  return {
    board_name: order.boardName,
    layout_id: order.layoutId,
    size_id: order.sizeId,
    kicker: setIds.some((setId) => CNC_KICKER_SET_IDS.includes(setId)),
    has_artwork: Array.isArray(order.artwork) && order.artwork.length > 0,
  };
}

/**
 * A finished preview: store the watermarked artifacts and stop.
 *
 * No email, no fingerprint manifest, no `zip_key`. A preview is not a sale, so
 * none of the machinery a sale drags along runs — the buyer is looking at the
 * order page and the status flipping to `preview_ready` is the whole
 * notification.
 */
async function completePreview(
  res: ServerResponse,
  order: CncOrder,
  body: z.infer<typeof CompleteBodySchema>,
): Promise<void> {
  const expectedKey = cncPreviewOutputKey(order);
  if (!(await verifyUploadedObject(res, order.id, expectedKey, body.zipKey, body.sizeBytes))) return;

  const previewKeys = validatePreviewKeys(res, order.id, cncPreviewPrefix(order), body.previewKeys);
  if (!previewKeys) return;

  // The manifest column is not the fingerprint trail on a preview — there is no
  // fingerprint to record. What is worth keeping is the generator's own
  // bookkeeping: the BOM the configurator shows next to the images, and which
  // build produced them.
  const previewManifest =
    body.bomSummary || body.generatorVersion
      ? {
          deliverable: 'preview',
          ...(body.bomSummary ? { bomSummary: body.bomSummary } : {}),
          ...(body.generatorVersion ? { generatorVersion: body.generatorVersion } : {}),
        }
      : null;

  const ready = await transitionOrder(
    order.id,
    'previewComplete',
    {
      previewZipKey: expectedKey,
      previewZipSizeBytes: body.sizeBytes,
      previewGeneratedAt: new Date(),
      previewKeys,
      previewsGenerated: order.previewsGenerated + 1,
      fingerprintManifest: previewManifest,
      lastError: null,
      // Kept, exactly as the paid completion keeps it, so a redelivered report
      // is recognised as this worker's own rather than as a stranger's.
    },
    { claimToken: body.claimToken },
  );
  if (!ready) {
    sendJson(res, 409, { error: 'This job is no longer yours' });
    return;
  }

  sendJson(res, 200, { ok: true, status: ready.status });

  captureBackendEvent('Build Plans Preview Generated', {
    distinctId: ready.userId ?? ready.licenceId,
    properties: {
      ...boardProperties(ready),
      // Which preview of this configuration this is. A row that has produced
      // three is a generator retrying, not a buyer iterating — iterating writes
      // a new row.
      preview_index: ready.previewsGenerated,
      image_count: previewKeys.length,
    },
  });
}

/**
 * POST /api/cnc/worker/jobs/:orderId/complete
 *
 * The zip is verified before the order is marked ready, because "ready" is what
 * unlocks the buyer's download: an order that says ready and 404s on the object
 * is worse than one that is still generating.
 *
 * Two checks, both 409:
 * - the key must be the one Boardsesh dictated, so a worker cannot write a
 *   licensed pack somewhere the download route will never look; and
 * - a HEAD must find the object at the size the worker reported, so a partial
 *   or aborted upload is caught here rather than by the buyer.
 *
 * A preview completion adds a third: every key in `previewKeys` must be a PNG
 * under the job's `previewPrefix`.
 *
 * Idempotent by claim token. The order keeps the completing token when it goes
 * `ready` (or `preview_ready`), so a worker retrying a completion whose response
 * it never saw gets `{ok: true, status, duplicate: true}` and no second email.
 * Any other token, or any other status, is still 409 — including a report from
 * a worker whose lease was reclaimed while it was uploading.
 */
async function handleComplete(req: IncomingMessage, res: ServerResponse, orderId: number): Promise<void> {
  const body = await readBody(req, res, CompleteBodySchema);
  if (!body) return;
  if (!requirePrivateBucket(res)) return;

  // Idempotency, before the lease check: a completion whose 200 was lost to a
  // dropped connection is retried by the worker, and the second delivery must
  // not read as "this job is no longer yours" — the worker would drop a job it
  // had actually finished. The claim token is what makes this safe: it is not
  // cleared on the ready transition, so the completing worker is the only
  // caller that can present it. No email, no second transition; just the
  // answer the first attempt already earned.
  const existing = await getOrderById(orderId);
  if (
    existing &&
    (existing.status === 'ready' || existing.status === 'preview_ready') &&
    matchesClaimToken(body.claimToken, existing.claimToken)
  ) {
    sendJson(res, 200, { ok: true, status: existing.status, duplicate: true });
    return;
  }

  const order = await loadLeasedOrder(res, orderId, body.claimToken);
  if (!order) return;

  if (deliverableForStatus(order.status) === 'preview') {
    await completePreview(res, order, body);
    return;
  }

  const expectedKey = cncPackOutputKey(order);
  if (!(await verifyUploadedObject(res, orderId, expectedKey, body.zipKey, body.sizeBytes))) return;

  const patch: CncOrderPatch = {
    generatedAt: new Date(),
    zipKey: expectedKey,
    zipSizeBytes: body.sizeBytes,
    zipSha256: body.sha256,
    fingerprintManifest: {
      ...body.fingerprintManifest,
      ...(body.bomSummary ? { bomSummary: body.bomSummary } : {}),
      ...(body.previewKeys ? { previewKeys: body.previewKeys } : {}),
      ...(body.generatorVersion ? { generatorVersion: body.generatorVersion } : {}),
    },
    lastError: null,
    // The token is deliberately NOT cleared here. It becomes the receipt for
    // this completion: a redelivery presenting it is recognised above and
    // answered 200, while any other token — or any other status — still 409s.
    // Nothing else can act on it: `fail` and `heartbeat` both require
    // `generating`, and an admin regenerate clears it on the way back to
    // `queued`. It never reaches a client; `toPublicOrder` strips it.
  };

  const ready = await transitionOrder(orderId, 'complete', patch, { claimToken: body.claimToken });
  if (!ready) {
    // The lease moved between the read above and this UPDATE. Rare, and
    // harmless: the object is already at the agreed key, so whoever holds the
    // job now will overwrite it.
    sendJson(res, 409, { error: 'This job is no longer yours' });
    return;
  }

  sendJson(res, 200, { ok: true, status: ready.status });

  if (ready.licenseeEmail) {
    try {
      await sendCncPackReadyEmail({
        to: ready.licenseeEmail,
        licenseeName: ready.licenseeName ?? 'there',
        licenceId: ready.licenceId,
        boardLabel: describeBoard(ready),
        orderUrl: `${webPublicUrl()}/build-plans/orders/${encodeURIComponent(ready.licenceId)}`,
      });
    } catch (error) {
      logger.warn('[cnc-worker] pack-ready email failed', { orderId, error });
    }
  }
}

/**
 * POST /api/cnc/worker/jobs/:orderId/fail
 *
 * Where a failure lands depends on the attempt budget, not on the worker:
 * `retryable: false` is terminal immediately, and a retryable failure goes back
 * to the queue it came from until the budget is spent. The worker reports what
 * happened; the state machine decides what it means. A preview runs the same
 * budget on its own pair of statuses.
 */
async function handleFail(req: IncomingMessage, res: ServerResponse, orderId: number): Promise<void> {
  const body = await readBody(req, res, FailBodySchema);
  if (!body) return;

  const order = await loadLeasedOrder(res, orderId, body.claimToken);
  if (!order) return;

  const deliverable: CncDeliverable = deliverableForStatus(order.status);
  const terminalStatus: CncOrderStatus = deliverable === 'preview' ? 'preview_failed' : 'failed';
  // `order.attempts` is the count AFTER the claim incremented it, which is what
  // nextStatusAfterFailure expects.
  const status: CncOrderStatus = body.retryable
    ? nextStatusAfterFailure(order.attempts, undefined, deliverable)
    : terminalStatus;
  const lastError = `${body.errorCode}: ${body.message}`.slice(0, MAX_LAST_ERROR_LENGTH);

  const updated = await transitionOrder(
    orderId,
    deliverable === 'preview' ? 'previewFail' : 'fail',
    { status, lastError, claimToken: null },
    { claimToken: body.claimToken },
  );
  if (!updated) {
    sendJson(res, 409, { error: 'This job is no longer yours' });
    return;
  }

  sendJson(res, 200, { ok: true, status: updated.status, attempts: updated.attempts });

  if (updated.status === terminalStatus) {
    await announceFailure(updated);
  }
}

type StoredArtworkEntry = { assetId?: unknown; assetKey?: unknown; mime?: unknown };

/**
 * The only content types an uploaded asset can ever be stored as (enforced at
 * upload), mapped to the extension `Content-Disposition` offers the generator.
 * Anything else reaching this route is a row or a bucket object that got here
 * some other way, and is treated as a server error rather than guessed at.
 */
const ASSET_CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/svg+xml': 'svg',
  'image/png': 'png',
};

/**
 * GET /api/cnc/worker/assets/:assetId?orderId=&claimToken=
 *
 * Stream one uploaded art asset to the worker.
 *
 * Two shapes, both gated by the fleet secret (checked by `handleCncWorkerApi`
 * before we get here):
 *
 * - **Leased** — `orderId` and `claimToken` both present. The buyer has
 *   checked out and the worker holds this order's lease; the asset must be
 *   named in the order's own artwork list, which is the third gate on top of
 *   the lease and the secret. Resolution prefers `cnc_art_assets` (the row is
 *   authoritative about mime and key) and falls back to the copy stored on the
 *   order — not belt-and-braces: `user_id` cascades, so a buyer who deletes
 *   their account takes the asset row with them while the licence and its
 *   right to a regenerate survive.
 * - **Unleased** — both absent. `validateCncArtwork` runs before checkout, so
 *   there is no order yet to lease; the fleet secret is the only gate, and the
 *   asset is read by id alone via `getArtAssetById`. Safe because `asset_ref`
 *   — the only way an id reaches the generator — is only ever set to an asset
 *   Boardsesh already checked belongs to the caller (`resolveArtworkAssets`),
 *   and because the route's own charset restriction on `:assetId` is what
 *   stops the id becoming a path into anything else.
 *
 * One of the two params without the other is a malformed request, not either
 * shape, and gets a 400 rather than being read as unleased.
 *
 * The asset id alone is deliberately never enough on the leased path — it
 * reaches us from the generator, which got it from a job payload, and the
 * private bucket it would otherwise address also holds user data exports.
 */
async function handleAsset(res: ServerResponse, url: URL, assetId: string): Promise<void> {
  if (!requirePrivateBucket(res)) return;

  const orderIdParam = url.searchParams.get('orderId');
  const claimToken = url.searchParams.get('claimToken');
  if ((orderIdParam === null) !== (claimToken === null)) {
    sendJson(res, 400, { error: 'orderId and claimToken must both be present or both be absent' });
    return;
  }

  let assetKey: string | null;
  let mime: string | null;

  if (orderIdParam !== null && claimToken !== null) {
    const orderId = Number(orderIdParam);
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      sendJson(res, 400, { error: 'orderId and claimToken are required' });
      return;
    }

    const order = await loadLeasedOrder(res, orderId, claimToken);
    if (!order) return;

    const artwork = Array.isArray(order.artwork) ? order.artwork : [];
    const item = artwork.find((entry): entry is StoredArtworkEntry => {
      if (typeof entry !== 'object' || entry === null) return false;
      return (entry as StoredArtworkEntry).assetId === assetId;
    });
    if (!item) {
      sendJson(res, 404, { error: 'This order has no artwork with that asset id' });
      return;
    }

    const asset = await getAssetForJob(orderId, assetId);
    assetKey = asset?.key ?? (typeof item.assetKey === 'string' ? item.assetKey : null);
    mime = asset?.mime ?? (typeof item.mime === 'string' ? item.mime : null);
  } else {
    // Unleased: pre-purchase `validateCncArtwork` has no order to lease
    // against, so the fleet secret is the whole gate and the id is resolved
    // on its own.
    const asset = await getArtAssetById(assetId);
    assetKey = asset?.key ?? null;
    mime = asset?.mime ?? null;
  }

  // The key is matched, not trusted, even having come from our own row: this is
  // the one place a stored string turns into a read against the private bucket,
  // so the shape check stays here rather than at whichever write produced it.
  if (!assetKey || !isCncArtKey(assetKey)) {
    logger.warn('[cnc-worker] asset request names an asset with no usable key', { assetId });
    sendJson(res, 404, { error: 'Asset not found' });
    return;
  }

  // The stored mime is what was sniffed from the bytes at upload, and it is
  // held to the allowlist rather than passed through: anything outside it is
  // an asset that should never have been storable, and guessing a
  // Content-Type for it is worse than refusing to serve it.
  if (!mime) {
    logger.error('[cnc-worker] asset has no stored content type', { assetId });
    sendJson(res, 500, { error: 'Asset has an unexpected content type' });
    return;
  }
  const extension = ASSET_CONTENT_TYPE_EXTENSIONS[mime];
  if (!extension) {
    logger.error('[cnc-worker] asset has a content type outside the allowlist', { assetId, mime });
    sendJson(res, 500, { error: 'Asset has an unexpected content type' });
    return;
  }

  const object = await getFromS3('private', assetKey);
  if (!object) {
    logger.warn('[cnc-worker] art asset is referenced but missing from storage', { assetId, assetKey });
    sendJson(res, 404, { error: 'Asset not found' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': mime,
    // `assetId` is already restricted to `ASSET_PATH_PATTERN`'s charset by the
    // route match below, so it carries no quote or CRLF a header could choke
    // on.
    'Content-Disposition': `attachment; filename="${assetId}.${extension}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(object.contentLength != null ? { 'Content-Length': String(object.contentLength) } : {}),
  });
  pipeObjectStream(object.stream, res, { route: 'cnc-worker-asset', orderId: orderIdParam, assetKey });
}

/** `/api/cnc/worker/jobs/<orderId>/<action>` */
const JOB_PATH_PATTERN = /^\/api\/cnc\/worker\/jobs\/(\d+)\/(heartbeat|complete|fail)$/;
/** `/api/cnc/worker/assets/<assetId>` */
const ASSET_PATH_PATTERN = /^\/api\/cnc\/worker\/assets\/([A-Za-z0-9._-]{1,128})$/;

/**
 * Every `/api/cnc/worker/*` route, behind one entry in `server.ts`.
 *
 * Dispatching here rather than adding five `pathname ===` branches to the
 * server keeps the parameterised paths (`:orderId`, `:assetId`) in one place —
 * the server's route table only does exact matches.
 */
export async function handleCncWorkerApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!authoriseWorker(req, res)) return;

  const { pathname } = url;

  if (pathname === '/api/cnc/worker/claim') {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    await handleClaim(req, res);
    return;
  }

  const jobMatch = JOB_PATH_PATTERN.exec(pathname);
  if (jobMatch) {
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    const orderId = Number(jobMatch[1]);
    // `\d+` matches "0" and any number of leading zeroes, and a long enough run
    // of digits parses to a float that is no longer an integer id. Neither can
    // name a row (the identity column starts at 1), so both are rejected here
    // rather than turned into a lookup that would 409 for the wrong reason.
    if (!Number.isSafeInteger(orderId) || orderId <= 0) {
      sendJson(res, 400, { error: 'Invalid order id' });
      return;
    }
    if (jobMatch[2] === 'heartbeat') return handleHeartbeat(req, res, orderId);
    if (jobMatch[2] === 'complete') return handleComplete(req, res, orderId);
    return handleFail(req, res, orderId);
  }

  const assetMatch = ASSET_PATH_PATTERN.exec(pathname);
  if (assetMatch) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }
    await handleAsset(res, url, assetMatch[1]);
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}
