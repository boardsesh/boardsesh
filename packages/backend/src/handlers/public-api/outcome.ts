import { apiErrorBody, type PublicApiErrorCode } from './http';

/** What a `/v1` route answers, before the router adds the common headers and CORS. */
export interface ApiOutcome {
  status: number;
  /** Already checked against the contract. Absent for a 204. */
  body?: object;
  headers?: Record<string, string>;
  /** For the log line only. */
  refusal?: string;
}

const UNAVAILABLE_RETRY_AFTER_SECONDS = 2;

/** RFC 6750 section 3. A request with no credentials gets the scheme alone. */
export const CHALLENGE_NO_TOKEN = 'Bearer';
export const CHALLENGE_INVALID_TOKEN = 'Bearer error="invalid_token"';

export function errorOutcome(
  status: number,
  error: PublicApiErrorCode,
  message: string,
  requestId: string,
  { headers = {}, refusal, field }: { headers?: Record<string, string>; refusal?: string; field?: string } = {},
): ApiOutcome {
  return { status, body: apiErrorBody(error, message, requestId, field), headers, refusal };
}

export function unauthorized(requestId: string, challenge: string, refusal: string): ApiOutcome {
  return errorOutcome(
    401,
    'invalid_token',
    'The access token is missing, expired or revoked. Refresh once and retry.',
    requestId,
    { headers: { 'www-authenticate': challenge }, refusal },
  );
}

/** `503` with `Retry-After`: busy, paused, or a snapshot that cannot be served yet. */
export function unavailable(
  requestId: string,
  {
    retryAfterSeconds = UNAVAILABLE_RETRY_AFTER_SECONDS,
    message = 'The server is busy. Try again shortly.',
    refusal,
  }: {
    retryAfterSeconds?: number;
    message?: string;
    refusal?: string;
  } = {},
): ApiOutcome {
  return errorOutcome(503, 'server_error', message, requestId, {
    headers: { 'retry-after': String(retryAfterSeconds) },
    refusal,
  });
}

export function serverError(requestId: string): ApiOutcome {
  return errorOutcome(500, 'server_error', 'Something went wrong on our side. Retry with backoff.', requestId);
}
