import { z } from 'zod';
import { GraphQLError } from 'graphql';
import { SUPPORTED_BOARDS } from '@boardsesh/shared-schema';
import { exportPeriodStart, generateUserDataExport, userDataExportSingletonKey } from '../../services/user-data-export';
import { isS3Configured } from '../../storage/s3';
import { BackgroundJobError, type BackgroundJobFamilyModule } from './types';
import { boundedErrorFields } from './job-logging';
import { logger } from '../../utils/logger';

const payload = z
  .object({
    userId: z.string().min(1).max(128),
    boardType: z.enum(SUPPORTED_BOARDS),
    period: z.string().refine((period) => {
      try {
        exportPeriodStart(period);
        return true;
      } catch {
        return false;
      }
    }),
  })
  .strict();

export const userDataExportFamily: BackgroundJobFamilyModule<z.infer<typeof payload>> = {
  name: 'user-data-export',
  roles: ['maintenance-delivery'],
  payload,
  options: {
    expireInSeconds: 300,
    heartbeatSeconds: 30,
    deadlineSeconds: 1800,
    retryLimit: 1,
    retryDelay: 15,
    retryBackoff: true,
    retryDelayMax: 120,
  },
  singletonKey: userDataExportSingletonKey,
  async execute(context, request) {
    const startedAtMs = Date.now();
    if (!isS3Configured('private')) throw new BackgroundJobError('EXPORT_STORAGE_UNAVAILABLE');
    try {
      await generateUserDataExport(context, request);
    } catch (error) {
      logger.warn('[user-data-export] generation failed', {
        runId: context.runId,
        boardType: request.boardType,
        period: request.period,
        durationMs: Date.now() - startedAtMs,
        ...boundedErrorFields(error),
      });
      if (
        (error instanceof GraphQLError && error.extensions.code === 'UNAUTHENTICATED') ||
        (error instanceof Error && error.message === 'EXPORT_USER_MISSING')
      )
        throw new BackgroundJobError('EXPORT_USER_MISSING', { retryable: false });
      if (error instanceof Error && error.message === 'EXPORT_ARCHIVE_INVALID')
        throw new BackgroundJobError('EXPORT_ARCHIVE_INVALID', { retryable: false });
      throw error;
    }
  },
};
