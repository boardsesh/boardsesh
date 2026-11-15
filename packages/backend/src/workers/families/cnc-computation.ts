import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { cncComputations } from '@boardsesh/db/schema';
import { loadCncGeneratorAssets } from '../../services/cnc/generator-assets';
import { CncGeneratorError, runCncGenerator } from '../../services/cnc/generator-process';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';

const payload = z.object({ requestId: z.string().uuid() }).strict();

export const cncComputationFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'cnc-computation',
  roles: ['cnc-interactive'],
  payload,
  options: {
    expireInSeconds: 60,
    retryLimit: 1,
    retryDelay: 1,
    retryBackoff: true,
    retryDelayMax: 1,
    deadlineSeconds: 90,
    heartbeatSeconds: 30,
  },
  async execute(context, { requestId }) {
    const [request] = await context.database
      .select()
      .from(cncComputations)
      .where(eq(cncComputations.id, requestId))
      .limit(1);
    if (!request || request.runId !== context.runId || request.expiresAt.getTime() <= Date.now())
      throw new BackgroundJobError('CNC_REQUEST_EXPIRED', { retryable: false });
    if (request.status === 'ready' || request.status === 'failed') return;
    if (request.generatorSha !== process.env.CNC_GENERATOR_SHA)
      throw new BackgroundJobError('GENERATOR_RELEASE_MISMATCH', { retryable: false });
    await context.transaction(async (transaction) => {
      await transaction
        .update(cncComputations)
        .set({ status: 'running' })
        .where(and(eq(cncComputations.id, requestId), eq(cncComputations.runId, context.runId)));
    });
    try {
      const assets = await loadCncGeneratorAssets(request.assetKeys, context.signal);
      const output = await runCncGenerator(request.operation, request.request, assets, context.signal);
      await context.transaction(async (transaction) => {
        await transaction
          .update(cncComputations)
          .set({ status: 'ready', result: output.result, errorCode: null })
          .where(and(eq(cncComputations.id, requestId), eq(cncComputations.runId, context.runId)));
      });
    } catch (error) {
      if (error instanceof CncGeneratorError && !error.retryable) {
        await context.transaction(async (transaction) => {
          await transaction
            .update(cncComputations)
            .set({ status: 'failed', result: null, errorCode: error.code })
            .where(and(eq(cncComputations.id, requestId), eq(cncComputations.runId, context.runId)));
        });
        return;
      }
      throw new BackgroundJobError(error instanceof CncGeneratorError ? error.code : 'CNC_COMPUTATION_FAILED');
    }
  },
};
