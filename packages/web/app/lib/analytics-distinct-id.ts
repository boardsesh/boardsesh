// Module-level store for the current PostHog distinct id. Populated by
// PartyProfileProvider whenever the resolved identity changes. Read by the
// fetch / GraphQL transports so server-side handlers can attribute events to
// the same person PostHog sees on the client.

import { SERVER_DISTINCT_ID_HEADER } from '@boardsesh/shared-schema';

const ATTACHED_FLAG = '__bsDistinctIdFetchPatched';

let activeDistinctId: string | null = null;

export function setActiveDistinctId(id: string | null): void {
  activeDistinctId = id;
}

export function getActiveDistinctId(): string | null {
  return activeDistinctId;
}

// Patch window.fetch so internal /api/* and same-origin GraphQL requests carry the
// active distinct id. Idempotent — safe to call from multiple components on mount.
export function attachDistinctIdFetchInterceptor(): void {
  if (typeof window === 'undefined') return;
  const target = window as typeof window & { [ATTACHED_FLAG]?: boolean };
  if (target[ATTACHED_FLAG]) return;
  target[ATTACHED_FLAG] = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = (input, init) => {
    const distinctId = activeDistinctId;
    if (!distinctId) return originalFetch(input, init);

    let url: string;
    if (typeof input === 'string') {
      url = input;
    } else if (input instanceof URL) {
      url = input.toString();
    } else if (input instanceof Request) {
      url = input.url;
    } else {
      return originalFetch(input, init);
    }

    if (!shouldAttachHeader(url)) return originalFetch(input, init);

    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has(SERVER_DISTINCT_ID_HEADER)) {
      headers.set(SERVER_DISTINCT_ID_HEADER, distinctId);
    }
    return originalFetch(input, { ...init, headers });
  };
}

function shouldAttachHeader(url: string): boolean {
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.origin !== window.location.origin) return false;
    return (
      parsed.pathname.startsWith('/api/') || parsed.pathname === '/graphql' || parsed.pathname.endsWith('/graphql')
    );
  } catch {
    return false;
  }
}
