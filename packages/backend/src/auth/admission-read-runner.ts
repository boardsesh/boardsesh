import { logger } from '../utils/logger';
import {
  admissionReadErrorCode,
  createAdmissionReadDiagnostics,
  type AdmissionReadOutcome,
} from './admission-read-diagnostics';

export const AUTH_ADMISSION_RESPONSE_DEADLINE_MS = 1000;
export const MAX_UNSETTLED_AUTH_ADMISSION_READS = 8;
export const AUTH_ADMISSION_BATCH_SIZE = 128;
/** A read answered in time but at least this slow still earns a log line. */
export const AUTH_ADMISSION_SLOW_READ_MS = 250;

export class AuthAdmissionUnavailableError extends Error {
  constructor() {
    super('Authentication is temporarily unavailable');
    this.name = 'AuthAdmissionUnavailableError';
  }
}

export function isAuthAdmissionUnavailable(error: unknown): error is AuthAdmissionUnavailableError {
  return error instanceof AuthAdmissionUnavailableError;
}

let unsettledReads = 0;
let recordAdmissionRead = createAdmissionReadDiagnostics((message, fields) => logger.warn(message, fields));

/** Test seam: drops any open log window so a later test starts clean. */
export function __resetAuthAdmissionDiagnosticsForTests(): void {
  recordAdmissionRead = createAdmissionReadDiagnostics((message, fields) => logger.warn(message, fields));
}

/**
 * Bounds caller waiting and actual outstanding READS, without claiming SQL
 * cancellation. A timed-out call keeps its slot until its underlying read
 * settles. Never use this response race around a write transaction.
 *
 * `read` calls its argument once it has a connection, which is what splits a
 * read's time into waiting for a connection and running on one.
 */
export async function runAuthAdmissionRead<Result>(
  read: (markExecuting: () => void) => PromiseLike<Result>,
): Promise<Result> {
  if (unsettledReads >= MAX_UNSETTLED_AUTH_ADMISSION_READS) {
    recordAdmissionRead({ outcome: 'refused', waitMs: 0, executeMs: 0, unsettledReads });
    throw new AuthAdmissionUnavailableError();
  }
  const startedAt = performance.now();
  const deadline = startedAt + AUTH_ADMISSION_RESPONSE_DEADLINE_MS;
  unsettledReads += 1;
  let executingSince: number | undefined;
  let isOutcomeRecorded = false;
  const recordOutcome = (outcome: Exclude<AdmissionReadOutcome, 'refused'>, errorCode?: string) => {
    if (isOutcomeRecorded) return;
    isOutcomeRecorded = true;
    const recordedAt = performance.now();
    const ranAt = executingSince ?? recordedAt;
    recordAdmissionRead({
      outcome,
      waitMs: Math.round(ranAt - startedAt),
      executeMs: Math.round(recordedAt - ranAt),
      unsettledReads,
      ...(errorCode ? { errorCode } : {}),
    });
  };
  const operation = Promise.resolve().then(() =>
    read(() => {
      executingSince ??= performance.now();
    }),
  );
  void operation.then(
    () => {
      unsettledReads -= 1;
    },
    () => {
      unsettledReads -= 1;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      operation.catch((error: unknown) => {
        recordOutcome('failed', admissionReadErrorCode(error));
        throw new AuthAdmissionUnavailableError();
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          recordOutcome('deadline_missed');
          reject(new AuthAdmissionUnavailableError());
        }, AUTH_ADMISSION_RESPONSE_DEADLINE_MS);
      }),
    ]);
    // A stalled event loop can run the settled read's microtask before its
    // overdue timer. Neither a late positive nor a late denial is authoritative.
    const answeredAt = performance.now();
    if (answeredAt >= deadline) {
      recordOutcome('deadline_missed');
      throw new AuthAdmissionUnavailableError();
    }
    if (answeredAt - startedAt >= AUTH_ADMISSION_SLOW_READ_MS) recordOutcome('slow');
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
