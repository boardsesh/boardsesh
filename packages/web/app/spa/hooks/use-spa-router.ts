'use client';

import { useCallback, useEffect, useState } from 'react';

export type SpaRoute =
  | { screen: 'list'; boardSlug: string; angle: number }
  | { screen: 'view'; boardSlug: string; angle: number; climbUuid: string }
  | { screen: 'not-found' };

const SPA_BASE_PATH = '/spa';

function parseSpaPath(pathname: string): SpaRoute {
  if (!pathname.startsWith(SPA_BASE_PATH)) return { screen: 'not-found' };
  const segments = pathname
    .slice(SPA_BASE_PATH.length)
    .split('/')
    .filter((segment) => segment.length > 0);

  const [entityKind, boardSlug, angleRaw, screenSegment, climbUuid] = segments;
  if (entityKind !== 'b' || !boardSlug || !angleRaw) return { screen: 'not-found' };
  const angle = Number(angleRaw);
  if (!Number.isFinite(angle)) return { screen: 'not-found' };

  if (screenSegment === 'list' && segments.length === 4) {
    return { screen: 'list', boardSlug, angle };
  }
  if (screenSegment === 'view' && climbUuid && segments.length === 5) {
    return { screen: 'view', boardSlug, angle, climbUuid };
  }
  return { screen: 'not-found' };
}

// Placeholder used for both the SSR pass and the client's first render (before
// hydration completes), so the two match exactly — reading `window` during
// render instead would report the real route on the client's first render
// (window already exists there) while the server always renders this
// placeholder, producing a hydration mismatch. The real location + support
// flag are read inside a mount effect below instead, one render later.
const INITIAL_LOCATION: { route: SpaRoute; searchParams: URLSearchParams } = {
  route: { screen: 'not-found' },
  searchParams: new URLSearchParams(),
};

export type SpaRouterState = {
  /** False on browsers without `window.navigation` (Firefox, Safari) — the SPA shell renders a fallback instead. */
  isNavigationApiSupported: boolean;
  route: SpaRoute;
  searchParams: URLSearchParams;
  navigate: (path: string, options?: { replace?: boolean }) => void;
};

/**
 * Pure client-side router built on the Navigation API (`window.navigation`),
 * not Next's router — Next never re-renders this route past the initial
 * document load. Internal links are plain `<a href>`s; clicking one fires a
 * `navigate` event here, which we intercept to update local state instead of
 * letting the browser load a new document.
 */
export function useSpaRouter(): SpaRouterState {
  const [isNavigationApiSupported, setIsNavigationApiSupported] = useState(false);
  const [{ route, searchParams }, setLocationState] = useState(INITIAL_LOCATION);

  // Reads `window` for the first time only after mount (client-only), so the
  // SSR/first-client-render pass always matches INITIAL_LOCATION above.
  useEffect(() => {
    setIsNavigationApiSupported('navigation' in window);
    setLocationState({
      route: parseSpaPath(window.location.pathname),
      searchParams: new URLSearchParams(window.location.search),
    });
  }, []);

  useEffect(() => {
    if (!isNavigationApiSupported) return;
    const nav = window.navigation;

    const handleNavigate = (event: NavigateEvent) => {
      if (!event.canIntercept || event.hashChange || event.downloadRequest !== null) return;
      const url = new URL(event.destination.url);
      // Anything outside /spa (e.g. a link back to the main app) is left to
      // fall through to a normal, full document navigation.
      if (!url.pathname.startsWith(SPA_BASE_PATH)) return;

      event.intercept({
        handler() {
          setLocationState({ route: parseSpaPath(url.pathname), searchParams: new URLSearchParams(url.search) });
          return Promise.resolve();
        },
      });
    };

    nav.addEventListener('navigate', handleNavigate);
    return () => nav.removeEventListener('navigate', handleNavigate);
  }, [isNavigationApiSupported]);

  const navigate = useCallback(
    (path: string, options?: { replace?: boolean }) => {
      if (!isNavigationApiSupported) return;
      window.navigation.navigate(path, { history: options?.replace ? 'replace' : 'push' });
    },
    [isNavigationApiSupported],
  );

  return { isNavigationApiSupported, route, searchParams, navigate };
}
