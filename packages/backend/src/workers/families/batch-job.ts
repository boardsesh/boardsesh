import type { JobLogger, JobTransact } from '@boardsesh/db/jobs';
import { logger } from '../../utils/logger';
import type { BackgroundJobContext } from './types';

/**
 * The job bodies in `@boardsesh/db/jobs` take a write-batch runner. On the
 * worker that runner is the attempt fence, so every batch commits only while
 * this attempt still owns the run.
 */
export function fencedTransact(context: BackgroundJobContext): JobTransact {
  return (callback) => context.transaction((transaction) => callback(transaction));
}

/** Job progress lines, labelled with the family and run. */
export function jobLogger(context: BackgroundJobContext): JobLogger {
  const labels = { family: context.family, runId: context.runId };
  return {
    info: (message) => logger.info(message, labels),
    warn: (message) => logger.warn(message, labels),
  };
}
