/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import {
  FIXTURE_PATHS,
  WWW_CHECKS,
  finalVerdict,
  originFailure,
  parseBaseUrl,
  type SmokeResponse,
} from './production-smoke';

// The assertions are the whole product here: the runner is a retry loop, but
// the check table is what decides whether a broken deploy is caught. These
// tests exist so a check can't be silently weakened into a tautology — every
// one of them must reject at least one realistic failure, not just accept a
// healthy response.

function response(overrides: Partial<SmokeResponse> = {}): SmokeResponse {
  return {
    status: 200,
    contentType: 'text/html; charset=utf-8',
    body: '<h1>Boardsesh</h1>',
    headers: {},
    url: 'https://www.boardsesh.com/',
    ...overrides,
  };
}

/**
 * Ambiguity is a failure, not a first-match. "sitemap" matches both the sitemap
 * check and the robots check that points at it, and silently resolving to the
 * wrong one means these assertions would pass while testing nothing.
 */
function checkNamed(fragment: string) {
  const matches = WWW_CHECKS.filter((check) => check.name.includes(fragment));
  if (matches.length === 0) throw new Error(`no check matching "${fragment}"`);
  if (matches.length > 1) {
    throw new Error(`"${fragment}" is ambiguous: ${matches.map((check) => check.name).join(' | ')}`);
  }
  return matches[0];
}

