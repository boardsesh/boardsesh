import * as Sentry from '@sentry/node';
import { isProductionSentryEnvironment } from '@boardsesh/db/client/config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../utils/logger';
import { createJobQueueClient } from '../job-queue-client';
import { jobQueueErrorDiagnostics } from '../job-queue-errors';

vi.mock('@boardsesh/db/client/config', () => ({ isProductionSentryEnvironment: vi.fn(() => true) }));
vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@sentry/node', () => ({ withScope: vi.fn(), captureException: vi.fn() }));

const scope = { setTag: vi.fn(), setContext: vi.fn(), setFingerprint: vi.fn() };
const workerId = 'f3ce1cbd-0d21-40a5-8802-553258e76bac';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isProductionSentryEnvironment).mockReturnValue(true);
  vi.mocked(Sentry.withScope).mockImplementation((callback) => {
    if (typeof callback === 'function') {
      return (callback as (scope: Sentry.Scope) => unknown)(scope as unknown as Sentry.Scope);
    }
  });
  vi.mocked(Sentry.captureException).mockReset();
});

describe('job queue diagnostics', () => {
  it('keeps SQLSTATE and the known queue from pg-boss worker message annotations', () => {
    expect(
      jobQueueErrorDiagnostics({
        name: 'error',
        code: '57014',
        message: `canceling statement due to statement timeout (Queue: background-job-reconcile, Worker: ${workerId})`,
      }),
    ).toEqual({ code: '57014', errorType: 'error', queue: 'background-job-reconcile', failure: 'query_canceled' });
  });

  it('identifies a pg-pool acquisition timeout that has no error code', () => {
    expect(
      jobQueueErrorDiagnostics(
        new Error(`timeout exceeded when trying to connect (Queue: __pgboss__send-it, Worker: ${workerId})`),
      ),
    ).toEqual({ code: 'unknown', errorType: 'Error', queue: '__pgboss__send-it', failure: 'connection_timeout' });
  });

  it('retains socket codes and structured queue fields without exposing the cause', () => {
    expect(
      jobQueueErrorDiagnostics({
        name: 'Error',
        queue: 'background-batch',
        cause: Object.assign(new Error('postgres://username:secret@host/database'), { code: 'ECONNREFUSED' }),
      }),
    ).toEqual({ code: 'ECONNREFUSED', errorType: 'Error', queue: 'background-batch', failure: 'driver_error' });
  });

  it('handles the plain object pg-boss emits after spreading a worker Error', () => {
    const workerError = Object.assign(new Error('private query failed'), { code: '57014' });
    expect(
      jobQueueErrorDiagnostics({
        ...Object.fromEntries(Object.entries(workerError)),
        message: workerError.message,
        stack: workerError.stack,
        queue: 'background-job-reconcile',
        worker: workerId,
      }),
    ).toEqual({ code: '57014', errorType: 'unknown', queue: 'background-job-reconcile', failure: 'query_canceled' });
  });

  it.each([null, undefined, 'secret', 42])('handles non-object errors: %s', (error) => {
    expect(jobQueueErrorDiagnostics(error)).toEqual({
      code: 'unknown',
      errorType: 'unknown',
      queue: 'unknown',
      failure: 'unknown',
    });
  });

  it('rejects arbitrary diagnostic labels and tolerates circular causes', () => {
    const error: Record<string, unknown> = {
      name: 'secret',
      code: 'postgres://secret',
      queue: 'private-user-queue',
      message: 'SELECT secret FROM credentials',
    };
    error.cause = error;
    expect(jobQueueErrorDiagnostics(error)).toEqual({
      code: 'unknown',
      errorType: 'unknown',
      queue: 'unknown',
      failure: 'unknown',
    });
  });

  it('reports a real client error once with safe context and bounded grouping', () => {
    const client = createJobQueueClient({
      connectionString: 'postgres://unused@localhost/unused',
      owner: 'backend',
      poolSize: 2,
    });
    const original = Object.assign(new Error('SELECT secret FROM credentials'), {
      code: '53300',
      queue: 'background-job-reconcile',
      detail: 'postgres://username:secret@host/database',
      payload: { secret: 'token' },
    });
    client.emit('error', original);

    const diagnostics = {
      code: '53300',
      errorType: 'Error',
      queue: 'background-job-reconcile',
      failure: 'driver_error',
      owner: 'backend',
      poolSize: 2,
    };
    expect(logger.error).toHaveBeenCalledExactlyOnceWith('[job-queue] connection or execution failed', diagnostics);
    expect(scope.setContext).toHaveBeenCalledExactlyOnceWith('job_queue', diagnostics);
    expect(scope.setTag).toHaveBeenCalledWith('source', 'job-queue');
    expect(scope.setTag).toHaveBeenCalledWith('postgres.error_code', '53300');
    expect(scope.setFingerprint).toHaveBeenCalledExactlyOnceWith([
      'job-queue',
      'backend',
      '53300',
      'driver_error',
      'background-job-reconcile',
    ]);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const captured = vi.mocked(Sentry.captureException).mock.calls[0][0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured).not.toBe(original);
    expect((captured as Error).message).toBe('JOB_QUEUE_ERROR: driver_error (53300)');
    expect((captured as Error).cause).toBeUndefined();
    expect((captured as Error).stack).not.toContain('secret');
    expect(
      JSON.stringify([scope.setTag.mock.calls, scope.setContext.mock.calls, vi.mocked(logger.error).mock.calls]),
    ).not.toContain('secret');
  });

  it('logs worker diagnostics without capturing outside production', () => {
    vi.mocked(isProductionSentryEnvironment).mockReturnValue(false);
    const client = createJobQueueClient({
      connectionString: 'postgres://unused@localhost/unused',
      owner: 'worker',
      poolSize: 1,
    });
    client.emit('error', new Error('Connection terminated due to connection timeout'));
    expect(logger.error).toHaveBeenCalledWith(
      '[job-queue] connection or execution failed',
      expect.objectContaining({
        failure: 'connection_timeout',
        owner: 'worker',
        poolSize: 1,
      }),
    );
    expect(Sentry.withScope).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it.each(['scope', 'capture'])('does not break the queue when Sentry %s throws', (operation) => {
    const client = createJobQueueClient({
      connectionString: 'postgres://unused@localhost/unused',
      owner: 'backend',
      poolSize: 2,
    });
    const failReporting = () => {
      throw new Error('private SDK error');
    };
    if (operation === 'scope') vi.mocked(Sentry.withScope).mockImplementation(failReporting);
    else vi.mocked(Sentry.captureException).mockImplementation(failReporting);
    expect(() => client.emit('error', new Error('private driver error'))).not.toThrow();
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
