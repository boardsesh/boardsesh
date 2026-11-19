// Browser target's fork of device-token-profile-email.ts: the browser keeps no
// device tokens (www's HttpOnly cookie does that job), so there is nothing to feed.

import type { QueryClient } from '@tanstack/react-query';

export function watchProfileEmailForDeviceTokens(_queryClient: QueryClient): () => void {
  return () => {};
}