describe('www production smoke checks', () => {
  it('covers the surfaces other systems depend on', () => {
    const paths = WWW_CHECKS.filter((check) => !check.fixtureEnvVar).map((check) => check.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/',
        '/robots.txt',
        '/sitemap.xml',
        '/sitemaps/climbs/1.xml',
        // Both `expectsUrls` shard routes get a check of their own. `boards.xml`
        // in particular is the only hard signal left on the boards surface once
        // the index check can excuse a declared degradation.
        '/sitemaps/static.xml',
        '/sitemaps/boards.xml',
        '/api/auth/session',
        '/api/internal/ws-auth',
      ]),
    );
  });

  it('keeps the warning channel on the index alone', () => {
    // `degradation` is the only thing in this file that can end a run green on a
    // response that is not fully healthy. It is safe exactly where the server
    // declares the degradation on the response, and nowhere else — a check that
    // grew one by copy-paste would be silently unable to go red.
    const withDegradation = WWW_CHECKS.filter((check) => check.degradation).map((check) => check.path);
    expect(withDegradation).toEqual(['/sitemap.xml']);
  });

  it('rejects a homepage that 200s with a spinner-only shell', () => {
    const check = checkNamed('homepage');
    expect(check.assert(response())).toBeNull();
    // The exact regression this catches: real status, real content type, no SSR.
    expect(check.assert(response({ body: '<div id="root"></div>' }))).toMatch(/<h1>/);
    expect(check.assert(response({ status: 500 }))).toMatch(/500/);

    // Attributes are the normal case, not the exception — MUI serves
    // `<h1 class="MuiTypography-root …">`, so matching a bare `<h1>` would
    // miss the very element this check exists to find.
    expect(check.assert(response({ body: '<h1 class="MuiTypography-root">Boardsesh</h1>' }))).toBeNull();
    // ...but the prefix must still not swallow a longer tag name.
    expect(check.assert(response({ body: '<h10>not a heading</h10>' }))).toMatch(/<h1>/);
  });

  it('rejects a robots.txt with no sitemap directive', () => {
    const check = checkNamed('robots.txt serves');
    const healthy = response({ contentType: 'text/plain', body: 'User-agent: *\nSitemap: https://x/sitemap.xml\n' });
    expect(check.assert(healthy)).toBeNull();
    expect(check.assert(response({ contentType: 'text/plain', body: 'User-agent: *\n' }))).toMatch(/Sitemap/);
  });

  it('rejects a sitemap.xml that is not an index pointing at shards', () => {
    const check = checkNamed('sitemap index');
    const healthyIndex =
      '<sitemapindex>' +
      '<sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap>' +
      '<sitemap><loc>https://www.boardsesh.com/sitemaps/boards.xml</loc></sitemap>' +
      '<sitemap><loc>https://www.boardsesh.com/sitemaps/playlists.xml</loc></sitemap>' +
      '</sitemapindex>';
    expect(check.assert(response({ contentType: 'application/xml', body: healthyIndex }))).toBeNull();

    // #4524: `playlists` was excluded from the required list as "legitimately
    // empty". It is not — production serves 2,688 public playlists holding a
    // climb — so an index that quietly drops it is 10,752 URLs gone and now goes
    // red exactly like boards does.
    const withoutPlaylists =
      '<sitemapindex>' +
      '<sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap>' +
      '<sitemap><loc>https://www.boardsesh.com/sitemaps/boards.xml</loc></sitemap>' +
      '</sitemapindex>';
    expect(check.assert(response({ contentType: 'application/xml', body: withoutPlaylists }))).toMatch(/playlists/);

    // The regression this check has to keep catching after #4476. The index now
    // degrades rather than 503ing, so a cold-start failure of the boards builder
    // ships a 200 that quietly lost ~2,600 URLs. `static` is hardcoded and cannot
    // fail, so an "any one shard <loc>" assertion would be green on every
    // possible outage — the detector that found the bug would never fire again.
    //
    // Silent is the operative word: with no `X-Sitemap-Degraded` header there is
    // nothing to say the omission was deliberate, so it stays a hard failure.
    const degradedIndex =
      '<sitemapindex><sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap></sitemapindex>';
    expect(check.assert(response({ contentType: 'application/xml', body: degradedIndex }))).toMatch(/boards/);

    // A regression to the old flat urlset — the shape this replaced.
    expect(
      check.assert(
        response({ contentType: 'application/xml', body: '<urlset><url><loc>https://x/</loc></url></urlset>' }),
      ),
    ).toMatch(/sitemapindex/);

    // An index that resolved zero shards is worse than a 5xx: it tells Google
    // every URL we ever submitted is gone.
    expect(check.assert(response({ contentType: 'application/xml', body: '<sitemapindex></sitemapindex>' }))).toMatch(
      /shard/,
    );
  });

  it('warns instead of failing when the index declares which shard it dropped', () => {
    // #4519: `/sitemap.xml` is force-dynamic, so the first request after a deploy
    // rebuilds every shard live and the boards builder can miss the index's 3s
    // deadline. The handler publishes without it under a 60s window and names it
    // in `X-Sitemap-Degraded` — a self-healing state, not a broken deploy. The
    // smoke ran in exactly that window and went red on every single deploy.
    const check = checkNamed('sitemap index');
    const withoutBoards = response({
      contentType: 'application/xml',
      body: '<sitemapindex><sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap></sitemapindex>',
      headers: { 'x-sitemap-degraded': 'boards,playlists' },
    });
    expect(check.assert(withoutBoards)).toBeNull();
    // Names the shards, so the annotation is actionable without opening the site.
    expect(check.degradation?.(withoutBoards)).toMatch(/boards/);
    expect(check.degradation?.(withoutBoards)).toMatch(/playlists/);
    expect(check.degradation?.(withoutBoards)).toMatch(/required boards/);

    // A shard the header does NOT name is still missing silently — the header
    // must not become a blanket amnesty for anything absent from the body.
    const wrongShardDeclared = response({
      contentType: 'application/xml',
      body: '<sitemapindex><sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap></sitemapindex>',
      headers: { 'x-sitemap-degraded': 'playlists' },
    });
    expect(check.assert(wrongShardDeclared)).toMatch(/boards/);

    // A required-but-degradable shard the header names is a warning, and the
    // annotation says which of the dropped shards was a required one — that is
    // what separates "a required shard missed the deadline again" from "an
    // optional shard was quiet".
    const declaredDegradable = response({
      contentType: 'application/xml',
      body:
        '<sitemapindex>' +
        '<sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap>' +
        '<sitemap><loc>https://www.boardsesh.com/sitemaps/boards.xml</loc></sitemap>' +
        '</sitemapindex>',
      headers: { 'x-sitemap-degraded': 'playlists' },
    });
    expect(check.assert(declaredDegradable)).toBeNull();
    expect(check.degradation?.(declaredDegradable)).toMatch(/playlists/);
    expect(check.degradation?.(declaredDegradable)).toMatch(/required playlists/);

    // A shard this list does not require at all is worth a warning but is not a
    // missing mandatory, so nothing is flagged as required.
    const optionalOnly = response({
      contentType: 'application/xml',
      body:
        '<sitemapindex>' +
        '<sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap>' +
        '<sitemap><loc>https://www.boardsesh.com/sitemaps/boards.xml</loc></sitemap>' +
        '<sitemap><loc>https://www.boardsesh.com/sitemaps/playlists.xml</loc></sitemap>' +
        '</sitemapindex>',
      headers: { 'x-sitemap-degraded': 'gyms' },
    });
    expect(check.assert(optionalOnly)).toBeNull();
    expect(check.degradation?.(optionalOnly)).toMatch(/gyms/);
    expect(check.degradation?.(optionalOnly)).not.toMatch(/required/);

    // The header can never rescue a genuinely broken index: a non-200, a body
    // that is not a `<sitemapindex>`, or one that resolved nothing at all.
    const degradedHeader = { 'x-sitemap-degraded': 'boards,playlists' };
    expect(
      check.assert(response({ status: 503, contentType: 'application/xml', body: '', headers: degradedHeader })),
    ).toMatch(/503/);
    expect(
      check.assert(
        response({
          contentType: 'application/xml',
          body: '<urlset><url><loc>https://x/</loc></url></urlset>',
          headers: degradedHeader,
        }),
      ),
    ).toMatch(/sitemapindex/);
    // The one that would otherwise slip through: an index that resolved NOTHING,
    // with a header naming every shard, is structurally a `<sitemapindex>` and has
    // an excuse for everything in it. `static` is deliberately not excusable so
    // this stays red — `buildStaticEntries` is hardcoded and pure, so its absence
    // is never a transient degradation.
    expect(
      check.assert(
        response({ contentType: 'application/xml', body: '<sitemapindex></sitemapindex>', headers: degradedHeader }),
      ),
    ).toMatch(/static/);

    // A healthy index carries no header and must not warn.
    const healthy = response({
      contentType: 'application/xml',
      body:
        '<sitemapindex>' +
        '<sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap>' +
        '<sitemap><loc>https://www.boardsesh.com/sitemaps/boards.xml</loc></sitemap>' +
        '<sitemap><loc>https://www.boardsesh.com/sitemaps/playlists.xml</loc></sitemap>' +
        '</sitemapindex>',
    });
    expect(check.degradation?.(healthy) ?? null).toBeNull();
  });

  it('fails if production exposes any climb sitemap publication signal', () => {
    const check = checkNamed('sitemap index');
    const pausedIndex =
      '<sitemapindex>' +
      '<sitemap><loc>https://www.boardsesh.com/sitemaps/static.xml</loc></sitemap>' +
      '<sitemap><loc>https://www.boardsesh.com/sitemaps/boards.xml</loc></sitemap>' +
      '<sitemap><loc>https://www.boardsesh.com/sitemaps/playlists.xml</loc></sitemap>' +
      '</sitemapindex>';
    expect(
      check.assert(
        response({
          contentType: 'application/xml',
          body: pausedIndex.replace(
            '</sitemapindex>',
            '<sitemap><loc>https://www.boardsesh.com/sitemaps/climbs/1.xml</loc></sitemap></sitemapindex>',
          ),
        }),
      ),
    ).toMatch(/still publishes/);
    expect(
      check.assert(
        response({
          contentType: 'application/xml',
          body: pausedIndex,
          headers: { 'x-sitemap-climbs-source': 'store' },
        }),
      ),
    ).toMatch(/source/);
    expect(
      check.assert(
        response({
          contentType: 'application/xml',
          body: pausedIndex,
          headers: { 'x-sitemap-degraded': 'climbs' },
        }),
      ),
    ).toMatch(/intentional/);
  });

  it('requires a cacheable 410 from the paused climb shard at either origin', () => {
    // The check used to string-compare the whole header against Vercel's
    // downstream form. The route emits `public, s-maxage=3600, must-revalidate`;
    // only Vercel strips `s-maxage`, so pointing this smoke at the Railway origin
    // failed a check on a header that was exactly right. Directives, not strings.
    const check = checkNamed('paused climb sitemap shard');
    const healthy = response({
      status: 410,
      contentType: 'text/plain; charset=utf-8',
      body: 'climbs sitemaps are disabled',
      headers: { 'cache-control': 'public, must-revalidate' },
    });
    expect(check.assert(healthy)).toBeNull();
    // What the route actually emits, and what a non-Vercel origin serves.
    expect(
      check.assert({ ...healthy, headers: { 'cache-control': 'public, s-maxage=3600, must-revalidate' } }),
    ).toBeNull();
    // Whitespace and casing are the header's business, not the contract's.
    expect(check.assert({ ...healthy, headers: { 'cache-control': 'Public,  Must-Revalidate' } })).toBeNull();

    expect(check.assert({ ...healthy, status: 200 })).toMatch(/410/);
    expect(check.assert({ ...healthy, headers: { 'cache-control': 'no-store' } })).toMatch(/cache-control/);
    // Tolerating `s-maxage` must not turn into tolerating anything: a bare
    // `public` is a shard that stops revalidating, cached at every hop.
    expect(check.assert({ ...healthy, headers: { 'cache-control': 'public' } })).toMatch(/must-revalidate/);
    expect(check.assert({ ...healthy, headers: {} })).toMatch(/cache-control/);
    // A directive nobody asked for is a real change to the pause, not plumbing.
    expect(check.assert({ ...healthy, headers: { 'cache-control': 'public, must-revalidate, private' } })).toMatch(
      /private/,
    );
  });

  it('rejects an empty static sitemap shard', () => {
    const check = checkNamed('static sitemap shard');
    expect(
      check.assert(response({ contentType: 'application/xml', body: '<urlset><url><loc>x</loc></url></urlset>' })),
    ).toBeNull();
    expect(check.assert(response({ contentType: 'application/xml', body: '<urlset></urlset>' }))).toMatch(/loc/);
  });

  it('keeps a hard signal on the boards shard, which the index check can no longer give', () => {
    // Every way boards drops out of the index puts its id in `degradedShards`, so
    // the index check now WARNs on all of them. Without this check the suite could
    // never go red on boards again while `/sitemaps/boards.xml` 503s — and the
    // `hasMore` truncation throw is a permanent, not transient, way to get there
    // once the catalogue passes the 100-config API cap.
    const check = checkNamed('boards sitemap shard');
    expect(
      check.assert(response({ contentType: 'application/xml', body: '<urlset><url><loc>x</loc></url></urlset>' })),
    ).toBeNull();
    // The shard route's own failure mode: fail-closed 503, no body worth parsing.
    expect(check.assert(response({ status: 503, contentType: 'text/plain', body: 'unavailable' }))).toMatch(/503/);
    expect(check.assert(response({ contentType: 'application/xml', body: '<urlset></urlset>' }))).toMatch(/loc/);
    // No degradation channel: a shard route is fail-closed and declares nothing,
    // so a header on this response must not buy it a green.
    expect(
      check.degradation?.(
        response({ status: 503, contentType: 'text/plain', body: '', headers: { 'x-sitemap-degraded': 'boards' } }),
      ) ?? null,
    ).toBeNull();
  });

  it('rejects a session endpoint that 200s with an error payload', () => {
    const check = checkNamed('auth session');
    expect(check.assert(response({ contentType: 'application/json', body: '{}' }))).toBeNull();
    // NextAuth answers 200 for an anonymous session, so status alone proves
    // nothing here — the body is the only place a failure shows up.
    expect(check.assert(response({ contentType: 'application/json', body: '{"error":"db down"}' }))).toMatch(/db down/);
    expect(check.assert(response({ contentType: 'application/json', body: '<html>502</html>' }))).toMatch(
      /not valid JSON/,
    );
  });

  it('rejects a ws-auth response that is not the anonymous payload shape', () => {
    const check = checkNamed('ws-auth');
    const healthy = response({
      contentType: 'application/json',
      body: JSON.stringify({ token: null, authenticated: false }),
    });
    expect(check.assert(healthy)).toBeNull();
    // A 200 that returns an error page instead of JSON — the shape a proxy
    // misconfiguration produces, and the one a status-only check would miss.
    expect(check.assert(response({ contentType: 'application/json', body: 'Internal Server Error' }))).toMatch(
      /not valid JSON/,
    );
    expect(check.assert(response({ contentType: 'application/json', body: '{"ok":true}' }))).toMatch(/authenticated/);
    expect(check.assert(response({ status: 401, contentType: 'application/json', body: '{}' }))).toMatch(/401/);
  });

  it('rejects an error shell on the kiosk and embed pages', () => {
    // A Next error page is a well-formed 200 text/html document, so status and
    // content-type alone accept it. The kiosk is an unattended gym screen that
    // reloads daily — a regression there sits broken for up to 24h unwatched.
    for (const name of ['kiosk page', 'board embed']) {
      const check = checkNamed(name);
      expect(
        check.assert(response({ body: '<html><body>x</body></html>' })),
        `${name} accepted an error shell`,
      ).toMatch(/error shell/);
      expect(check.assert(response({ body: `<html>${'x'.repeat(5000)}</html>` }))).toBeNull();
    }
  });

  it('skips fixture-backed checks rather than failing when the fixture is unset', () => {
    // Fail-closed on missing config is how #3977 stopped production deploys for
    // two days. Every fixture-backed check must declare its env var and have a
    // path builder, so an unset var is a skip and never a red deploy.
    const fixtureChecks = WWW_CHECKS.filter((check) => check.fixtureEnvVar);
    expect(fixtureChecks.length).toBeGreaterThan(0);
    for (const check of fixtureChecks) {
      expect(FIXTURE_PATHS[check.fixtureEnvVar as string], `${check.name} has no path builder`).toBeDefined();
    }
  });

  it('builds fixture paths from the configured value', () => {
    expect(FIXTURE_PATHS.SMOKE_KIOSK_GYM_SLUG('movement-lu')).toBe('/kiosk/movement-lu');
    expect(FIXTURE_PATHS.SMOKE_EMBED_BOARD_UUID('abc-123')).toBe('/embed/board/abc-123');
  });
});

