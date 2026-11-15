import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { BackgroundJobTransaction } from '@boardsesh/db/queries';
import { cncArtAssets, cncOrders, type CncOrder } from '@boardsesh/db/schema';
import { getBucketName, isS3Configured } from '../../storage/s3';
import { logger } from '../../utils/logger';
import { CncGeneratorError, runCncGenerator } from '../../services/cnc/generator-process';
import { buildWorkerJob, CncJobPayloadError, type CncWorkerJob } from '../../services/cnc/job-payload';
import { isCncArtKey } from '../../services/cnc/art-assets';
import { loadCncGeneratorAssets } from '../../services/cnc/generator-assets';
import { CNC_MAX_ATTEMPTS, nextStatusAfterFailure } from '../../services/cnc/order-state';
import { transitionOrder } from '../../services/cnc/orders';
import { cncGenerationPayload, type CncGenerationRequest } from '../../services/cnc/generation-queue';
import {
  cncCompletionPatch,
  cncGenerationCompletion,
  CncGenerationOutputError,
  verifyCncGenerationOutput,
} from '../../services/cnc/generation-completion';
import { BackgroundJobError, type BackgroundJobContext, type BackgroundJobFamilyModule } from './types';

/** Address one run's order only; pg-boss owns retries, leases and global queue selection. */
async function claimGeneration(context: BackgroundJobContext, request: CncGenerationRequest): Promise<CncOrder | null> {
  return context.transaction(async (transaction) => {
    const [order] = await transaction
      .select()
      .from(cncOrders)
      .where(
        and(
          eq(cncOrders.id, request.orderId),
          eq(cncOrders.generation, request.generation),
          eq(cncOrders.generationRunId, context.runId),
        ),
      )
      .for('update');
    if (!order || order.refundedAt !== null) return null;
    const queued = request.deliverable === 'preview' ? 'preview_queued' : 'queued';
    const generating = request.deliverable === 'preview' ? 'preview_generating' : 'generating';
    // Includes completed work after a lost pg-boss acknowledgement: no second render/upload.
    if (order.status !== queued && order.status !== generating) return null;
    if (order.attempts >= CNC_MAX_ATTEMPTS)
      throw new BackgroundJobError('CNC_ATTEMPTS_EXHAUSTED', { retryable: false });
    const now = new Date();
    const [claimed] = await transaction
      .update(cncOrders)
      .set({
        status: generating,
        attempts: order.attempts + 1,
        claimToken: randomUUID(),
        workerId: process.env.CNC_WORKER_ID ?? 'cnc-generation',
        claimedAt: now,
        heartbeatAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(cncOrders.id, request.orderId),
          eq(cncOrders.generation, request.generation),
          eq(cncOrders.generationRunId, context.runId),
          eq(cncOrders.status, order.status),
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

/** Read only the immutable keys copied onto this order after the buyer ownership gate. */
async function immutableArtwork(context: BackgroundJobContext, job: CncWorkerJob): Promise<Record<string, string>> {
  const assets: Record<string, { key: string; mime: string; sha256?: string }> = {};
  for (const artwork of job.config.artwork) {
    if (!artwork.assetId || assets[artwork.assetId]) continue;
    context.signal.throwIfAborted();
    if (
      !/^[A-Za-z0-9._-]{1,128}$/.test(artwork.assetId) ||
      !artwork.assetKey ||
      !isCncArtKey(artwork.assetKey) ||
      artwork.mime !== 'image/svg+xml'
    ) {
      throw new BackgroundJobError('CNC_ART_ASSET_INVALID', { retryable: false });
    }
    const [stored] = await context.database
      .select({
        key: cncArtAssets.key,
        mime: cncArtAssets.mime,
        sha256: cncArtAssets.sha256,
        sizeBytes: cncArtAssets.sizeBytes,
      })
      .from(cncArtAssets)
      .where(eq(cncArtAssets.id, artwork.assetId))
      .limit(1);
    if (stored && (stored.key !== artwork.assetKey || stored.mime !== artwork.mime)) {
      throw new BackgroundJobError('CNC_ART_ASSET_CHANGED', { retryable: false });
    }
    assets[artwork.assetId] = { key: artwork.assetKey, mime: artwork.mime, sha256: stored?.sha256 };
  }
  return loadCncGeneratorAssets(assets, context.signal);
}

function classifyFailure(error: unknown): BackgroundJobError {
  if (error instanceof BackgroundJobError) return error;
  if (error instanceof CncGeneratorError) return new BackgroundJobError(error.code, { retryable: error.retryable });
  if (error instanceof CncJobPayloadError) return new BackgroundJobError('CNC_INVALID_JOB', { retryable: false });
  if (error instanceof CncGenerationOutputError) return new BackgroundJobError(error.code);
  return new BackgroundJobError('CNC_GENERATION_FAILED');
}

export const cncGenerationFamily: BackgroundJobFamilyModule<CncGenerationRequest> = {
  name: 'cnc-generation',
  roles: ['cnc-generation'],
  payload: cncGenerationPayload,
  options: {
    expireInSeconds: 900,
    heartbeatSeconds: 30,
    deadlineSeconds: 3600,
    retryLimit: CNC_MAX_ATTEMPTS - 1,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 120,
  },
  singletonKey: (request) => `${request.orderId}:${request.generation}:${request.deliverable}`,
  async execute(context, request) {
    const order = await claimGeneration(context, request);
    if (!order) return;
    try {
      if (!isS3Configured('private')) throw new BackgroundJobError('CNC_STORAGE_UNAVAILABLE');
      const job = buildWorkerJob(order, { bucket: getBucketName('private'), issuedAt: new Date() });
      const assets = await immutableArtwork(context, job);
      const { claimToken: _claimToken, ...payload } = job;
      // The child gets no database credentials, claim token or backend API secret.
      const generated = await runCncGenerator(request.deliverable, payload, assets, context.signal);
      const parsed = cncGenerationCompletion.safeParse({
        ...generated.result,
        generatorVersion: generated.generatorVersion,
        generatorBuildSha: generated.buildSha,
      });
      if (!parsed.success) throw new BackgroundJobError('CNC_INVALID_GENERATOR_RESULT', { retryable: false });
      await verifyCncGenerationOutput(order, parsed.data, context.signal);
      await context.transaction(async (transaction) => {
        await transitionOrder(
          order.id,
          request.deliverable === 'preview' ? 'previewComplete' : 'complete',
          cncCompletionPatch(order, parsed.data),
          {
            executor: transaction,
            claimToken: order.claimToken!,
            generation: request.generation,
            generationRunId: context.runId,
          },
        );
      });
      // Mail and analytics stay on the backend, claimed by its reconciler.
    } catch (error) {
      const failure = classifyFailure(error);
      const status = failure.retryable
        ? nextStatusAfterFailure(order.attempts, undefined, request.deliverable)
        : request.deliverable === 'preview'
          ? 'preview_failed'
          : 'failed';
      const recordFailure = async (executor: BackgroundJobTransaction) => {
        await transitionOrder(
          order.id,
          request.deliverable === 'preview' ? 'previewFail' : 'fail',
          { status, lastError: failure.code, claimToken: null },
          {
            executor,
            claimToken: order.claimToken!,
            generation: request.generation,
            generationRunId: context.runId,
          },
        );
      };
      try {
        if (context.signal.aborted && context.transactionAfterAbort) await context.transactionAfterAbort(recordFailure);
        else await context.transaction(recordFailure);
      } catch {
        // Lost fences cannot write. Backend reconciliation settles exhausted runs.
      }
      logger.warn('[cnc-generation] attempt failed', { orderId: order.id, runId: context.runId, code: failure.code });
      throw failure;
    }
  },
};
