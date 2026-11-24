import {
  extractGraphqlCode,
  extractGraphqlMessage,
  isGraphqlValidationFailedError,
} from '../graphql/extract-error-message';

/**
 * A backend that cannot preserve climb links rejects the marker during GraphQL
 * input coercion, before a resolver runs. graphql-js can leave that error uncoded
 * or classify it BAD_USER_INPUT, so recognise its static field declaration too.
 * Other validation, lifecycle and rate-limit guidance stays available to callers.
 */
export function normalizeSprayHoldWriteError(error: unknown): unknown {
  const code = extractGraphqlCode(error);
  const unknownMarker =
    (code === null || code === 'BAD_USER_INPUT') &&
    (extractGraphqlMessage(error)?.includes('Field "preserveClimbLinks" is not defined by type ') ?? false);
  if (isGraphqlValidationFailedError(error) || unknownMarker) {
    // A plain Error makes save/publish screens use their localized fallback;
    // retain the original cause for diagnostic reporting.
    return new Error('Spray hold refinement support is unavailable', { cause: error });
  }
  return error;
}
