import { describe, expect, it } from 'vitest';
import { firstMatchingRedirect, redirectRules } from './cloudflare-config';

// Guards the SPA fallback in `_redirects` (see ../README.md). Expo Router serves
// every route from one exported shell, so losing this rule — or downgrading its
// `200` rewrite to a redirect — 404s or mangles every deep link on
// app.boardsesh.com.

describe('deploy/app-subdomain/_redirects', () => {
  it('parses at least one rule (sanity check the fixture path is right)', () => {
    expect(redirectRules.length).toBeGreaterThan(0);
  });

  it('serves the SPA shell for deep links', () => {
    // `/auth/callback` carries the transfer token back from the www auth origin;
    // a 301/302 here would drop its query string on some clients.
    for (const deepLink of ['/climbs', '/auth/callback', '/nested/deep/route']) {
      const rule = firstMatchingRedirect(deepLink);
      expect(rule, `"${deepLink}" must fall through to the exported shell`).toBeDefined();
      expect(rule?.to, `"${deepLink}" must resolve to the SPA shell`).toBe('/index.html');
      expect(rule?.status, `"${deepLink}" must be a 200 rewrite, not a redirect — the URL has to stay put`).toBe(200);
    }
  });
});
