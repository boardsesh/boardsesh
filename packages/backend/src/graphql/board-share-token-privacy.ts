import { GraphQLError, type ExecutionResult } from 'graphql';
import type { Plugin } from 'graphql-yoga';

const TOKEN_FIELDS = ['boardShareLinkPreview', 'redeemBoardShareLink'] as const;
const SAFE_ERROR_CODES = new Set([
  'BAD_USER_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_SERVER_ERROR',
]);

export function isBoardShareTokenDocument(document: string): boolean {
  return TOKEN_FIELDS.some((field) => document.includes(field));
}

/** Drop echoed coercion values, document literals, paths and original errors. */
export function sanitizeBoardShareGraphqlError(error: GraphQLError, document?: string): GraphQLError {
  const sourceBodies = [document, error.source?.body, ...(error.nodes ?? []).map((node) => node.loc?.source.body)];
  if (!sourceBodies.some((source) => source !== undefined && isBoardShareTokenDocument(source))) return error;
  const code = error.extensions.code;
  return new GraphQLError('Board share link request could not be processed', {
    extensions: { code: typeof code === 'string' && SAFE_ERROR_CODES.has(code) ? code : 'BAD_USER_INPUT' },
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
