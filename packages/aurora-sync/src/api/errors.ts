// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

export type AuroraErrorCode =
  | 'http'
  | 'timeout'
  | 'network'
  | 'invalid_credentials'
  | 'rate_limited'
  | 'invalid_response';

type AuroraRequestErrorOptions = {
  code: AuroraErrorCode;
  message: string;
  status?: number;
  statusText?: string;
  url?: string;
  details?: unknown;
  cause?: unknown;
};

type AuroraResponseErrorMessages = {
  invalidCredentialsMessage?: string;
  rateLimitedMessage?: string;
};

const TRANSIENT_AURORA_ERROR_CODES = new Set<AuroraErrorCode>([
  'http',
  'timeout',
  'network',
  'rate_limited',
  'invalid_response',
]);

export class AuroraRequestError extends Error {
  readonly code: AuroraErrorCode;
  readonly status?: number;
  readonly statusText?: string;
  readonly url?: string;
  readonly details?: unknown;
  readonly transient: boolean;

  constructor(options: AuroraRequestErrorOptions) {
    super(options.message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AuroraRequestError';
    this.code = options.code;
    this.status = options.status;
    this.statusText = options.statusText;
    this.url = options.url;
    this.details = options.details;
    this.transient = TRANSIENT_AURORA_ERROR_CODES.has(options.code);
  }
}

export function isAuroraRequestError(error: unknown): error is AuroraRequestError {
  return error instanceof AuroraRequestError;
}

export function isTransientAuroraError(error: unknown): error is AuroraRequestError {
  return isAuroraRequestError(error) && error.transient;
}

/**
 * Narrow retry classifier for the board-wide shared sync.
 *
 * The general Aurora classifier intentionally treats every HTTP error and an
 * invalid response as transient for credential login. Shared sync has a
 * different failure contract: shortening its persisted cooldown is safe only
 * for canonical transport/rate-limit failures and server-side HTTP failures.
 * Unknown throws, malformed responses, statusless HTTP errors and client-side
 * HTTP failures keep the full cooldown so a deterministic failure cannot loop
 * every daemon cycle.
 */
export function isTransientSharedSyncAuroraError(error: unknown): error is AuroraRequestError {
  if (!isAuroraRequestError(error)) return false;

  if (error.code === 'timeout' || error.code === 'network' || error.code === 'rate_limited') {
    return true;
  }

  return (
    error.code === 'http' &&
    error.status !== undefined &&
    (error.status === 429 || (error.status >= 500 && error.status <= 599))
  );
}

export async function assertAuroraResponseOk(
  response: Response,
  url: string,
  messages: AuroraResponseErrorMessages = {},
): Promise<void> {
  if (response.ok) {
    return;
  }

  const error = await createAuroraResponseError(response, url, messages);
  console.error(`Aurora API error: ${response.status} ${response.statusText} (${url})`, error.details);
  throw error;
}

export async function createAuroraResponseError(
  response: Response,
  url: string,
  messages: AuroraResponseErrorMessages = {},
): Promise<AuroraRequestError> {
  const details = await readAuroraErrorDetails(response);

  if (response.status === 422) {
    return new AuroraRequestError({
      code: 'invalid_credentials',
      message: messages.invalidCredentialsMessage ?? 'Aurora rejected the request (HTTP 422).',
      status: response.status,
      statusText: response.statusText,
      url,
      details,
    });
  }

  if (response.status === 429) {
    return new AuroraRequestError({
      code: 'rate_limited',
      message: messages.rateLimitedMessage ?? 'Aurora rate limited the request. Please try again later.',
      status: response.status,
      statusText: response.statusText,
      url,
      details,
    });
  }

  return new AuroraRequestError({
    code: 'http',
    message: `Aurora HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
    status: response.status,
    statusText: response.statusText,
    url,
    details,
  });
}

export function createAuroraTimeoutError(url: string, cause?: unknown): AuroraRequestError {
  return new AuroraRequestError({
    code: 'timeout',
    message: `Aurora request timed out: ${url}`,
    url,
    cause,
  });
}

export function createAuroraNetworkError(url: string, cause?: unknown): AuroraRequestError {
  return new AuroraRequestError({
    code: 'network',
    message: `Aurora network error: ${url}`,
    url,
    cause,
  });
}

export function createAuroraInvalidResponseError(url: string, cause?: unknown): AuroraRequestError {
  return new AuroraRequestError({
    code: 'invalid_response',
    message: `Aurora returned an invalid response: ${url}`,
    url,
    cause,
  });
}

async function readAuroraErrorDetails(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    try {
      const text = await response.clone().text();
      return text.length > 0 ? text : null;
    } catch {
      return null;
    }
  }
}
