// Feeds the signed-in profile's email into the device-token ledger (#7656).
//
// Most phones are already signed in when device tokens switch on, so their
// tokens arrive on refresh replies, which carry no email. Without one, the
// password sign-in after a sign-out could not find the token. The profile query
// already returns `{ id, email }` for the signed-in account; this listens to
// that cache entry and records the email on that account's entry. No request
// of its own, and nothing is added for an account without a token.
//
// Native only: device-token-profile-email.web.ts is a no-op, because the browser
// target keeps no device tokens.

import type { QueryClient } from '@tanstack/react-query';
import { rememberDeviceTokenAccountEmail } from './device-token-store';

/** The account a `['profile']` cache value names, or null. */
export function profileAccountFromCache(data: unknown): { userId: string; email: string } | null {
  if (!data || typeof data !== 'object') return null;
  const profile = (data as { profile?: unknown }).profile;
  if (!profile || typeof profile !== 'object') return null;
  const { id, email } = profile as { id?: unknown; email?: unknown };
  if (typeof id !== 'string' || id.length === 0 || typeof email !== 'string' || email.length === 0) return null;
  return { userId: id, email };
}

/** Subscribe for the life of the client. Returns the unsubscribe. */
export function watchProfileEmailForDeviceTokens(queryClient: QueryClient): () => void {
  return queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const { queryKey } = event.query;
    if (queryKey.length !== 1 || queryKey[0] !== 'profile') return;
    const account = profileAccountFromCache(event.query.state.data);
    if (account) void rememberDeviceTokenAccountEmail(account.userId, account.email);
  });
}
