#!/usr/bin/env tsx
/// <reference types="node" />

/**
 * Post-deploy smoke for www.boardsesh.com, or a Railway origin via `--base`.
 *
 * Everything here is origin-agnostic on purpose: www is served by Vercel today
 * and by the Railway `web` service after the DNS flip, and during the overlap
 * both are smoked by the same run. Nothing may assume a Vercel-shaped response —
 * see the cache-control parsing below for the one place that used to.
 *
 * `deploy-web` had no post-deploy verification at all: a deploy that built and
 * uploaded cleanly but 500s on every request reported success, and the first
 * signal was a user. This script is the detector: it runs after the deploy,
 * turns the job red on a hard failure, and lets the calling workflow restore a
 * captured deployment when that target has an automatic recovery path.
 *
 * Scope is deliberately shallow. These are reachability and shape checks over
 * the surfaces that (a) carry organic traffic, (b) other systems depend on, or
 * (c) are load-bearing for the Expo Web Program's front door. Anything needing
 * a session, a mutation, or seeded data belongs in e2e, not here — this runs
 * against production and must stay read-only.
 *
 * Outcomes are pass / WARN / FAIL / skip. WARN exists for a surface that answers
 * correctly but tells us, on the response itself, that it served less than it
 * should have — today only the degrading sitemap index. It annotates the job and
 * leaves it green; only FAIL exits non-zero.
 *
 *   vp run smoke:production                    # www.boardsesh.com
 *   vp run smoke:production -- --base <url>    # a preview or Railway origin
 *
 * Fixture-dependent checks (kiosk, embed) need a real gym slug / board uuid.
 * They are configured through SMOKE_KIOSK_GYM_SLUG / SMOKE_EMBED_BOARD_UUID and
 * report as skipped when unset. They are NOT fail-closed on missing config:
 * a deploy gate that fails because someone forgot a repo variable stops
 * production deploys for days (see #3977), and that cure is worse than the
 * disease this script treats.
 */

import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'https://www.boardsesh.com';

/** Per-request ceiling. Generous: a cold serverless route can be slow. */
const REQUEST_TIMEOUT_MS = 30_000;
/**
 * The climb shard's own ceiling, and the reason a check may override the one
 * above.
 *
 * `pagedShardRouteHandler` puts no deadline on `buildPage()`, and the empty-store
 * fallback behind it is a full grouped rebuild measured at 51 s in production
 * (#4552) — longer than `REQUEST_TIMEOUT_MS`. That state is exactly the one this
 * check's `degradation` channel describes as a WARN, so smoking it on the shared
 * 30 s budget would abort the fetch and report the documented warning as three
 * hard failures instead. 90 s clears the 51 s fallback with room for a cold
 * container, and the three attempts still cannot outlive the deploy job.
 */
const CLIMB_SHARD_TIMEOUT_MS = 90_000;
/** Attempts per check, to ride out a single edge/CDN blip. */
const ATTEMPTS = 3;
const RETRY_DELAY_MS = 5_000;

export type SmokeResponse = {
  status: number;
  contentType: string;
  body: string;
  /** Response headers, keys lowercased. Only read by checks that need one. */
  headers: Record<string, string>;
  /**
   * The URL the response actually came from, after any redirects. Not the URL
   * that was requested: a misconfigured origin that 30x's to www answers every
   * check with a healthy production response, and the run goes green having
   * tested nothing about the deploy it was pointed at.
   */
  url: string;
};

type SmokeAssertionEnvironment = {
  SMOKE_EXPECTED_DEPLOYMENT_ID?: string;
  SMOKE_EXPECTED_RELEASE?: string;
};

