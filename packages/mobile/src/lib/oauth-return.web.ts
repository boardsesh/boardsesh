import type { AuthProvider } from './auth';
import type { WebOAuthReturn } from './oauth-return';
import {
  WEB_OAUTH_RETURN_ATTEMPT_PARAM,
  WEB_OAUTH_RETURN_ERROR_PARAM,
  WEB_OAUTH_RETURN_PROVIDER_PARAM,
  WEB_OAUTH_ATTEMPT_ID_PATTERN,
} from './oauth-return-marker';

export function consumeWebOAuthReturn(): WebOAuthReturn | null {
  if (typeof window === 'undefined') return null;

  const currentUrl = new URL(window.location.href);
  const providerCandidate = currentUrl.searchParams.get(WEB_OAUTH_RETURN_PROVIDER_PARAM);
  const attemptId = currentUrl.searchParams.get(WEB_OAUTH_RETURN_ATTEMPT_PARAM);
  const error = currentUrl.searchParams.get(WEB_OAUTH_RETURN_ERROR_PARAM);
  const provider: AuthProvider | null =
    providerCandidate === 'apple' || providerCandidate === 'google' ? providerCandidate : null;
  if (providerCandidate === null && attemptId === null && error === null) return null;

  currentUrl.searchParams.delete(WEB_OAUTH_RETURN_PROVIDER_PARAM);
  currentUrl.searchParams.delete(WEB_OAUTH_RETURN_ATTEMPT_PARAM);
  currentUrl.searchParams.delete(WEB_OAUTH_RETURN_ERROR_PARAM);
  try {
    window.history.replaceState(window.history.state, '', currentUrl.toString());
  } catch {
    // URL cleanup is cosmetic. The provider marker has still been consumed by
    // this app lifecycle and the durable attempt marker remains one-time.
  }
  if (!provider || !attemptId || !WEB_OAUTH_ATTEMPT_ID_PATTERN.test(attemptId)) return null;
  return { provider, attemptId, error };
}

export function consumeWebOAuthErrorReturn(): WebOAuthReturn | null {
  if (typeof window === 'undefined') return null;
  const currentUrl = new URL(window.location.href);
  if (!currentUrl.searchParams.has(WEB_OAUTH_RETURN_ERROR_PARAM)) return null;
  return consumeWebOAuthReturn();
}
