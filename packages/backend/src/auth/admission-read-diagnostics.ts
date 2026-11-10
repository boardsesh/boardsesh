export type AdmissionReadOutcome = 'deadline_missed' | 'refused' | 'failed' | 'slow';

/**
 * How one read spent its time. Only numbers and fixed labels: never a user id,
 * email or token, so a log line can be pasted anywhere.
 */
export type AdmissionReadSample = {
  outcome: AdmissionReadOutcome;
  /** Time before the read had a connection to run on. */
  waitMs: number;
  /** Time on a connection, including opening it when none was open. */
  executeMs: number;
  /** Reads in flight when this one was recorded, at most the runner's limit. */
  unsettledReads: number;
  /** Driver or SQLSTATE code, on `failed` only. */
  errorCode?: string;
};

/** One line per outcome per window, plus a totals line if the window saw more. */
export const ADMISSION_READ_LOG_WINDOW_MS = 10_000;

type OpenLogWindow = {
  suppressedReads: number;
  maxWaitMs: number;
  maxExecuteMs: number;
};

type LogFields = Record<string, number | string>;

/**
 * Logs the first read of each kind straight away, then counts the rest until
 * the window closes. A stall can therefore cost at most two lines per kind per
 * window, and the totals line still says how big the burst was.
 */
export function createAdmissionReadDiagnostics(
  log: (message: string, fields: LogFields) => void,
): (sample: AdmissionReadSample) => void {
  const openWindows = new Map<string, OpenLogWindow>();

  function closeWindow(windowKey: string, { outcome, errorCode }: AdmissionReadSample) {
    const closingWindow = openWindows.get(windowKey);
    openWindows.delete(windowKey);
    if (!closingWindow || closingWindow.suppressedReads === 0) return;
    log('[auth-admission] more reads like the last one', {
      outcome,
      ...(errorCode ? { errorCode } : {}),
      suppressedReads: closingWindow.suppressedReads,
      maxWaitMs: closingWindow.maxWaitMs,
      maxExecuteMs: closingWindow.maxExecuteMs,
      windowMs: ADMISSION_READ_LOG_WINDOW_MS,
    });
  }

  return (sample) => {
    const { outcome, errorCode, waitMs, executeMs, unsettledReads } = sample;
    const windowKey = `${outcome}:${errorCode ?? ''}`;
    const openWindow = openWindows.get(windowKey);
    if (openWindow) {
      openWindow.suppressedReads += 1;
      openWindow.maxWaitMs = Math.max(openWindow.maxWaitMs, waitMs);
      openWindow.maxExecuteMs = Math.max(openWindow.maxExecuteMs, executeMs);
      return;
    }
    openWindows.set(windowKey, { suppressedReads: 0, maxWaitMs: waitMs, maxExecuteMs: executeMs });
    setTimeout(() => closeWindow(windowKey, sample), ADMISSION_READ_LOG_WINDOW_MS).unref();
    log('[auth-admission] read slow or unanswered', {
      outcome,
      waitMs,
      executeMs,
      unsettledReads,
      ...(errorCode ? { errorCode } : {}),
    });
  };
}

const LOGGABLE_ERROR_CODE = /^[A-Z0-9_]{1,32}$/;

/** A driver or SQLSTATE code, or `UNKNOWN`. Never the error message, which can quote a value. */
export function admissionReadErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && LOGGABLE_ERROR_CODE.test(code) ? code : 'UNKNOWN';
}