export type SmokeCheck = {
  /** Human-readable, appears in the pass/fail log. */
  name: string;
  /**
   * Path appended to the base URL. Empty for a fixture-backed check, which
   * builds its path from `FIXTURE_PATHS` once the fixture value is known.
   */
  path: string;
  /**
   * Returns null when the check passes, or a reason string when it fails.
   * Never throws — a thrown error is reported as an infrastructure failure
   * rather than an assertion failure, which reads very differently on-call.
   */
  assert: (response: SmokeResponse, env?: SmokeAssertionEnvironment) => string | null;
  /**
   * Optional second channel for "served, but the server told us it served less
   * than it should have". Returns null when the response is fully healthy, or a
   * reason string describing the degradation.
   *
   * A degradation reports as a WARNING and leaves the job green, where `assert`
   * reports as a failure and turns it red. The distinction only belongs on a
   * surface whose degradation is *declared* by the server; anything we merely
   * infer from the body is an assertion.
   *
   * It is retried like a failure, but do not read the retry as a warm-up: the
   * WARN is the mechanism, not a last resort. Vercel's edge ignores this
   * script's `Cache-Control: no-cache` request header and caches the degraded
   * index for 60s — longer than all three attempts put together (~10s), so the
   * retries return the same cached body. Measured: attempt 1 MISS 3.35s,
   * attempt 2 HIT 0.09s, both carrying an identical `x-sitemap-degraded`. Once
   * the window opens the WARN is guaranteed; the retry only covers an edge blip.
   */
  degradation?: (response: SmokeResponse) => string | null;
  /**
   * Env var holding the fixture this check needs. When set on the check and
   * absent from the environment, the check is skipped rather than failed.
   */
  fixtureEnvVar?: string;
  /** Stop immediately after this check exhausts its retries with a failure. */
  stopSuiteOnFailure?: boolean;
  /**
   * Per-request ceiling for this check only. Defaults to `REQUEST_TIMEOUT_MS`.
   *
   * Raise it only where a slow answer is a *documented* state the check reports
   * on rather than a symptom — otherwise an abort is the right verdict and a
   * longer budget just delays it.
   */
  timeoutMs?: number;
};

function expectStatus(response: SmokeResponse, expected: number): string | null {
  return response.status === expected ? null : `expected HTTP ${expected}, got ${response.status}`;
}

function expectContentType(response: SmokeResponse, fragment: string): string | null {
  return response.contentType.includes(fragment)
    ? null
    : `expected content-type containing "${fragment}", got "${response.contentType}"`;
}

function expectBodyContains(response: SmokeResponse, needle: string, label: string): string | null {
  return response.body.includes(needle) ? null : `response body has no ${label}`;
}

/**
 * An open `<h1>` tag, with or without attributes. Neither plain substring is
 * right on its own: `'<h1>'` misses the MUI output this page actually serves
 * (`<h1 class="MuiTypography-root …">`), and `'<h1'` would also match `<h10`.
 */
const OPEN_H1_TAG = /<h1[\s>]/i;

/** Parses the body as JSON, or explains why it isn't. */
function expectJsonBody(response: SmokeResponse): { payload: Record<string, unknown> } | string {
  try {
    const parsed: unknown = JSON.parse(response.body);
    if (typeof parsed !== 'object' || parsed === null) return `payload is not a JSON object: ${typeof parsed}`;
    return { payload: parsed as Record<string, unknown> };
  } catch {
    return `payload is not valid JSON: ${response.body.slice(0, 120)}`;
  }
}

/** First non-null failure reason, or null when every assertion passed. */
function firstFailure(...reasons: (string | null)[]): string | null {
  return reasons.find((reason) => reason !== null) ?? null;
}

/**
 * A Next error shell is a well-formed 200-ish HTML document, so status and
 * content-type alone accept it. The kiosk especially needs more than that —
 * it is an unattended gym screen that reloads daily, so a render regression
 * there sits broken for up to 24h with nobody watching.
 *
 * The floor is on body size rather than on specific markup, because these two
 * checks only run against a fixture configured per-environment: asserting an
 * `<h1>` or a known class would be guessing at markup this script can't see.
 * An error shell is a couple of KB; a rendered board page is far larger.
 */
const MIN_RENDERED_PAGE_CHARS = 4_000;

/**
 * The header `sitemapIndexRouteHandler` sets when it published an index without
 * one of its shards. It exists precisely so the degradation is legible from the
 * outside instead of only in a `console.error` nobody reads, and reading it here
 * is what lets this check tell "the index dropped a shard and said so" apart
 * from "the shard vanished silently", which are the same body and very
 * different bugs.
 */
const SITEMAP_DEGRADED_HEADER = 'x-sitemap-degraded';

/**
 * Which path answered the climbs shard: `store` (the materialised
 * `sitemap_climb_urls` rows) or `live` (the full grouped rebuild those rows
 * exist to retire). It must be PRESENT now that publication is on — its absence
 * is the signature of a half-enabled surface, where the index is built but the
 * paged shard never ran.
 *
 * `live` is not a failure. On the deploy that turns publication on, and on any
 * deploy that leaves the store empty, the fallback is the correct answer until
 * the first refresh lands. It is expensive enough to be worth a WARN — and slow
 * enough that the shard check has to buy `CLIMB_SHARD_TIMEOUT_MS` for it, or the
 * fetch aborts and the WARN is reported as a failure instead.
 */
