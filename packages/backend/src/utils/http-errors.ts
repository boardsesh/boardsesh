import { asErrorLikeRecord } from './error-utils';

const CLIENT_ABORT_ERROR_CODES = new Set(['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']);
const CLIENT_ABORT_ERROR_MESSAGES = new Set(['aborted', 'socket hang up']);

type ClientAbortContext = {
  requestDestroyed?: boolean;
  responseDestroyed?: boolean;
  socketDestroyed?: boolean;
};

function isDestroyedConnection(context: ClientAbortContext | undefined): boolean {
  return !!(context?.requestDestroyed || context?.responseDestroyed || context?.socketDestroyed);
}

export function isClientAbortError(error: unknown, context?: ClientAbortContext, depth = 0): boolean {
  if (depth > 3) return false;

  const errorRecord = asErrorLikeRecord(error);
  if (!errorRecord) return false;

  if (typeof errorRecord.code === 'string' && CLIENT_ABORT_ERROR_CODES.has(errorRecord.code)) {
    return true;
  }

  if (typeof errorRecord.message === 'string') {
    const normalizedMessage = errorRecord.message.trim().toLowerCase();
    if (CLIENT_ABORT_ERROR_MESSAGES.has(normalizedMessage)) return true;
  }

  if (typeof errorRecord.name === 'string' && errorRecord.name === 'AbortError') {
    return isDestroyedConnection(context);
  }

  return isClientAbortError(errorRecord.cause, context, depth + 1);
}
