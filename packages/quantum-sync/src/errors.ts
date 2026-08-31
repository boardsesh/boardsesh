export type QuantumSyncErrorCode =
  | 'CONFIG_INVALID'
  | 'NOSTR_RELAY_FAILED'
  | 'NOSTR_EVENT_INVALID'
  | 'NOSTR_NO_VALID_MANIFEST'
  | 'MANIFEST_INVALID'
  | 'MIRROR_DOWNLOAD_FAILED'
  | 'CHUNK_INTEGRITY_FAILED'
  | 'DECOMPRESSION_FAILED'
  | 'DECOMPRESSION_LIMIT_EXCEEDED'
  | 'SQLITE_INVALID'
  | 'IMPORT_FAILED';

export class QuantumSyncError extends Error {
  readonly code: QuantumSyncErrorCode;
  readonly cause?: unknown;

  constructor(code: QuantumSyncErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message);
    this.name = 'QuantumSyncError';
    this.code = code;
    this.cause = options.cause;
  }
}

export function quantumSyncErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