const SITEMAP_CLIMBS_SOURCE_HEADER = 'x-sitemap-climbs-source';
const CLIMB_SITEMAP_PATH_PREFIX = '/sitemaps/climbs/';
const CLIMB_SITEMAP_STORE_SOURCE = 'store';

/**
 * `Cache-Control` directives a published climb shard must and may carry.
 *
 * The route emits `public, s-maxage=21600, stale-while-revalidate=604800`
 * (packages/web/app/lib/seo/sitemap/shard-registry.ts), and that long window is
 * the whole reason a crawl of six 2.5 MB pages does not reach a ten-connection
 * pool six times over. What a CDN forwards, though, is its own business: an edge
 * that consumes `s-maxage` as a private instruction commonly rewrites the client
 * copy to `public, max-age=0, must-revalidate`. A string compare is wrong at one
 * origin or the other, so this parses directives instead.
 *
 * `public` is the contract — the shard has to be cacheable by something other
 * than the browser that asked. Anything else (`no-store`, `private`, `no-cache`)
 * means every crawler fetch reaches Postgres, which is the failure this window
 * was built to prevent.
 *
 * Which freshness directive survives is the edge's business, but at least one of
 * them has to. A bare `public` is cacheable forever with nothing to revalidate
 * against, so requiring only `public` would pass a shard that had lost its whole
 * CDN window — the regression this check exists for. Requiring one of the three
 * accepts both the origin form and the `max-age=0, must-revalidate` an edge that
 * consumes `s-maxage` rewrites it to, and rejects a header with no freshness
 * story at all.
 */
const REQUIRED_CLIMB_CACHE_DIRECTIVES = ['public'] as const;
const FRESHNESS_CLIMB_CACHE_DIRECTIVES = ['s-maxage', 'max-age', 'stale-while-revalidate'] as const;
const TOLERATED_CLIMB_CACHE_DIRECTIVES = [...FRESHNESS_CLIMB_CACHE_DIRECTIVES, 'must-revalidate'] as const;

/** Directive NAMES only — `s-maxage=21600` reads as `s-maxage`. */
function cacheControlDirectiveNames(header: string): string[] {
  return header
    .split(',')
    .map((directive) => directive.trim().split('=')[0].toLowerCase())
    .filter((name) => name.length > 0);
}

function expectClimbShardCacheControl(response: SmokeResponse): string | null {
  const header = response.headers['cache-control'] ?? '';
  const names = cacheControlDirectiveNames(header);

  const missing = REQUIRED_CLIMB_CACHE_DIRECTIVES.filter((directive) => !names.includes(directive));
  if (missing.length > 0) return `expected cache-control to carry ${missing.join(' and ')}, got "${header}"`;

  if (!FRESHNESS_CLIMB_CACHE_DIRECTIVES.some((directive) => names.includes(directive))) {
    return `expected cache-control to carry one of ${FRESHNESS_CLIMB_CACHE_DIRECTIVES.join(', ')}, got "${header}"`;
  }

  const unexpected = names.filter(
    (name) =>
      !(REQUIRED_CLIMB_CACHE_DIRECTIVES as readonly string[]).includes(name) &&
      !(TOLERATED_CLIMB_CACHE_DIRECTIVES as readonly string[]).includes(name),
  );
  return unexpected.length === 0
    ? null
    : `cache-control carries unexpected directive(s) ${unexpected.join(', ')}, got "${header}"`;
}

/**
 * Fails a check whose response came back from somewhere other than `--base`.
 *
 * Checked before the check's own assertions, because an off-origin response
 * makes every one of them meaningless: a Railway origin still wired to redirect
 * to www would pass this whole suite on production's answers while the
 * container under test served nothing at all.
 */
export function originFailure(response: SmokeResponse, baseUrl: string): string | null {
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(baseUrl).origin;
  } catch {
    return `--base is not a usable URL: ${baseUrl}`;
  }

  let finalOrigin: string;
  try {
    finalOrigin = new URL(response.url).origin;
  } catch {
    return `response reports no usable final URL (${JSON.stringify(response.url)})`;
  }

  return finalOrigin === expectedOrigin
    ? null
    : `redirected off ${expectedOrigin} — the response came from ${finalOrigin}, so this check tested the wrong deployment`;
}

