import { GraphQLError, type ExecutionResult } from 'graphql';
import { suppressTracing } from '@sentry/node';
import type { Plugin } from 'graphql-yoga';
import {
  isAdminFeedbackDocument,
  isBoardRequestDocument,
  isPrivateFeedbackDocument,
} from '../lib/private-feedback-diagnostics';

export { isAdminFeedbackDocument, isBoardRequestDocument } from '../lib/private-feedback-diagnostics';

const TOKEN_FIELDS = ['boardShareLinkPreview', 'redeemBoardShareLink'] as const;
const SAFE_ERROR_CODES = new Set([
  'BAD_USER_INPUT',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'INTERNAL_SERVER_ERROR',
  'RATE_LIMITED',
  'PRIVACY_UNAVAILABLE',
  'BOARD_REQUEST_UNAVAILABLE',
  'SERVICE_UNAVAILABLE',
]);

function isBoardShareTokenDocument(document: string): boolean {
  return TOKEN_FIELDS.some((field) => document.includes(field));
}

export function isPrivateBoardDocument(document: string): boolean {
  return isPrivateFeedbackDocument(document) || isBoardShareTokenDocument(document);
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
 * Board requests discard source and paths at every phase. Share-link resolvers
 * already sanitize their own execution errors, so retain their public paths.
 */
export function sanitizePrivateBoardGraphqlError(error: GraphQLError, document?: string): GraphQLError {
  const sourceBodies = [document, error.source?.body, ...(error.nodes ?? []).map((node) => node.loc?.source.body)];
  // A board request may contain private text in literals, variables or an
  // alias. Drop original errors, paths and source nodes even after execution.
  if (sourceBodies.some((source) => source !== undefined && isBoardRequestDocument(source))) {
    return new GraphQLError('Board request could not be processed', { extensions: safeExtensions(error.extensions) });
  }
  if (sourceBodies.some((source) => source !== undefined && isAdminFeedbackDocument(source))) {
    return new GraphQLError('Feedback reports could not be processed', {
      extensions: safeExtensions(error.extensions),
    });
  }
  if (
    error.path !== undefined ||
    !sourceBodies.some((source) => source !== undefined && isBoardShareTokenDocument(source))
  )
    return error;
  return new GraphQLError('Board share link request could not be processed', {
    extensions: safeExtensions(error.extensions),
  });
}

export function sanitizePrivateBoardLogArgument(argument: unknown): unknown {
  if (argument instanceof GraphQLError) return sanitizePrivateBoardGraphqlError(argument);
  if (Array.isArray(argument)) return argument.map(sanitizePrivateBoardLogArgument);
  return argument;
}

export function sanitizePrivateBoardResult(result: ExecutionResult, document?: string): ExecutionResult {
  if (!result.errors) return result;
  return { ...result, errors: result.errors.map((error) => sanitizePrivateBoardGraphqlError(error, document)) };
}

/** HTTP parse/coercion failures also occur before any resolver-level masking. */
export function privateBoardOperationPrivacyPlugin(): Plugin {
  return {
    onParams({ params, paramsHandler, setParamsHandler }) {
      // Yoga runs this handler before GraphQL parse, validation and execution.
      // Suppress the private operation's spans before the SDK can attach its
      // document or use the operation name in the enclosing HTTP transaction.
      if (typeof params.query === 'string' && isPrivateFeedbackDocument(params.query)) {
        setParamsHandler((payload) => suppressTracing(() => paramsHandler(payload)));
      }
    },
    onResultProcess: (payload) => {
      const { result } = payload;
      if (Symbol.asyncIterator in result) return;
      payload.setResult(
        Array.isArray(result)
          ? result.map((entry) => sanitizePrivateBoardResult(entry))
          : sanitizePrivateBoardResult(result),
      );
    },
  };
}
