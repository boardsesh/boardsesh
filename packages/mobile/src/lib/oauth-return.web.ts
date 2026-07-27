import type { AuthProvider } from './auth';
import { WEB_OAUTH_RETURN_PROVIDER_PARAM } from './oauth-return-marker';

export function consumeWebOAuthReturnProvider(): AuthProvider | null {
  if (typeof window === 'undefined') return null;

  const currentUrl = new URL(window.location.href);
  const candidate = currentUrl.searchParams.get(WEB_OAUTH_RETURN_PROVIDER_PARAM);
  const provider: AuthProvider | null = candidate === 'apple' || candidate === 'google' ? candidate : null;
  if (candidate === null) return null;

  currentUrl.searchParams.delete(WEB_OAUTH_RETURN_PROVIDER_PARAM);
  try {
    window.history.replaceState(window.history.state, '', currentUrl.toString());
  } catch {
    // URL cleanup is cosmetic. The provider marker has still been consumed by
    // this app lifecycle and the durable attempt marker remains one-time.
  }
  return provider;
}
