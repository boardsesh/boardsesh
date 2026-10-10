import { GraphQLError, type ExecutionResult } from 'graphql';
import type { Plugin } from 'graphql-yoga';

const APPLE_ADS_MUTATION_NAME = 'exchangeAppleAdsAttribution';

/**
 * GraphQL coercion/parse errors may echo variable values before the resolver
 * runs. AST nodes also retain the complete document (including token literals).
 * Discard both for this mutation before generic logs or responses see them.
 */
export function sanitizeAppleAdsGraphqlError(error: GraphQLError): GraphQLError {
  const sourceBodies = [error.source?.body, ...(error.nodes ?? []).map((node) => node.loc?.source.body)];
  if (!sourceBodies.some((source) => source?.includes(APPLE_ADS_MUTATION_NAME))) return error;
  return new GraphQLError('Apple Ads attribution request could not be processed', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

export function sanitizeAppleAdsLogArgument(argument: unknown): unknown {
  if (argument instanceof GraphQLError) return sanitizeAppleAdsGraphqlError(argument);
  if (Array.isArray(argument)) return argument.map(sanitizeAppleAdsLogArgument);
  return argument;
}

function sanitizeResult(result: ExecutionResult): ExecutionResult {
  if (!result.errors) return result;
  return { ...result, errors: result.errors.map(sanitizeAppleAdsGraphqlError) };
}

/** Covers parse/coercion failures as well as normal execution results. */
export function appleAdsTokenPrivacyPlugin(): Plugin {
  return {
    onResultProcess({ result, setResult }) {
      if (Symbol.asyncIterator in result) return;
      setResult(Array.isArray(result) ? result.map(sanitizeResult) : sanitizeResult(result));
    },
  };
}
