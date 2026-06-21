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
