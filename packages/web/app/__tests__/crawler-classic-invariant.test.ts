import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { NextRequest } from 'next/server';
import { middleware } from '@/middleware';
import { EXPO_WEB_ENABLED_COOKIE } from '@/app/lib/expo-web-rollout';

/**
 * Reposition invariant (Phase A0).
 *
 * An anonymous request — one carrying no next-auth session cookie — is NEVER
 * redirected to the `/app` Expo SPA, on any board surface, even under the
 * strongest rollout condition (`BOARDSESH_WEB=1` and the `bs_expo_web` flag
 * cookie on). Anonymous visitors are the crawlable, SEO-bearing audience;
 * Googlebot and logged-out humans must always receive the classic SSR page.
 *
 * The later teardown phases delete the classic *session* UI, but the viewing
 * surfaces (`/view`, `/list`) stay SSR for anonymous visitors. This test locks
 * the guarantee so a future middleware change can't silently start bouncing
 * crawlers into the noindex SPA.
 */

const BOARD_SURFACES = [
  '/kilter/original/12x12-square/screw_bolt/40/list', // legacy list
  '/b/kilter-original-12x12/40/list', // slug list
  // The numeric view is the one shape that *does* map for a logged-in flagged
  // user — precisely why the anonymous case matters most here.
  '/kilter/1/10/1,20/40/view/abcdef1234567890abcdef1234567890',
  '/b/kilter-original-12x12/40/view/test-climb-abcdef1234567890abcdef1234567890', // slug view
  '/kilter/original/12x12-square/screw_bolt/40/view/test-climb-abcdef1234567890abcdef1234567890', // named view
];

const originalExpoWebFlag = process.env.BOARDSESH_WEB;

function makeRequest(pathname: string): NextRequest {
  return new NextRequest(new URL(pathname, 'http://localhost:3000'));
}

function redirectedToAppPath(response: ReturnType<typeof middleware>): string | null {
  const location = response.headers.get('location');
  if (response.status !== 307 || location === null) return null;
  return new URL(location).pathname.startsWith('/app') ? location : null;
}

describe('crawler-classic invariant: anonymous requests never redirect to /app', () => {
  beforeEach(() => {
    // Rollout fully enabled: the strongest condition under which the invariant
    // must still hold for anonymous visitors.
    process.env.BOARDSESH_WEB = '1';
  });

  afterEach(() => {
    if (originalExpoWebFlag === undefined) delete process.env.BOARDSESH_WEB;
    else process.env.BOARDSESH_WEB = originalExpoWebFlag;
  });

  for (const surface of BOARD_SURFACES) {
    it(`does not redirect an anonymous visitor from ${surface} (flag cookie on, no session)`, () => {
      const request = makeRequest(surface);
      // Flag cookie present, but no auth session cookie — the visitor is not logged in.
      request.cookies.set(EXPO_WEB_ENABLED_COOKIE, '1');
      expect(redirectedToAppPath(middleware(request))).toBeNull();
    });

    it(`does not redirect an anonymous visitor from ${surface} (no cookies at all)`, () => {
      expect(redirectedToAppPath(middleware(makeRequest(surface)))).toBeNull();
    });
  }
});
