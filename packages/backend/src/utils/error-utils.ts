export type ErrorLikeRecord = {
  code?: unknown;
  cause?: unknown;
  message?: unknown;
  name?: unknown;
};

export function asErrorLikeRecord(error: unknown): ErrorLikeRecord | null {
  return error && typeof error === 'object' ? (error as ErrorLikeRecord) : null;
}
