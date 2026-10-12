import { GraphQLError, type ExecutionResult } from 'graphql';
import type { Plugin } from 'graphql-yoga';

const TOKEN_FIELDS = ['boardShareLinkPreview', 'redeemBoardShareLink'] as const;
const SAFE_ERROR_CODES = new Set([
  'BAD_USER_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_SERVER_ERROR',
  'RATE_LIMITED',
  'PRIVACY_UNAVAILABLE',
]);

export function isBoardShareTokenDocument(document: string): boolean {
  return TOKEN_FIELDS.some((field) => document.includes(field));
}

/** Numbers only: they cannot carry the token, and clients act on them. */
function safeExtensions(extensions: GraphQLError['extensions']) {
  const { code, retryAfterSeconds, http } = extensions;
  const status = typeof http === 'object' && http !== null ? (http as { status?: unknown }).status : undefined;
  return {
    code: typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'BAD_USER_INPUT',
    ...(typeof retryAfterSeconds === 'number' ? { retryAfterSeconds } : {}),
    ...(typeof status === 'number' ? { http: { status } } : {}),
  };
}

/**
 * Drop echoed coercion values, document literals and original errors from a
 * request that names a token field.
 *
 * Only errors raised before any resolver ran can echo the token: parse,
 * validation and variable coercion. Those carry no `path`. An error with a path
 * came from executing the field, after the token parsed as a String, and the
 * share resolvers never put it in one (`withoutTokenInErrors` strips database
 * errors), so it passes whole: RATE_LIMITED keeps `retryAfterSeconds` for the
 * app's retry. A masked database error has no path either; it keeps its code
 * and its 503.
 */
export function sanitizeBoardShareGraphqlError(error: GraphQLError, document?: string): GraphQLError {
  if (error.path !== undefined) return error;
  const sourceBodies = [document, error.source?.body, ...(error.nodes ?? []).map((node) => node.loc?.source.body)];
  if (!sourceBodies.some((source) => source !== undefined && isBoardShareTokenDocument(source))) return error;
  return new GraphQLError('Board share link request could not be processed', {
    extensions: safeExtensions(error.extensions),
  });
}

export function sanitizeBoardShareLogArgument(argument: unknown): unknown {
  if (argument instanceof GraphQLError) return sanitizeBoardShareGraphqlError(argument);
  if (Array.isArray(argument)) return argument.map(sanitizeBoardShareLogArgument);
  return argument;
}

export function sanitizeBoardShareResult(result: ExecutionResult, document?: string): ExecutionResult {
  if (!result.errors) return result;
  return { ...result, errors: result.errors.map((error) => sanitizeBoardShareGraphqlError(error, document)) };
}

/** HTTP parse/coercion failures also occur before any resolver-level masking. */
export function boardShareTokenPrivacyPlugin(): Plugin {
  return {
    onResultProcess: (payload) => {
      const { result } = payload;
      if (Symbol.asyncIterator in result) return;
      payload.setResult(
        Array.isArray(result)
          ? result.map((entry) => sanitizeBoardShareResult(entry))
          : sanitizeBoardShareResult(result),
      );
    },
  };
}
