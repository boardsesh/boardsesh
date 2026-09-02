/// <reference types="node" />

import { describe, expect, it } from 'vitest';
import {
  FIXTURE_PATHS,
  WWW_CHECKS,
  finalVerdict,
  originFailure,
  parseBaseUrl,
  shouldStopSmokeSuite,
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

const SHARD_LOCS = {
  static: 'https://www.boardsesh.com/sitemaps/static.xml',
  boards: 'https://www.boardsesh.com/sitemaps/boards.xml',
  playlists: 'https://www.boardsesh.com/sitemaps/playlists.xml',
  climbs: 'https://www.boardsesh.com/sitemaps/climbs/1.xml',
} as const;

/** A `<sitemapindex>` listing exactly the shards named, in order. */
function indexBody(...shards: (keyof typeof SHARD_LOCS)[]): string {
  const entries = shards.map((shard) => `<sitemap><loc>${SHARD_LOCS[shard]}</loc></sitemap>`).join('');
  return `<sitemapindex>${entries}</sitemapindex>`;
}

/**
 * A climbs `<loc>` on its own does not prove the paged shard ran — the source
 * header is what says which path answered — so every fixture that lists climbs
 * as healthy carries it too.
 */
const CLIMBS_FROM_STORE = { 'x-sitemap-climbs-source': 'store' };

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

  it('keeps the warning channel on the index and the climb shard, and nowhere else', () => {
    // `degradation` is the only thing in this file that can end a run green on a
    // response that is not fully healthy. It is safe exactly where the server
    // declares the degradation on the response, and nowhere else — a check that
    // grew one by copy-paste would be silently unable to go red.
    //
    // Two checks qualify. The index declares dropped shards in
    // `X-Sitemap-Degraded`; the climbs shard declares which path built it in
    // `X-Sitemap-Climbs-Source`, where `live` is a correct answer that costs a
    // full rebuild per request. Both are the server saying so on the response.
    const withDegradation = WWW_CHECKS.filter((check) => check.degradation).map((check) => check.path);
    expect(withDegradation).toEqual(['/sitemap.xml', '/sitemaps/climbs/1.xml']);
  });

  it('buys the climb shard a request budget longer than its 51 s fallback', () => {
    // The WARN above is only reachable if the request survives long enough to
    // read the header. `pagedShardRouteHandler` puts no deadline on
    // `buildPage()`, and the empty-store fallback it describes is a 51 s rebuild
    // (#4552), so on the suite's shared 30 s budget the documented degradation
    // would abort and report as three hard failures instead — which, once
    // `WEB_DEPLOY_TARGETS` drops `vercel`, is grounds for an automatic rollback.
    const check = checkNamed('climb sitemap shard');
    expect(check.timeoutMs ?? 0).toBeGreaterThan(51_000);
    // Every other check keeps the shared budget: a longer one belongs only where
    // a slow answer is a state the check reports on, not a symptom.
    expect(
      WWW_CHECKS.filter((candidate) => candidate.timeoutMs !== undefined).map((candidate) => candidate.path),
    ).toEqual(['/sitemaps/climbs/1.xml']);
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

  it('binds a Railway smoke to the immutable release it just deployed', () => {
    const check = checkNamed('deployment identity');
    const expectedRelease = '0123456789abcdef0123456789abcdef01234567';
    const healthy = response({
      contentType: 'application/json',
      body: JSON.stringify({ status: 'ok', release: expectedRelease, deploymentId: 'deployment-123' }),
    });

    const expectedIdentity = {
      SMOKE_EXPECTED_DEPLOYMENT_ID: 'deployment-123',
      SMOKE_EXPECTED_RELEASE: expectedRelease,
    };
    expect(check.assert(healthy, expectedIdentity)).toBeNull();
    expect(
      check.assert(healthy, {
        ...expectedIdentity,
        SMOKE_EXPECTED_RELEASE: 'fedcba9876543210fedcba9876543210fedcba98',
      }),
    ).toMatch(/expected release/);
    expect(check.assert(healthy, { ...expectedIdentity, SMOKE_EXPECTED_DEPLOYMENT_ID: 'deployment-456' })).toMatch(
      /expected deployment/,
    );
    expect(check.assert(healthy, { SMOKE_EXPECTED_DEPLOYMENT_ID: 'deployment-123' })).toMatch(/SMOKE_EXPECTED_RELEASE/);
    expect(
      check.assert(healthy, {
        SMOKE_EXPECTED_DEPLOYMENT_ID: 'deployment-123',
        SMOKE_EXPECTED_RELEASE: 'not-a-full-lowercase-sha',
      }),
    ).toMatch(/40-character lowercase Git SHA/);
    expect(
      check.assert(response({ contentType: 'application/json', body: '{"status":"ok"}' }), {
        ...expectedIdentity,
      }),
    ).toMatch(/missing/);
    expect(
      check.assert(response({ status: 503, contentType: 'application/json' }), {
        ...expectedIdentity,
      }),
    ).toMatch(/503/);
  });

  it('checks deployment identity before slower functional surfaces', () => {
    expect(WWW_CHECKS[0].name).toContain('deployment identity');
    expect(WWW_CHECKS[0].stopSuiteOnFailure).toBe(true);
    expect(
      shouldStopSmokeSuite(WWW_CHECKS[0], { name: WWW_CHECKS[0].name, state: 'fail', detail: 'wrong deployment' }),
    ).toBe(true);
    expect(
      shouldStopSmokeSuite(WWW_CHECKS[0], { name: WWW_CHECKS[0].name, state: 'pass', detail: '/api/health' }),
    ).toBe(false);
    expect(shouldStopSmokeSuite(WWW_CHECKS[1], { name: WWW_CHECKS[1].name, state: 'fail', detail: 'homepage' })).toBe(
      false,
    );
  });

  it('rejects a robots.txt with no sitemap directive', () => {
    const check = checkNamed('robots.txt serves');
    const healthy = response({ contentType: 'text/plain', body: 'User-agent: *\nSitemap: https://x/sitemap.xml\n' });
    expect(check.assert(healthy)).toBeNull();
    expect(check.assert(response({ contentType: 'text/plain', body: 'User-agent: *\n' }))).toMatch(/Sitemap/);
  });

  it('rejects a sitemap.xml that is not an index pointing at shards', () => {
    const check = checkNamed('sitemap index');
    const healthyIndex = indexBody('static', 'boards', 'playlists', 'climbs');
    expect(
      check.assert(response({ contentType: 'application/xml', body: healthyIndex, headers: CLIMBS_FROM_STORE })),
    ).toBeNull();

    // #4524: `playlists` was excluded from the required list as "legitimately
    // empty". It is not — production serves 2,688 public playlists holding a
    // climb — so an index that quietly drops it is 10,752 URLs gone and now goes
    // red exactly like boards does.
    const withoutPlaylists = indexBody('static', 'boards', 'climbs');
    expect(
      check.assert(response({ contentType: 'application/xml', body: withoutPlaylists, headers: CLIMBS_FROM_STORE })),
    ).toMatch(/playlists/);

    // #4648: climbs is required for the same reason, an order of magnitude
    // larger. While publication was paused this smoke asserted the opposite —
    // that a climbs entry was a failure — so an index that silently stopped
    // listing ~53,000 URLs would have passed.
    const withoutClimbs = indexBody('static', 'boards', 'playlists');
    expect(check.assert(response({ contentType: 'application/xml', body: withoutClimbs }))).toMatch(/climbs/);

    // The regression this check has to keep catching after #4476. The index now
    // degrades rather than 503ing, so a cold-start failure of the boards builder
    // ships a 200 that quietly lost ~2,600 URLs. `static` is hardcoded and cannot
    // fail, so an "any one shard <loc>" assertion would be green on every
    // possible outage — the detector that found the bug would never fire again.
    //
    // Silent is the operative word: with no `X-Sitemap-Degraded` header there is
    // nothing to say the omission was deliberate, so it stays a hard failure.
    const degradedIndex = indexBody('static');
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
      body: indexBody('static'),
      headers: { 'x-sitemap-degraded': 'boards,playlists,climbs' },
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
      body: indexBody('static'),
      headers: { 'x-sitemap-degraded': 'playlists' },
    });
    expect(check.assert(wrongShardDeclared)).toMatch(/boards/);

    // A required-but-degradable shard the header names is a warning, and the
    // annotation says which of the dropped shards was a required one — that is
    // what separates "a required shard missed the deadline again" from "an
    // optional shard was quiet".
    const declaredDegradable = response({
      contentType: 'application/xml',
      body: indexBody('static', 'boards', 'climbs'),
      headers: { ...CLIMBS_FROM_STORE, 'x-sitemap-degraded': 'playlists' },
    });
    expect(check.assert(declaredDegradable)).toBeNull();
    expect(check.degradation?.(declaredDegradable)).toMatch(/playlists/);
    expect(check.degradation?.(declaredDegradable)).toMatch(/required playlists/);

    // A shard this list does not require at all is worth a warning but is not a
    // missing mandatory, so nothing is flagged as required.
    const optionalOnly = response({
      contentType: 'application/xml',
      body: indexBody('static', 'boards', 'playlists', 'climbs'),
      headers: { ...CLIMBS_FROM_STORE, 'x-sitemap-degraded': 'gyms' },
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
      body: indexBody('static', 'boards', 'playlists', 'climbs'),
      headers: CLIMBS_FROM_STORE,
    });
    expect(check.degradation?.(healthy) ?? null).toBeNull();
  });

  it('fails when the published climb surface is missing or unproven', () => {
    // The inverse of what this asserted while publication was paused (#4648).
    // Then, a climbs `<loc>` or a source header was the failure; now their
    // absence is. Flipping the switch back off therefore takes a change here as
    // well as an environment variable — which is the point of the tripwire, in
    // whichever direction it currently points.
    const check = checkNamed('sitemap index');
    const publishedIndex = indexBody('static', 'boards', 'playlists', 'climbs');

    expect(
      check.assert(response({ contentType: 'application/xml', body: publishedIndex, headers: CLIMBS_FROM_STORE })),
    ).toBeNull();

    // Climbs listed with nothing saying which path built it. That is the
    // half-enabled shape: the index rendered the page URLs without the paged
    // summary ever answering, so nothing proves the shard behind them serves.
    expect(check.assert(response({ contentType: 'application/xml', body: publishedIndex }))).toMatch(/climbs/);

    // A withdrawn surface with no header to excuse it — the silent regression
    // an image that lost CLIMB_SITEMAPS_ENABLED would produce.
    expect(
      check.assert(response({ contentType: 'application/xml', body: indexBody('static', 'boards', 'playlists') })),
    ).toMatch(/climbs/);

    // Dropped on purpose and said so: the summary lost the 3 s deadline against
    // an empty store. Reporting no source there is documented behaviour, not a
    // gap, so it warns rather than failing.
    const declaredDegraded = response({
      contentType: 'application/xml',
      body: indexBody('static', 'boards', 'playlists'),
      headers: { 'x-sitemap-degraded': 'climbs' },
    });
    expect(check.assert(declaredDegraded)).toBeNull();
    expect(check.degradation?.(declaredDegraded)).toMatch(/climbs/);

    // Correct, complete, and rebuilding the whole ordered list per request.
    const fromLiveScan = response({
      contentType: 'application/xml',
      body: publishedIndex,
      headers: { 'x-sitemap-climbs-source': 'live' },
    });
    expect(check.assert(fromLiveScan)).toBeNull();
    expect(check.degradation?.(fromLiveScan)).toMatch(/refresh-sitemap-climbs/);
  });

  it('requires cacheable XML from the climb shard at either origin', () => {
    // The check used to string-compare the whole header against Vercel's
    // downstream form, so pointing this smoke at a Railway origin failed on a
    // header that was exactly right. Directives, not strings — and the set of
    // tolerated ones widened with the flip, because the published shard runs on
    // `s-maxage=21600, stale-while-revalidate=604800` where the withdrawn one
    // ran on `must-revalidate`.
    const check = checkNamed('climb sitemap shard');
    const healthy = response({
      status: 200,
      contentType: 'application/xml',
      body: '<urlset><url><loc>https://www.boardsesh.com/kilter/original/12x12-square/screw_bolt/40/view/x</loc></url></urlset>',
      headers: { ...CLIMBS_FROM_STORE, 'cache-control': 'public, s-maxage=21600, stale-while-revalidate=604800' },
    });
    expect(check.assert(healthy)).toBeNull();
    // What an edge that consumes `s-maxage` as a private instruction forwards.
    expect(
      check.assert({
        ...healthy,
        headers: { ...CLIMBS_FROM_STORE, 'cache-control': 'public, max-age=0, must-revalidate' },
      }),
    ).toBeNull();
    // Whitespace and casing are the header's business, not the contract's.
    expect(
      check.assert({ ...healthy, headers: { ...CLIMBS_FROM_STORE, 'cache-control': ' Public,  S-MaxAge=21600' } }),
    ).toBeNull();

    // The withdrawn shape. A 410 here means the deploy lost the switch.
    expect(check.assert({ ...healthy, status: 410 })).toMatch(/200/);
    // A shard that rendered nothing is a regressed query, not an empty surface —
    // the summary already said there were items on this page.
    expect(check.assert({ ...healthy, body: '<urlset></urlset>' })).toMatch(/loc/);
    expect(check.assert({ ...healthy, headers: { ...CLIMBS_FROM_STORE, 'cache-control': 'no-store' } })).toMatch(
      /no-store/,
    );
    expect(
      check.assert({ ...healthy, headers: { ...CLIMBS_FROM_STORE, 'cache-control': 'private, max-age=60' } }),
    ).toMatch(/public/);
    // Cacheable by anything, forever, with nothing to revalidate against. It
    // carries `public`, so a required-directives check alone would pass a shard
    // that had lost its entire CDN window.
    expect(check.assert({ ...healthy, headers: { ...CLIMBS_FROM_STORE, 'cache-control': 'public' } })).toMatch(
      /s-maxage/,
    );
    expect(
      check.assert({ ...healthy, headers: { ...CLIMBS_FROM_STORE, 'cache-control': 'public, must-revalidate' } }),
    ).toMatch(/s-maxage/);
    expect(check.assert({ ...healthy, headers: { 'cache-control': 'public, s-maxage=21600' } })).toMatch(
      /x-sitemap-climbs-source/,
    );

    // Served, but from the fallback the URL table exists to retire. Green with
    // a warning, because the pages are correct and the cure is a refresh.
    const fromLiveScan = {
      ...healthy,
      headers: { ...healthy.headers, 'x-sitemap-climbs-source': 'live' },
    };
    expect(check.assert(fromLiveScan)).toBeNull();
    expect(check.degradation?.(fromLiveScan)).toMatch(/live/);
    expect(check.degradation?.(healthy) ?? null).toBeNull();
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
    expect(FIXTURE_PATHS.SMOKE_EXPECTED_DEPLOYMENT_ID('deployment')).toBe('/api/health');
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
