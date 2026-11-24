import { GraphQLError, type ExecutionResult } from 'graphql';
import type { Plugin } from 'graphql-yoga';

export function isAddressLookupDocument(document: string): boolean {
  return document.includes('lookupGymAddressCoordinates');
}

/** Coercion errors can echo an address before the authenticated resolver runs. */
export function sanitizeAddressLookupError(error: GraphQLError, document?: string): GraphQLError {
  const sources = [document, error.source?.body, ...(error.nodes ?? []).map((node) => node.loc?.source.body)];
  if (!sources.some((source) => source !== undefined && isAddressLookupDocument(source))) return error;
  const { code, retryAfterSeconds, http } = error.extensions;
  const status = typeof http === 'object' && http !== null ? (http as { status?: unknown }).status : undefined;
  return new GraphQLError('Address lookup could not be processed', {
    extensions: {
      code:
        typeof code === 'string' &&
        ['BAD_USER_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'RATE_LIMITED', 'INTERNAL_SERVER_ERROR'].includes(code)
          ? code
          : 'BAD_USER_INPUT',
      ...(typeof retryAfterSeconds === 'number' ? { retryAfterSeconds } : {}),
      ...(typeof status === 'number' ? { http: { status } } : {}),
    },
  });
}

export function sanitizeAddressLookupLogArgument(argument: unknown): unknown {
  if (argument instanceof GraphQLError) return sanitizeAddressLookupError(argument);
  if (Array.isArray(argument)) return argument.map(sanitizeAddressLookupLogArgument);
  return argument;
}

export function sanitizeAddressLookupResult(result: ExecutionResult, document?: string): ExecutionResult {
  if (!result.errors) return result;
  return { ...result, errors: result.errors.map((error) => sanitizeAddressLookupError(error, document)) };
}

export function addressLookupPrivacyPlugin(): Plugin {
  return {
    onResultProcess: (payload) => {
      const { result } = payload;
      if (Symbol.asyncIterator in result) return;
      payload.setResult(
        Array.isArray(result)
          ? result.map((entry) => sanitizeAddressLookupResult(entry))
          : sanitizeAddressLookupResult(result),
      );
    },
  };
}