/**
 * Shards the index must always list.
 *
 * `gyms` and `setters` are legitimately empty, so a missing entry there proves
 * nothing.
 *
 * `playlists` used to sit in that sentence too, and the justification was stale:
 * production serves 2,688 public playlists holding at least one climb, so a
 * missing entry there is 10,752 locale-expanded URLs gone, not an empty surface.
 * That is exactly why this check never caught #4524. It is `degradable: true`
 * because the shard's rows are cached rather than stored, so a cold Data Cache
 * entry can still lose the 3 s deadline once and self-heal on the `after()` warm —
 * a WARN. The shard vanishing without the header saying so is still a FAIL.
 *
 * `climbs` is required again (#4648). While publication was paused this smoke
 * pinned the opposite — entries absent, source header absent, direct route 410 —
 * so that turning the surface back on could not be done with an environment
 * variable alone. It is now the largest published surface by two orders of
 * magnitude, ~53,000 URLs across six pages, and page 1 exists whenever the shard
 * has any items at all. `degradable: true` for the same reason as `playlists`:
 * an empty store makes the summary fall back to a scan that cannot meet the 3 s
 * deadline, which drops the shard for sixty seconds and says so in the header.
 *
 * `degradable` is what `X-Sitemap-Degraded` may excuse. `boards` is genuinely
 * transient — a cold cache, a slow backend — and self-heals under the 60s window.
 * `static` is not: `buildStaticEntries` is hardcoded and pure, with no fetch, no
 * query and nothing to time out, so it can only go missing if the index resolved
 * essentially nothing. Excusing it via the header would buy no real coverage and
 * would let an empty `<sitemapindex></sitemapindex>` pass as long as the handler
 * named every shard in the header.
 *
 * The `<loc>` values are absolute and hardcoded on purpose: the index renders
 * them from the configured site base, not from the request host, so they stay
 * `www.boardsesh.com` even when the smoke runs against a preview `--base`.
 */
const REQUIRED_SITEMAP_SHARDS = [
  { id: 'static', loc: 'https://www.boardsesh.com/sitemaps/static.xml', degradable: false },
  { id: 'boards', loc: 'https://www.boardsesh.com/sitemaps/boards.xml', degradable: true },
  { id: 'playlists', loc: 'https://www.boardsesh.com/sitemaps/playlists.xml', degradable: true },
  { id: 'climbs', loc: `https://www.boardsesh.com${CLIMB_SITEMAP_PATH_PREFIX}1.xml`, degradable: true },
] as const;

type RequiredSitemapShard = (typeof REQUIRED_SITEMAP_SHARDS)[number];

/** Shard ids the response declared it dropped, in header order. */
function declaredDegradedShards(response: SmokeResponse): string[] {
  return (response.headers[SITEMAP_DEGRADED_HEADER] ?? '')
    .split(',')
    .map((shard) => shard.trim())
    .filter((shard) => shard.length > 0);
}

function missingRequiredShards(response: SmokeResponse): RequiredSitemapShard[] {
  return REQUIRED_SITEMAP_SHARDS.filter((shard) => !response.body.includes(`<loc>${shard.loc}`));
}

function renderedHtmlPage(response: SmokeResponse): string | null {
  return firstFailure(
    expectStatus(response, 200),
    expectContentType(response, 'text/html'),
    response.body.length >= MIN_RENDERED_PAGE_CHARS
      ? null
      : `page is ${response.body.length} chars, under the ${MIN_RENDERED_PAGE_CHARS}-char floor — likely an error shell, not a render`,
  );
}

