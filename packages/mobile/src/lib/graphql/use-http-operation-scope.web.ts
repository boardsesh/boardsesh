import { useAuthToken } from './use-auth-token.web';
import { captureHttpRequestScope } from './request-scope.web';
import { hasConfirmedAnonymousWebSession, isRequiredBrowserDispatch } from '../auth-store.web';

/** Optional-view queries may run with actual confirmed anonymity. A missing
 * label or failed central read never supplies that anonymous observation. */
export function useHttpOperationScope(): string | undefined {
  const { data: label } = useAuthToken();
  return label === null && hasConfirmedAnonymousWebSession()
    ? captureHttpRequestScope()
    : captureHttpRequestScope(label);
}

export const isHttpCacheScoped = isRequiredBrowserDispatch;
