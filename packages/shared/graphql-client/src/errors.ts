/**
 * Strict shape for the `extensions` blob the backend attaches to GraphQL
 * errors. Always carries an optional string `code`; payload fields for
 * known codes are unioned in so call-sites that narrow via the
 * `isClimbDuplicateExtension` guard below get strongly-typed payloads.
 *
 * Unknown codes (older clients hitting newer servers, codes we haven't
 * typed yet) flow through with `unknown` payload — callers can still
 * read `code` to switch on, and must explicitly cast to access anything
 * else.
 */
export type GraphQLErrorExtensions = {
  code?: string;
  existingClimbUuid?: string | null;
  existingClimbName?: string | null;
  retryAfterSeconds?: number | string | null;
  [key: string]: unknown;
};

/**
 * Type guard for the CLIMB_IS_DUPLICATE extension shape.
 */
export function isClimbDuplicateExtension(
  extensions: GraphQLErrorExtensions | null | undefined,
): extensions is GraphQLErrorExtensions & {
  code: 'CLIMB_IS_DUPLICATE';
  existingClimbUuid?: string | null;
  existingClimbName?: string | null;
} {
  return extensions?.code === 'CLIMB_IS_DUPLICATE';
}

export function isRateLimitExtension(
  extensions: GraphQLErrorExtensions | null | undefined,
): extensions is GraphQLErrorExtensions & {
  code: 'RATE_LIMITED';
  retryAfterSeconds?: number | string | null;
} {
  return extensions?.code === 'RATE_LIMITED';
}

/**
 * Error subclass that preserves GraphQL error extensions. Callers can inspect
 * `extensions.code` (or any other extension keys) to branch on a typed error
 * — e.g. CLIMB_IS_DUPLICATE — without resorting to message-string matching.
 *
 * `extensions` resolves to the first error that actually carries a `code`,
 * falling back to the first error's extensions otherwise. This matters when
 * the server emits multiple errors and the typed one isn't first — picking
 * blindly by index would silently drop the gate's CLIMB_IS_DUPLICATE code.
 */
export class GraphQLOperationError extends Error {
  readonly extensions: GraphQLErrorExtensions | null;
  readonly graphqlErrors: ReadonlyArray<{ message: string; extensions?: GraphQLErrorExtensions }>;

  constructor(graphqlErrors: ReadonlyArray<{ message: string; extensions?: GraphQLErrorExtensions }>) {
    const message = graphqlErrors.map((err) => err.message).join(', ');
    super(message);
    this.name = 'GraphQLOperationError';
    this.graphqlErrors = graphqlErrors;
    const coded = graphqlErrors.find((err) => err.extensions && typeof err.extensions.code === 'string');
    this.extensions = coded?.extensions ?? graphqlErrors[0]?.extensions ?? null;
  }
}

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number | null;
  readonly extensions: GraphQLErrorExtensions | null;
  readonly cause: unknown;

  constructor(
    message: string,
    retryAfterSeconds: number | null,
    extensions: GraphQLErrorExtensions | null,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
    this.extensions = extensions;
    this.cause = cause;
  }
}

const RATE_LIMIT_MESSAGE_PATTERN = /rate limit exceeded(?:\.?\s*try again in\s+(\d+(?:\.\d+)?)\s+seconds?)?/i;

function parseRetryAfterSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, value);
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return null;
}

function parseRetryAfterFromMessage(message: string): number | null {
  const match = RATE_LIMIT_MESSAGE_PATTERN.exec(message);
  if (!match) return null;
  return parseRetryAfterSeconds(match[1]);
}

function rateLimitFromGraphqlErrors(
  graphqlErrors: ReadonlyArray<{ message: string; extensions?: GraphQLErrorExtensions }>,
  cause: unknown,
): RateLimitError | null {
  for (const graphqlError of graphqlErrors) {
    if (isRateLimitExtension(graphqlError.extensions)) {
      return new RateLimitError(
        graphqlError.message,
        parseRetryAfterSeconds(graphqlError.extensions.retryAfterSeconds),
        graphqlError.extensions,
        cause,
      );
    }
  }

  for (const graphqlError of graphqlErrors) {
    if (RATE_LIMIT_MESSAGE_PATTERN.test(graphqlError.message)) {
      return new RateLimitError(
        graphqlError.message,
        parseRetryAfterFromMessage(graphqlError.message),
        graphqlError.extensions ?? null,
        cause,
      );
    }
  }

  return null;
}

export function parseRateLimitError(error: unknown): RateLimitError | null {
  if (error instanceof RateLimitError) {
    return error;
  }

  if (error instanceof GraphQLOperationError) {
    return rateLimitFromGraphqlErrors(error.graphqlErrors, error);
  }

  if (Array.isArray(error) && error.length > 0 && typeof error[0]?.message === 'string') {
    return rateLimitFromGraphqlErrors(
      error as ReadonlyArray<{ message: string; extensions?: GraphQLErrorExtensions }>,
      error,
    );
  }

  if (error instanceof Error && RATE_LIMIT_MESSAGE_PATTERN.test(error.message)) {
    return new RateLimitError(error.message, parseRetryAfterFromMessage(error.message), null, error);
  }

  return null;
}
