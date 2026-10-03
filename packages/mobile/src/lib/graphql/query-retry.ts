import { isBackendUnavailableError } from '../connectivity/backend-unavailable-error';
import { isGraphqlRateLimitedError, isGraphqlValidationFailedError } from './extract-error-message';
import { isGraphqlRequestTimeoutError } from './request-timeout';

/** Default query policy, shared by discovery's narrowly scoped retry override. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isGraphqlValidationFailedError(error)) return false;
  if (isGraphqlRateLimitedError(error)) return false;
  if (isBackendUnavailableError(error)) return false;
  if (isGraphqlRequestTimeoutError(error)) return false;
  return failureCount < 2;
}
