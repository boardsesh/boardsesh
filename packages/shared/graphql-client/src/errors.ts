// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Boardsesh contributors

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
  // Seconds until the rate-limit window resets (carried by RATE_LIMITED).
  retryAfterSeconds?: number;
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

/**
 * Type guard for the RATE_LIMITED extension shape. The backend throttles
 * per-user, per-operation; when a burst trips a bucket the resolver rejects
 * with this code so callers can show a specific "slow down" message and read
 * `retryAfterSeconds` instead of swallowing it into a generic failure toast.
 */
export function isRateLimitedExtension(
  extensions: GraphQLErrorExtensions | null | undefined,
): extensions is GraphQLErrorExtensions & { code: 'RATE_LIMITED'; retryAfterSeconds?: number } {
  return extensions?.code === 'RATE_LIMITED';
}

/**
 * Type guard for the NOT_SESSION_MEMBER extension shape. The backend's
 * subscription-auth gate (`requireSessionMember`) rejects a caller who isn't a
 * member of the session (issues #2355 / #2385). Since #3695 an authenticated
 * member reconnecting is re-authorized instantly, so this code reaching a
 * client means the session is genuinely gone for it (ended / emptied / a stale
 * pointer) — the caller should clear the local session silently rather than
 * surface a generic sync-error toast. `reason` (`no-session-id` |
 * `session-mismatch`) is carried for observability.
 */
export function isNotSessionMemberExtension(
  extensions: GraphQLErrorExtensions | null | undefined,
): extensions is GraphQLErrorExtensions & { code: 'NOT_SESSION_MEMBER'; reason?: string } {
  return extensions?.code === 'NOT_SESSION_MEMBER';
}

/** Convenience: does this error carry the NOT_SESSION_MEMBER code? Narrows
 *  `unknown` for call-sites that only hold the thrown/callback value.
 *
 *  Handles both shapes a client can see:
 *   - a `GraphQLOperationError` — from `execute()` or the `subscribe()` wrapper
 *     (web's session subscriptions, board-presence);
 *   - a raw `GraphQLError[]` payload — delivered straight to a graphql-ws
 *     `client.subscribe` sink's `error` callback (mobile's session
 *     subscriptions call the ws client directly, so they never pass through the
 *     `subscribe()` wrapper that would box the array into a
 *     `GraphQLOperationError`). */
export function isNotSessionMemberError(error: unknown): boolean {
  if (error instanceof GraphQLOperationError) {
    // Iterate every error, not just `error.extensions` — that convenience field
    // resolves to the FIRST *coded* error, so a NOT_SESSION_MEMBER that trails
    // another coded error would be missed. Mirrors `parseRateLimitError`'s
    // graphqlErrors fallback.
    return error.graphqlErrors.some((graphqlError) => isNotSessionMemberExtension(graphqlError.extensions));
  }
  if (Array.isArray(error)) {
    return error.some(
      (item): boolean =>
        typeof item === 'object' &&
        item !== null &&
        (item as { extensions?: { code?: unknown } }).extensions?.code === 'NOT_SESSION_MEMBER',
    );
  }
  return false;
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

/**
 * Legacy message shape the backend emits alongside the `RATE_LIMITED` code —
 * kept as a fallback so a pre-#2763 server (code-less throw) or a subscription
 * error that arrives message-only is still recognised as a rate limit. Mirrors
 * `RateLimitError`'s message in `packages/backend/src/utils/rate-limiter.ts`.
 */
const RATE_LIMIT_MESSAGE_RE = /rate limit exceeded\.\s*try again in (\d+)\s*seconds?\./i;

export type ParsedRateLimit = {
  /** Seconds until the window resets, or null when the server didn't say. */
  retryAfterSeconds: number | null;
};

function parseRateLimitExtensions(extensions: unknown): ParsedRateLimit | null {
  if (typeof extensions !== 'object' || extensions === null) return null;
  const code = (extensions as { code?: unknown }).code;
  if (code !== 'RATE_LIMITED') return null;
  const retryAfterSeconds = (extensions as { retryAfterSeconds?: unknown }).retryAfterSeconds;
  return { retryAfterSeconds: typeof retryAfterSeconds === 'number' ? retryAfterSeconds : null };
}

function parseGraphqlRequestClientError(error: unknown): ParsedRateLimit | null {
  // graphql-request's ClientError is intentionally matched structurally so
  // this renderer-neutral package does not need that HTTP client at runtime.
  // Its response carries the original GraphQL errors and extensions.
  if (typeof error !== 'object' || error === null) return null;
  const response = (error as { response?: unknown }).response;
  if (typeof response !== 'object' || response === null) return null;
  const errors = (response as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return null;
  for (const graphqlError of errors) {
    if (typeof graphqlError !== 'object' || graphqlError === null) continue;
    const parsed = parseRateLimitExtensions((graphqlError as { extensions?: unknown }).extensions);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * Classify an error thrown by `execute()`/`subscribe()` as a rate-limit
 * rejection. Prefers the structured `RATE_LIMITED` extension (with
 * `retryAfterSeconds`), falling back to the human-readable message so a
 * pre-#2763 server is still handled. Returns `null` for anything that isn't a
 * rate limit — callers use that to decide whether to back off and retry.
 */
export function parseRateLimitError(error: unknown): ParsedRateLimit | null {
  if (error instanceof GraphQLOperationError) {
    if (isRateLimitedExtension(error.extensions)) {
      return { retryAfterSeconds: error.extensions.retryAfterSeconds ?? null };
    }
    for (const graphqlError of error.graphqlErrors) {
      if (graphqlError.extensions?.code === 'RATE_LIMITED') {
        const { retryAfterSeconds } = graphqlError.extensions;
        return { retryAfterSeconds: typeof retryAfterSeconds === 'number' ? retryAfterSeconds : null };
      }
    }
    const messageMatch = error.message.match(RATE_LIMIT_MESSAGE_RE);
    return messageMatch ? { retryAfterSeconds: Number(messageMatch[1]) } : null;
  }
  const clientErrorRateLimit = parseGraphqlRequestClientError(error);
  if (clientErrorRateLimit) return clientErrorRateLimit;
  if (error instanceof Error) {
    const messageMatch = error.message.match(RATE_LIMIT_MESSAGE_RE);
    if (messageMatch) return { retryAfterSeconds: Number(messageMatch[1]) };
  }
  return null;
}

/** Convenience boolean form of {@link parseRateLimitError}. */
export function isRateLimitedError(error: unknown): boolean {
  return parseRateLimitError(error) !== null;
}
