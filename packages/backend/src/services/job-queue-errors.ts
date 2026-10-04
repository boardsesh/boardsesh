import * as Sentry from '@sentry/node';
import { isProductionSentryEnvironment } from '@boardsesh/db/client/config';
import {
  BACKGROUND_JOB_QUEUES,
  BACKGROUND_JOB_RECONCILE_QUEUE,
  BACKGROUND_SCHEDULE_QUEUE,
} from '@boardsesh/db/background-jobs';
import { CLIMB_POPULARITY_REFRESH_QUEUE, POPULAR_BOARD_CONFIGS_REFRESH_QUEUE } from '@boardsesh/db/job-queue-schema';
import {
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_DEAD_QUEUE,
  SPRAY_DETECTION_RECONCILE_QUEUE,
} from '@boardsesh/shared-schema';
import { logger } from '../utils/logger';
import { getPostgresErrorCode } from '../utils/postgres-errors';

const QUEUE_NAMES = new Set([
  ...Object.values(BACKGROUND_JOB_QUEUES),
  BACKGROUND_JOB_RECONCILE_QUEUE,
  BACKGROUND_SCHEDULE_QUEUE,
  CLIMB_POPULARITY_REFRESH_QUEUE,
  POPULAR_BOARD_CONFIGS_REFRESH_QUEUE,
  SPRAY_DETECTION_QUEUE,
  SPRAY_DETECTION_DEAD_QUEUE,
  SPRAY_DETECTION_RECONCILE_QUEUE,
  '__pgboss__send-it',
]);
const ERROR_TYPES = new Set([
  'Error',
  'error',
  'TypeError',
  'RangeError',
  'AggregateError',
  'DatabaseError',
  'PostgresError',
]);
const DRIVER_CODES = new Set([
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/** Only allowlisted identifiers leave this boundary; never the message, stack or cause. */
export function jobQueueErrorDiagnostics(error: unknown) {
  const errorRecord = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};
  const originalCode = getPostgresErrorCode(error);
  const code =
    originalCode && (/^[0-9A-Z]{5}$/.test(originalCode) || DRIVER_CODES.has(originalCode)) ? originalCode : 'unknown';
  const errorType =
    typeof errorRecord.name === 'string' && ERROR_TYPES.has(errorRecord.name) ? errorRecord.name : 'unknown';
  const message = typeof errorRecord.message === 'string' ? errorRecord.message : '';
  // pg-boss 12 annotates worker failures in the message. Other emitters supply a queue field.
  const queueSuffix = / \(Queue: ([a-z_-]{1,64}), Worker: [0-9a-f-]{36}\)$/.exec(message);
  const queueCandidate = typeof errorRecord.queue === 'string' ? errorRecord.queue : queueSuffix?.[1];
  const queue = queueCandidate && QUEUE_NAMES.has(queueCandidate) ? queueCandidate : 'unknown';
  // pg-pool's acquisition timeout has no code; retain its meaning without copying its text.
  const failure =
    code === 'CONNECT_TIMEOUT' ||
    code === 'ETIMEDOUT' ||
    message.startsWith('timeout exceeded when trying to connect') ||
    message.startsWith('Connection terminated due to connection timeout')
      ? 'connection_timeout'
      : code === '57014'
        ? 'query_canceled'
        : code === 'unknown'
          ? 'unknown'
          : 'driver_error';
  return { code, errorType, queue, failure };
}

export function reportJobQueueError(error: unknown, options: { owner: 'backend' | 'worker'; poolSize: number }): void {
  const diagnostics = { ...jobQueueErrorDiagnostics(error), owner: options.owner, poolSize: options.poolSize };
  // Message-only logging bypasses the Winston Sentry transport; the scoped capture below is the only event.
  logger.error('[job-queue] connection or execution failed', diagnostics);
  if (!isProductionSentryEnvironment()) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag('source', 'job-queue');
      scope.setTag('postgres.error_code', diagnostics.code);
      scope.setTag('job_queue.error_type', diagnostics.errorType);
      scope.setTag('job_queue.queue', diagnostics.queue);
      scope.setTag('job_queue.failure', diagnostics.failure);
      scope.setTag('job_queue.owner', diagnostics.owner);
      scope.setContext('job_queue', diagnostics);
      scope.setFingerprint(['job-queue', diagnostics.owner, diagnostics.code, diagnostics.failure, diagnostics.queue]);
      Sentry.captureException(new Error(`JOB_QUEUE_ERROR: ${diagnostics.failure} (${diagnostics.code})`));
    });
  } catch {
    // Diagnostics must never throw back into pg-boss's worker or pool error handler.
  }
}
