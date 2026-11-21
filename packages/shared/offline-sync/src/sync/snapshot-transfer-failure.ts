import { isNetworkError } from '../mutation-queue/error-classification';

export type SnapshotTransferFailureReason =
  | 'network'
  | 'background-transfer-decode'
  | 'http-range'
  | 'artifact-missing'
  | 'artifact-truncated';

export type SnapshotTransferFailure = {
  reason: SnapshotTransferFailureReason;
  /** Use the bounded transport ladder; false leaves the existing structural retry/fallback policy. */
  retryable: boolean;
  expected: boolean;
};

type NormalizedTransferReason = 'network' | 'http-range' | 'artifact-missing';

/** Snapshot-only classification must not change the mutation outbox's replay policy. */
export class SnapshotTransferError extends Error {
  readonly reason: NormalizedTransferReason;

  constructor(reason: NormalizedTransferReason, message: string, options: { cause: unknown }) {
    super(message, options);
    this.name = 'SnapshotTransferError';
    this.reason = reason;
  }
}

function causeChain(cause: unknown): unknown[] {
  const causes: unknown[] = [];
  let current = cause;
  for (let depth = 0; depth <= 3; depth += 1) {
    causes.push(current);
    if (current === null || typeof current !== 'object' || !('cause' in current)) break;
    const nested = current.cause;
    if (nested === current) break;
    current = nested;
  }
  return causes;
}

function errorMessage(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  if (cause === null || typeof cause !== 'object' || !('message' in cause)) return '';
  return typeof cause.message === 'string' ? cause.message : '';
}

function failure(reason: SnapshotTransferFailureReason): SnapshotTransferFailure {
  return {
    reason,
    retryable: reason !== 'artifact-missing',
    expected: reason === 'network' || reason === 'background-transfer-decode',
  };
}

/** Only the mobile background-session boundary may turn a raw decode error into this category. */
export function isSnapshotBackgroundDecodeError(cause: unknown): boolean {
  return causeChain(cause).some((entry) => {
    if (entry !== null && typeof entry === 'object') {
      const fields = entry as Record<string, unknown>;
      if (fields.code === 'NSURLErrorCannotDecodeRawData') return true;
      if (fields.domain === 'NSURLErrorDomain' && fields.code === -1015) return true;
    }
    // Expo currently forwards localized Foundation prose without its NSError code.
    // These are the exact English, Chinese and German signatures observed in #7987.
    return /cannot decode raw data|无法解码原始数据|Decodieren der Rohdaten nicht möglich/i.test(errorMessage(entry));
  });
}

/** Shared reason, retry and severity for snapshot failures, including wrapped native exceptions. */
export function classifySnapshotTransferFailure(cause: unknown): SnapshotTransferFailure | null {
  const causes = causeChain(cause);
  for (const entry of causes) {
    if (entry === null || typeof entry !== 'object') continue;
    const fields = entry as Record<string, unknown>;
    if (fields.name === 'SnapshotBackgroundTransferInterruptedError') return failure('background-transfer-decode');
    if (fields.name === 'SnapshotArtifactTruncatedError') return failure('artifact-truncated');
    if (
      fields.name === 'SnapshotTransferError' &&
      (fields.reason === 'network' || fields.reason === 'http-range' || fields.reason === 'artifact-missing')
    ) {
      return failure(fields.reason);
    }
  }
  // A received HTTP response is retryable here, but is not a connectivity interruption.
  if (
    causes.some((entry) => {
      if (entry !== null && typeof entry === 'object') {
        const fields = entry as Record<string, unknown>;
        if (fields.status === 416 || fields.statusCode === 416) return true;
      }
      return /\bserver returned HTTP 416\b/i.test(errorMessage(entry));
    })
  ) {
    return failure('http-range');
  }
  if (
    causes.some(
      (entry) =>
        (entry !== null && typeof entry === 'object' && 'code' in entry && entry.code === 'ENOENT') ||
        /\bENOENT\b/.test(errorMessage(entry)),
    )
  ) {
    return failure('artifact-missing');
  }
  if (
    isNetworkError(cause) ||
    causes.some((entry) =>
      /(?:^|Unable to download a file:\s*)(?:Connection reset(?:$|[.\s])|Software caused connection abort(?:$|[.\s])|Failed to connect to \S+)/i.test(
        errorMessage(entry),
      ),
    )
  ) {
    return failure('network');
  }
  return null;
}