export const WWW_CHECKS: SmokeCheck[] = [
  {
    // Keep this first. A Railway deploy that resolves to an old container must
    // enter recovery before the slower sitemap and fixture checks consume their
    // retry budgets. It skips outside an identity-bound Railway smoke.
    name: 'deployment identity matches this Railway release',
    path: '',
    fixtureEnvVar: 'SMOKE_EXPECTED_DEPLOYMENT_ID',
    stopSuiteOnFailure: true,
    assert: (response, env) => {
      const failure = firstFailure(expectStatus(response, 200), expectContentType(response, 'application/json'));
      if (failure) return failure;
      const parsed = expectJsonBody(response);
      if (typeof parsed === 'string') return parsed;

      const expectedDeploymentId = env?.SMOKE_EXPECTED_DEPLOYMENT_ID?.trim();
      if (!expectedDeploymentId) {
        return 'SMOKE_EXPECTED_DEPLOYMENT_ID disappeared while the identity check was running';
      }
      const actualDeploymentId = parsed.payload.deploymentId;
      if (actualDeploymentId !== expectedDeploymentId) {
        return `expected deployment ${expectedDeploymentId}, got ${typeof actualDeploymentId === 'string' ? actualDeploymentId : '<missing>'}`;
      }

      const expectedRelease = env?.SMOKE_EXPECTED_RELEASE?.trim();
      if (!expectedRelease) {
        return 'SMOKE_EXPECTED_RELEASE must be a 40-character lowercase Git SHA for a deployment identity check';
      }
      if (!/^[0-9a-f]{40}$/.test(expectedRelease)) {
        return 'SMOKE_EXPECTED_RELEASE must be a 40-character lowercase Git SHA';
      }
      const actualRelease = parsed.payload.release;
      return actualRelease === expectedRelease
        ? null
        : `expected release ${expectedRelease}, got ${typeof actualRelease === 'string' ? actualRelease : '<missing>'}`;
    },
  },
  {
    name: 'homepage renders server-side',
    path: '/',
    // A spinner-only shell is the failure this catches: the page 200s, but the
    // crawlable payload is gone. An <h1> is the cheapest proof of real SSR.
    assert: (response) =>
      firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'text/html'),
        OPEN_H1_TAG.test(response.body) ? null : 'response body has no server-rendered <h1>',
      ),
  },
  {
    name: 'robots.txt serves and points at the sitemap',
    path: '/robots.txt',
    assert: (response) =>
      firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'text/plain'),
        expectBodyContains(response, 'Sitemap:', 'Sitemap: directive'),
      ),
  },
  {
    // A `<loc>`-only check would pass on the old flat `<urlset>` too — and on a
    // broken index — so assert the index shape *and* that it points at a shard.
    //
    // Both mandatory shards are named, not "any one `<loc>`". Since #4476 the
    // index *degrades*: a builder that fails is omitted and the index still 200s.
    // That is the right behaviour for crawlers and the wrong behaviour for a
    // detector — the original wording passes on an index that lost everything but
    // `static.xml`, which is a pure hardcoded builder that cannot fail, so this
    // check could never have gone red again.
    //
    // What splits fail from warn on a *degradable* shard is `X-Sitemap-Degraded`,
    // not the body. Missing AND named in that header is the subsystem working as
    // designed: the handler logged it, dropped the CDN window to sixty seconds so
    // it self-heals, and told us which shard it was. That is a warning. Missing
    // WITHOUT the header is the silent loss this check exists to catch, and stays
    // a failure — as do a non-200, a non-XML body, anything that is not a
    // `<sitemapindex>`, and a missing `static` under any header at all.
    //
    // Softening boards to a warning here removes this check's only view of the
    // boards surface, so `/sitemaps/boards.xml` gets a check of its own below.
    // Together they draw the line where it belongs: a transient index degradation
    // WARNs, a boards outage that actually breaks the shard URL stays FAIL.
    name: 'sitemap.xml serves a sitemap index pointing at shards',
    path: '/sitemap.xml',
    assert: (response) => {
      const structural = firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'xml'),
        expectBodyContains(response, '<sitemapindex', '<sitemapindex> root element'),
      );
      if (structural) return structural;

      const declared = declaredDegradedShards(response);
      // A climbs entry with no source header is the half-enabled shape: the
      // index listed the pages without the paged summary ever answering, so
      // nothing proves the shard behind those `<loc>`s can be served. When the
      // header names climbs the summary was dropped on purpose and reporting no
      // source is the documented behaviour, not a gap.
      const climbsPublished = response.body.includes(CLIMB_SITEMAP_PATH_PREFIX);
      const sourceFailure =
        climbsPublished && !declared.includes('climbs') && !response.headers[SITEMAP_CLIMBS_SOURCE_HEADER]
          ? `index published ${CLIMB_SITEMAP_PATH_PREFIX} entries without a ${SITEMAP_CLIMBS_SOURCE_HEADER} header`
          : null;
      if (sourceFailure) return sourceFailure;

      const unexcused = missingRequiredShards(response).filter(
        (shard) => !shard.degradable || !declared.includes(shard.id),
      );
      return unexcused.length === 0
        ? null
        : `response body has no ${unexcused.map((shard) => shard.id).join(', ')} shard <loc> entry that the ${SITEMAP_DEGRADED_HEADER} header excuses`;
    },
    degradation: (response) => {
      const reasons: string[] = [];

      const declared = declaredDegradedShards(response);
      if (declared.length > 0) {
        const missing = missingRequiredShards(response).map((shard) => shard.id);
        const requiredNote = missing.length > 0 ? ` — including the required ${missing.join(', ')}` : '';
        reasons.push(
          `index published WITHOUT ${declared.join(', ')}${requiredNote} (${SITEMAP_DEGRADED_HEADER}: ${declared.join(',')})`,
        );
      }

      // Correct, complete, and paying the 16.7 s scan the store exists to
      // retire. Nothing external goes red on it, which is exactly why #4583 put
      // the source on the wire in the first place — so say it out loud.
      const climbsSource = response.headers[SITEMAP_CLIMBS_SOURCE_HEADER];
      if (climbsSource && climbsSource !== CLIMB_SITEMAP_STORE_SOURCE) {
        reasons.push(
          `climb shard summary served from "${climbsSource}", not the store — run /api/internal/refresh-sitemap-climbs`,
        );
      }

      return reasons.length === 0 ? null : reasons.join('; ');
    },
  },
  {
    // The index check above can only see that climbs was listed. This is the
    // page a crawler actually fetches, and the one that still costs 51 s when
    // the store is empty — hence the check's own timeout.
    name: 'the climb sitemap shard serves cacheable URLs',
    path: `${CLIMB_SITEMAP_PATH_PREFIX}1.xml`,
    timeoutMs: CLIMB_SHARD_TIMEOUT_MS,
    assert: (response) =>
      firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'xml'),
        expectBodyContains(response, '<urlset', '<urlset> root element'),
        expectBodyContains(response, '<loc>', '<loc> entry'),
        expectClimbShardCacheControl(response),
        response.headers[SITEMAP_CLIMBS_SOURCE_HEADER]
          ? null
          : `shard served without a ${SITEMAP_CLIMBS_SOURCE_HEADER} header`,
      ),
    degradation: (response) => {
      const source = response.headers[SITEMAP_CLIMBS_SOURCE_HEADER];
      return source && source !== CLIMB_SITEMAP_STORE_SOURCE
        ? `page built from "${source}", not the store — the empty-store fallback rebuilds the whole ordered list per request`
        : null;
    },
  },
  {
    name: 'the static sitemap shard serves URLs',
    path: '/sitemaps/static.xml',
    assert: (response) =>
      firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'xml'),
        expectBodyContains(response, '<urlset', '<urlset> root element'),
        expectBodyContains(response, '<loc>', '<loc> entry'),
      ),
  },
  {
    // The boards surface's only remaining hard signal, and the reason the index
    // check above can afford to WARN. Every way `boards` goes missing from the
    // index puts its id in `degradedShards` — a rejecting builder, a missed
    // deadline, an unexpectedly empty build, an over-budget URL count — so once
    // the header excuses it there, nothing else in this suite would ever go red
    // on boards while `/sitemaps/boards.xml` sat there 503ing.
    //
    // Not a hypothetical failure mode: `getAllBoardConfigsOrThrow` throws on
    // `hasMore`, and 100 is the schema's hard cap on a catalogue its own comment
    // calls "one merge away" from outgrowing. That throw is permanent by
    // construction — every request, indefinitely, until someone pages the query —
    // and the shard route turns it into a 503 that this check catches on the
    // first deploy after it starts.
    //
    // No `degradation` channel on purpose: a shard route is fail-closed by
    // doctrine and has nothing to declare. Measured against production at 2,760
    // `<loc>` entries in 0.98s, comfortably inside REQUEST_TIMEOUT_MS.
    name: 'the boards sitemap shard serves URLs',
    path: '/sitemaps/boards.xml',
    assert: (response) =>
      firstFailure(
        expectStatus(response, 200),
        expectContentType(response, 'xml'),
        expectBodyContains(response, '<urlset', '<urlset> root element'),
        expectBodyContains(response, '<loc>', '<loc> entry'),
      ),
  },
  {
    name: 'auth session endpoint answers anonymously',
    path: '/api/auth/session',
    // Body shape matters as much as status: this is the SPA's identity
    // provider, and a 200 carrying `{"error":"..."}` — or an HTML error page
    // with a JSON content type — is exactly the failure a status-only check
    // waves through.
    assert: (response) => {
      const failure = firstFailure(expectStatus(response, 200), expectContentType(response, 'application/json'));
      if (failure) return failure;
      const parsed = expectJsonBody(response);
      if (typeof parsed === 'string') return parsed;
      return 'error' in parsed.payload ? `session endpoint returned an error: ${String(parsed.payload.error)}` : null;
    },
  },
  {
    name: 'ws-auth answers anonymously (kiosk + embed depend on it)',
    path: '/api/internal/ws-auth',
    // Kiosks and embeds open a presence socket with no session. If this starts
    // 401ing or 500ing, every unattended gym screen goes dark — and nobody is
    // watching a kiosk to report it.
    assert: (response) => {
      const failure = firstFailure(expectStatus(response, 200), expectContentType(response, 'application/json'));
      if (failure) return failure;
      const parsed = expectJsonBody(response);
      if (typeof parsed === 'string') return parsed;
      return 'authenticated' in parsed.payload ? null : 'payload has no `authenticated` field';
    },
  },
  {
    name: 'kiosk page renders for a real gym',
    path: '',
    fixtureEnvVar: 'SMOKE_KIOSK_GYM_SLUG',
    assert: renderedHtmlPage,
  },
  {
    name: 'board embed renders for a real board',
    path: '',
    fixtureEnvVar: 'SMOKE_EMBED_BOARD_UUID',
    assert: renderedHtmlPage,
  },
];

