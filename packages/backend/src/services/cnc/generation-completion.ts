import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CncOrder } from '@boardsesh/db/schema';
import { getFromS3Strict, getS3ObjectMetadataStrict } from '../../storage/s3';
import { sendCncPackFailedAdminEmail, sendCncPackReadyEmail } from '../../email/cnc-emails';
import { webPublicUrl } from '../../email/email-service';
import { captureBackendEvent } from '../analytics/posthog';
import { logger } from '../../utils/logger';
import { CNC_KICKER_SET_IDS, describeBoard, parseSetIds } from './catalog';
import { cncPackOutputKey, cncPreviewOutputKey, cncPreviewPrefix } from './job-payload';
import { getAccountEmail, type CncOrderPatch } from './orders';

export const cncGenerationCompletion = z.object({
  zipKey: z.string().min(1).max(1024),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(512 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  fingerprintManifest: z.record(z.string(), z.unknown()).nullish(),
  bomSummary: z.record(z.string(), z.unknown()).nullish(),
  previewKeys: z.array(z.string().max(1024)).max(512).nullish(),
  generatorVersion: z.string().max(200).nullish(),
  generatorBuildSha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
});

export type CncGenerationCompletion = z.infer<typeof cncGenerationCompletion>;

export class CncGenerationOutputError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'CncGenerationOutputError';
  }
}

/** Verify storage outside the attempt transaction; publishing happens under its fence later. */
export async function verifyCncGenerationOutput(
  order: CncOrder,
  completion: CncGenerationCompletion,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const preview = order.status === 'preview_generating';
  const expectedKey = preview ? cncPreviewOutputKey(order) : cncPackOutputKey(order);
  if (completion.zipKey !== expectedKey) throw new CncGenerationOutputError('CNC_OUTPUT_KEY_MISMATCH');
  const metadata = await getS3ObjectMetadataStrict('private', expectedKey, { signal });
  if (!metadata || metadata.contentLength !== completion.sizeBytes) {
    throw new CncGenerationOutputError('CNC_OUTPUT_UPLOAD_INCOMPLETE');
  }
  const object = await getFromS3Strict('private', expectedKey, { signal });
  if (!object || (object.contentLength !== undefined && object.contentLength !== completion.sizeBytes)) {
    object?.stream.destroy();
    throw new CncGenerationOutputError('CNC_OUTPUT_UPLOAD_INCOMPLETE');
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const abortRead = () => object.stream.destroy(new Error('CNC_OUTPUT_READ_ABORTED'));
  signal.addEventListener('abort', abortRead, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of object.stream) {
      signal.throwIfAborted();
      if (!(chunk instanceof Uint8Array)) throw new CncGenerationOutputError('CNC_OUTPUT_INVALID_BYTES');
      bytes += chunk.byteLength;
      if (bytes > completion.sizeBytes) throw new CncGenerationOutputError('CNC_OUTPUT_SIZE_MISMATCH');
      hash.update(chunk);
    }
  } finally {
    signal.removeEventListener('abort', abortRead);
    object.stream.destroy();
  }
  if (bytes !== completion.sizeBytes || hash.digest('hex') !== completion.sha256) {
    throw new CncGenerationOutputError('CNC_OUTPUT_SHA256_MISMATCH');
  }
  const previewKeys = completion.previewKeys ?? [];
  if (!preview && previewKeys.length) throw new CncGenerationOutputError('CNC_FULL_HAS_PREVIEW_OBJECTS');
  if (preview) {
    if (!previewKeys.length || completion.fingerprintManifest != null) {
      throw new CncGenerationOutputError('CNC_PREVIEW_INVALID_MANIFEST');
    }
    const prefix = cncPreviewPrefix(order);
    for (const key of previewKeys) {
      signal.throwIfAborted();
      if (!key.startsWith(prefix) || !/^[A-Za-z0-9_-]+\.png$/.test(key.slice(prefix.length))) {
        throw new CncGenerationOutputError('CNC_PREVIEW_INVALID_KEY');
      }
      const image = await getS3ObjectMetadataStrict('private', key, { signal });
      if (
        !image ||
        image.contentType !== 'image/png' ||
        !image.contentLength ||
        image.contentLength > 32 * 1024 * 1024
      ) {
        throw new CncGenerationOutputError('CNC_PREVIEW_UPLOAD_INCOMPLETE');
      }
    }
  } else if (!completion.fingerprintManifest) {
    throw new CncGenerationOutputError('CNC_FULL_MISSING_FINGERPRINT');
  }
  signal.throwIfAborted();
}