describe('finalVerdict', () => {
  it('warns only when every attempt was a clean, self-declared degradation', () => {
    expect(finalVerdict(['degraded'])).toBe('warn');
    expect(finalVerdict(['degraded', 'degraded', 'degraded'])).toBe('warn');
  });

  it('fails a run that flapped, even when it recovered into a degradation', () => {
    // The trap a "last attempt wins" rule falls into: two 503s and a degraded
    // third is a real outage that happened to recover, and reporting it green
    // hides the outage behind its own recovery.
    expect(finalVerdict(['fail', 'fail', 'degraded'])).toBe('fail');
    expect(finalVerdict(['degraded', 'fail', 'degraded'])).toBe('fail');
    expect(finalVerdict(['degraded', 'degraded', 'fail'])).toBe('fail');
    expect(finalVerdict(['fail'])).toBe('fail');
  });

  it('never warns on an empty run', () => {
    // Unreachable today (ATTEMPTS is 3), but "no evidence" must not read as
    // "warning" if the loop ever changes shape.
    expect(finalVerdict([])).toBe('fail');
  });
});

describe('originFailure', () => {
  it('passes a response that came back from the base origin', () => {
    expect(
      originFailure(response({ url: 'https://www.boardsesh.com/robots.txt' }), 'https://www.boardsesh.com'),
    ).toBeNull();
    // A same-origin redirect (a locale or trailing-slash rewrite) is fine.
    expect(originFailure(response({ url: 'https://www.boardsesh.com/es/' }), 'https://www.boardsesh.com')).toBeNull();
  });

  it('fails a response that left the origin under test', () => {
    // The exact silent pass this exists to stop: smoking the Railway origin
    // while it still redirects to www means every check reports on production.
    const redirectedToWww = response({ url: 'https://www.boardsesh.com/' });
    expect(originFailure(redirectedToWww, 'https://web-production.up.railway.app')).toMatch(/redirected off/);
    expect(originFailure(redirectedToWww, 'https://web-production.up.railway.app')).toMatch(/www\.boardsesh\.com/);
    // Scheme and port are part of the origin.
    expect(originFailure(response({ url: 'http://www.boardsesh.com/' }), 'https://www.boardsesh.com')).toMatch(
      /redirected off/,
    );
  });

  it('fails rather than throws on an unusable final URL', () => {
    expect(originFailure(response({ url: '' }), 'https://www.boardsesh.com')).toMatch(/final URL/);
  });
});

describe('parseBaseUrl', () => {
  it('defaults to production when no --base is given', () => {
    expect(parseBaseUrl([])).toBe('https://www.boardsesh.com');
  });

  it('takes the --base value and strips a trailing slash', () => {
    // The slash matters: paths are concatenated, so `…com/` + `/robots.txt`
    // would request `//robots.txt`.
    expect(parseBaseUrl(['--base', 'https://preview.example.com'])).toBe('https://preview.example.com');
    expect(parseBaseUrl(['--base', 'https://preview.example.com/'])).toBe('https://preview.example.com');
  });

  it('rejects a --base with no value', () => {
    expect(() => parseBaseUrl(['--base'])).toThrow(/needs a URL/);
  });

  it('rejects a malformed --base rather than failing three retries deep', () => {
    expect(() => parseBaseUrl(['--base', 'www.boardsesh.com'])).toThrow(/not a valid URL/);
    expect(() => parseBaseUrl(['--base', 'not a url at all'])).toThrow(/not a valid URL/);
  });
});