/** Fixture-backed paths, kept next to the checks that consume them. */
export const FIXTURE_PATHS: Record<string, (value: string) => string> = {
  SMOKE_KIOSK_GYM_SLUG: (slug) => `/kiosk/${slug}`,
  SMOKE_EMBED_BOARD_UUID: (uuid) => `/embed/board/${uuid}`,
  SMOKE_EXPECTED_DEPLOYMENT_ID: () => '/api/health',
};

function resolvePath(check: SmokeCheck, env: NodeJS.ProcessEnv): string | null {
  if (!check.fixtureEnvVar) return check.path;
  const fixtureValue = env[check.fixtureEnvVar];
  if (!fixtureValue) return null;
  const buildPath = FIXTURE_PATHS[check.fixtureEnvVar];
  return buildPath ? buildPath(fixtureValue) : null;
}

async function fetchOnce(url: string, timeoutMs: number): Promise<SmokeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Identify the smoke in access logs, and ask for the uncached answer —
        // a CDN hit would happily serve the *previous* deploy's HTML and mask
        // exactly the regression this exists to catch.
        'User-Agent': 'boardsesh-production-smoke/1.0',
        'Cache-Control': 'no-cache',
      },
    });
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name.toLowerCase()] = value;
    });
    return {
      status: response.status,
      contentType: response.headers.get('content-type') ?? '',
      body: await response.text(),
      headers,
      // `redirect: 'follow'` above means this can differ from `url`.
      url: response.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CheckOutcome = { name: string; state: 'pass' | 'warn' | 'fail' | 'skip'; detail: string };

export function shouldStopSmokeSuite(check: SmokeCheck, outcome: CheckOutcome): boolean {
  return check.stopSuiteOnFailure === true && outcome.state === 'fail';
}

/** What one non-passing attempt ended as. A passing attempt returns immediately. */
export type AttemptState = 'fail' | 'degraded';

/**
 * The verdict for a check whose every attempt was used up.
 *
 * WARN is reserved for a run where *no* attempt failed outright — every one was a
 * clean 200 that simply declared itself incomplete. A surface that 503s twice and
 * recovers into a merely-degraded third attempt is flapping, and flapping is an
 * outage: reporting that green would hide a real one behind its own recovery.
 * Taking only the last attempt's state is the bug this exists to avoid.
 */
export function finalVerdict(attempts: readonly AttemptState[]): 'warn' | 'fail' {
  return attempts.length > 0 && attempts.every((attempt) => attempt === 'degraded') ? 'warn' : 'fail';
}

async function runCheck(check: SmokeCheck, baseUrl: string, env: NodeJS.ProcessEnv): Promise<CheckOutcome> {
  const path = resolvePath(check, env);
  if (path === null) {
    return { name: check.name, state: 'skip', detail: `${check.fixtureEnvVar} not set` };
  }

  const url = `${baseUrl}${path}`;
  const attempts: AttemptState[] = [];
  let lastFailure = '';
  let lastDegradation = '';

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    let detail: string;
    try {
      const response = await fetchOnce(url, check.timeoutMs ?? REQUEST_TIMEOUT_MS);
      const failure =
        originFailure(response, baseUrl) ??
        check.assert(response, {
          SMOKE_EXPECTED_DEPLOYMENT_ID: env.SMOKE_EXPECTED_DEPLOYMENT_ID,
          SMOKE_EXPECTED_RELEASE: env.SMOKE_EXPECTED_RELEASE,
        });
      if (failure === null) {
        const degradation = check.degradation?.(response) ?? null;
        if (degradation === null) return { name: check.name, state: 'pass', detail: path };
        lastDegradation = degradation;
        attempts.push('degraded');
        detail = degradation;
      } else {
        lastFailure = failure;
        attempts.push('fail');
        detail = failure;
      }
    } catch (error) {
      lastFailure = `request failed: ${error instanceof Error ? error.message : String(error)}`;
      attempts.push('fail');
      detail = lastFailure;
    }
    if (attempt < ATTEMPTS) {
      const label = attempts[attempts.length - 1] === 'degraded' ? 'degraded' : 'failed';
      console.log(`  ${check.name}: attempt ${attempt} ${label} (${detail}); retrying in 5s...`);
      await delay(RETRY_DELAY_MS);
    }
  }

  const state = finalVerdict(attempts);
  return { name: check.name, state, detail: `${path} — ${state === 'warn' ? lastDegradation : lastFailure}` };
}