export function cncCompletionPatch(order: CncOrder, completion: CncGenerationCompletion): CncOrderPatch {
  if (order.status === 'preview_generating') {
    return {
      previewZipKey: completion.zipKey,
      previewZipSizeBytes: completion.sizeBytes,
      previewGeneratedAt: new Date(),
      previewKeys: completion.previewKeys ?? [],
      previewsGenerated: order.previewsGenerated + 1,
      fingerprintManifest: {
        deliverable: 'preview',
        ...(completion.bomSummary ? { bomSummary: completion.bomSummary } : {}),
        ...(completion.generatorVersion ? { generatorVersion: completion.generatorVersion } : {}),
        ...(completion.generatorBuildSha ? { generatorBuildSha: completion.generatorBuildSha } : {}),
      },
      lastError: null,
    };
  }
  return {
    generatedAt: new Date(),
    zipKey: completion.zipKey,
    zipSizeBytes: completion.sizeBytes,
    zipSha256: completion.sha256,
    fingerprintManifest: {
      ...completion.fingerprintManifest,
      ...(completion.bomSummary ? { bomSummary: completion.bomSummary } : {}),
      ...(completion.generatorVersion ? { generatorVersion: completion.generatorVersion } : {}),
      ...(completion.generatorBuildSha ? { generatorBuildSha: completion.generatorBuildSha } : {}),
    },
    lastError: null,
  };
}

export function cncBoardProperties(order: CncOrder): Record<string, string | number | boolean | null> {
  const setIds = parseSetIds(order.setIds) ?? [];
  return {
    board_name: order.boardName,
    layout_id: order.layoutId,
    size_id: order.sizeId,
    kicker: setIds.some((setId) => CNC_KICKER_SET_IDS.includes(setId)),
    has_artwork: Array.isArray(order.artwork) && order.artwork.length > 0,
  };
}

/** Backend-owned; false keeps the notification eligible for a later retry. */
export async function announceCncGenerationFailure(
  order: CncOrder,
  options: { bounded?: boolean } = {},
): Promise<boolean> {
  if (order.status.startsWith('preview')) {
    logger.error('[cnc-worker] preview generation gave up', {
      orderId: order.id,
      licenceId: order.licenceId,
      attempts: order.attempts,
    });
    return true;
  }
  try {
    const input = {
      licenceId: order.licenceId,
      orderId: order.id,
      boardLabel: describeBoard(order),
      licenseeEmail: order.licenseeEmail ?? 'unknown',
      attempts: order.attempts,
      lastError: order.lastError,
    };
    const sent = options.bounded
      ? await sendCncPackFailedAdminEmail(input, { bounded: true })
      : await sendCncPackFailedAdminEmail(input);
    return sent !== false;
  } catch {
    logger.warn('[cnc-worker] pack-failed admin email failed', { orderId: order.id });
    return false;
  }
}

/** Backend-owned: the generator VM has neither mail nor analytics credentials. */
export async function announceCncGenerationComplete(
  order: CncOrder,
  options: { bounded?: boolean } = {},
): Promise<boolean> {
  if (order.status === 'preview_ready') {
    captureBackendEvent('Build Plans Preview Generated', {
      properties: {
        ...cncBoardProperties(order),
        preview_index: order.previewsGenerated,
        image_count: order.previewKeys?.length ?? 0,
      },
    });
    return true;
  }
  let accountEmail: string | null = null;
  let accountLookupSucceeded = true;
  try {
    accountEmail = order.userId ? await getAccountEmail(order.userId) : null;
  } catch {
    accountLookupSucceeded = false;
    logger.warn('[cnc-worker] could not look up buyer email', { orderId: order.id });
  }
  const recipients = new Set([accountEmail, order.licenseeEmail].filter((email): email is string => Boolean(email)));
  let sent = recipients.size > 0 && accountLookupSucceeded;
  for (const recipient of recipients) {
    try {
      const input = {
        to: recipient,
        licenseeName: order.licenseeName ?? 'there',
        licenceId: order.licenceId,
        boardLabel: describeBoard(order),
        orderUrl: `${webPublicUrl()}/build-plans/orders/${encodeURIComponent(order.licenceId)}`,
      };
      const delivered = options.bounded
        ? await sendCncPackReadyEmail(input, { bounded: true })
        : await sendCncPackReadyEmail(input);
      if (delivered === false) sent = false;
    } catch {
      sent = false;
      logger.warn('[cnc-worker] pack-ready email failed', { orderId: order.id });
    }
  }
  return sent;
}
