import type { NextRequest } from 'next/server';
import { getPublicBackendHttpUrl } from '@/app/lib/backend-url';
import type { OgFamilySurface } from './og-family';

/**
 * The redirect is a pure function of its query string, so a CDN may hold it.
 * Kept short anyway: the backend origin is the one input it does not see.
 */
const REDIRECT_CACHE_CONTROL = 'public, max-age=300, s-maxage=3600';

/**
 * Answer a legacy `/api/og/{playlist,profile,setter,session}` URL with a 307 to
 * the backend card that replaced it, the way `/api/og/climb` already does.
 *
 * Pages stopped advertising these URLs when the cards moved to the backend, but
 * every link shared before then still carries one in a chat app's cache. The
 * id and the version token are carried across unchanged; the backend runs its
 * own gate, so a card that has gone private since answers its 404 there. Only
 * the named parameters are forwarded: anything else on the old URL is dropped.
 */
export function redirectToOgFamilyCard(
  request: NextRequest,
  surface: OgFamilySurface,
  idParam: string,
  forwardedParams: readonly string[] = [],
): Response {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get(idParam);
  if (!id) {
    return new Response(`Missing ${idParam} parameter`, { status: 400 });
  }

  const origin = getPublicBackendHttpUrl();
  if (!origin) {
    return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const target = new URLSearchParams({ [idParam]: id });
  for (const name of [...forwardedParams, 'v']) {
    const value = searchParams.get(name);
    if (value) target.set(name, value);
  }

  return new Response(null, {
    status: 307,
    headers: {
      Location: `${origin}/og/${surface}?${target}`,
      'Cache-Control': REDIRECT_CACHE_CONTROL,
      'CDN-Cache-Control': REDIRECT_CACHE_CONTROL,
    },
  });
}