/** `--base` is the only override — one documented way to point this elsewhere. */
export function parseBaseUrl(argv: string[]): string {
  const flagIndex = argv.indexOf('--base');
  if (flagIndex === -1) return DEFAULT_BASE_URL;
  const value = argv[flagIndex + 1];
  if (!value) throw new Error('--base needs a URL');
  // Validate here rather than letting a typo surface three retries deep as a
  // fetch error that reads like the site is down.
  try {
    new URL(value);
  } catch {
    throw new Error(`--base is not a valid URL: ${value} (did you include the scheme?)`);
  }
  return value.replace(/\/$/, '');
}

async function main(): Promise<void> {
  const baseUrl = parseBaseUrl(process.argv.slice(2));
  console.log(`Production smoke against ${baseUrl}\n`);

  const MARKERS: Record<CheckOutcome['state'], string> = { pass: 'ok', warn: 'WARN', fail: 'FAIL', skip: '--' };

  const outcomes: CheckOutcome[] = [];
  for (const check of WWW_CHECKS) {
    const outcome = await runCheck(check, baseUrl, process.env);
    outcomes.push(outcome);
    console.log(
      `${MARKERS[outcome.state].padEnd(4)} ${outcome.name}${outcome.state === 'pass' ? '' : ` (${outcome.detail})`}`,
    );
    if (shouldStopSmokeSuite(check, outcome)) {
      console.log('Stopping smoke after the deployment identity failed.');
      break;
    }
  }

  const failures = outcomes.filter((outcome) => outcome.state === 'fail');
  const warnings = outcomes.filter((outcome) => outcome.state === 'warn');
  const skipped = outcomes.filter((outcome) => outcome.state === 'skip');
  console.log(
    `\n${outcomes.length - failures.length - warnings.length - skipped.length} passed, ${failures.length} failed, ${warnings.length} degraded, ${skipped.length} skipped`,
  );

  // A degraded surface is real news, so it gets a GitHub annotation of its own —
  // but not a red deploy: the server declared the degradation, serves it under a
  // sixty-second window, and self-heals. Only a silent or structural break is a
  // failure.
  for (const warning of warnings) {
    console.log(`::warning::production smoke degraded: ${warning.name} — ${warning.detail}`);
  }
  for (const failure of failures) {
    console.log(`::error::production smoke failed: ${failure.name} — ${failure.detail}`);
  }
  if (failures.length > 0) process.exit(1);
}

// Only run when invoked directly, so the test can import the check table.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`::error::production smoke crashed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
