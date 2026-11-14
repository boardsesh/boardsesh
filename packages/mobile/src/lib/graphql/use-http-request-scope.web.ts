import { useAuthToken } from './use-auth-token.web';
import { captureHttpRequestScope } from './request-scope.web';

/** Noncredential caller intent, captured before TanStack's first await. */
export function useHttpRequestScope(): string | undefined {
  const { data: label } = useAuthToken();
  return captureHttpRequestScope(label);
}
