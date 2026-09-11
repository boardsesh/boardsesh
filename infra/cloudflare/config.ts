/// <reference types="node" />

import { BLOCKED_CRAWLER_TOKENS } from '../../packages/web/app/lib/crawler-policy';

// Declarative desired-state for the Cloudflare-managed boardsesh.com zone. This
// is plain typed data — no side effects, no API calls. scripts/cloudflare-apply.ts
// reads it, diffs it against the live zone, and (only with --apply) converges the
// delta.
//
// Why this exists, in three parts:
//
// 1. ws.boardsesh.com (a single-region Railway origin) sits behind the Cloudflare
//    proxy so /og/* share cards and /render/board images edge-cache globally.
//    Everything else on that host (/graphql, other REST, WebSocket upgrades)
//    must bypass the cache.
//    The manual runbook this replaces lives in docs/og-climb.md.
//
// 2. www.boardsesh.com is the marketing/SEO surface. It moved from Vercel to the
//    Railway web service in #4655 (epic #4648); the two rules below are cost
//    controls dating from the Vercel era (#4650) and still apply now that
//    Railway sits behind the same proxy. Measured 2026-08-25 against Vercel:
//    ~442,600 function invocations/day, of which /api/internal/board-render was
//    ~215,600 and the climb-view page ~203,900, against a published sitemap of
//    only ~60k URLs and ~2,000 homepage hits. See docs/cloudflare.md.
//    Its DNS record is fully managed here — type, content, TTL and the proxy
//    flag — so a future origin change is a reviewable diff rather than a
//    dashboard click.
//
// 3. assets.boardsesh.com is the public, DNS-only custom domain for the Tigris
//    static-assets bucket. Unlike ws, this tool owns the record's complete shape
//    and creates it when it is absent.

/** The Cloudflare zone this config manages. Resolved to a zone id by name when CLOUDFLARE_ZONE_ID is unset. */
export const ZONE_NAME = 'boardsesh.com';

/** The Railway-backed host we put behind the Cloudflare proxy. */
export const WS_HOSTNAME = 'ws.boardsesh.com';

/** Public custom domain for the content-addressed static-assets bucket. */
export const ASSETS_HOSTNAME = 'assets.boardsesh.com';

/** Tigris custom-domain DNS target for the dedicated Boardsesh static-assets bucket. */
export const ASSETS_CNAME_TARGET = 'boardsesh-static-assets.t3.tigrisbucket.io';

/** Path prefix whose responses are immutable (`Cache-Control: … immutable`, 1y) and safe to edge-cache. */
export const OG_PATH_PREFIX = '/og/';

/** The marketing/SEO www origin whose crawl cost the rules below exist to cap. */
export const WWW_HOSTNAME = 'www.boardsesh.com';

/**
 * Railway's required CNAME target for the `www.boardsesh.com` custom domain,
 * registered on the `boardsesh-web` service
 * (id `c60e7c36-9080-4968-8370-381ec8804b9c`), origin
 * `https://boardsesh-web-production.up.railway.app`. This is the value Railway
 * printed when the custom domain was added — it is not derivable from the
 * service name — and is the only source of truth for it. Changing it here
 * without first re-registering the domain in Railway breaks TLS termination
 * for www (the zone's SSL mode is Full (strict); Railway serves a cert for
 * this host only once DNS resolves to it).
 */
export const WWW_RAILWAY_CNAME_TARGET = 'nefrfe3c.up.railway.app';

/** The zone apex. Everything on it redirects to WWW_HOSTNAME. */
export const APEX_HOSTNAME = ZONE_NAME;

/**
 * Cloudflare's documented originless placeholder address, in its A-record form.
 *
 * The apex has no origin of its own: it exists only so Cloudflare terminates the
 * request and the redirect rule below can answer it. Cloudflare documents two
 * reserved addresses for this — `192.0.2.0` (A) and `100::` (AAAA). The A form
 * is the one used here for a reason that has nothing to do with IP version: the
 * apex ALREADY EXISTS as a DNS-only A record to Vercel, so declaring an A keeps
 * the apply an in-place update of that record — content and proxied flag, and
 * nothing else. An AAAA would make the apply change the record's TYPE, which
 * either lands a second record beside the A (split-brain: some resolvers reach
 * Vercel unproxied while others reach Cloudflare) or leans on the API accepting
 * a type change in place. Neither is something to find out during a production
 * apply.
 *
 * `192.0.2.0` is RFC 5737 TEST-NET-1, reserved for documentation and guaranteed
 * never to be routed, so a packet that somehow escaped the proxy goes nowhere
 * real. `192.0.2.1` is in the same block but is NOT the address Cloudflare
 * names, so it is not used here.
 *
 * The record MUST stay proxied. Grey-cloud it and the apex resolves to an
 * unroutable address with nothing in front of it, and the domain goes dark.
 */
export const APEX_ORIGINLESS_ADDRESS = '192.0.2.0';

/**
 * The legacy board-image URL on www, now externally rewritten to Railway. Its responses carry
 * `cache-control: public, max-age=31536000, immutable` and a matching
 * `CDN-Cache-Control`, but Cloudflare caches by FILE EXTENSION by default and this
 * path has none — so it was measured at `cf-cache-status: DYNAMIC` on 2026-08-25
 * while `/_next/static/*.js` on the same zone was a HIT. Every image byte was
 * therefore transiting Cloudflare to Vercel (~54 GB/day). Keep this rule for
 * released clients and rollback deployments that still request the old shape.
 */
export const BOARD_RENDER_PATH_PREFIX = '/api/internal/board-render';

/** Canonical Railway board-render path emitted by current web clients. */
export const BACKEND_BOARD_RENDER_PATH = '/render/board';

/**
 * Stable marker identifying the one cache rule this tool owns. The apply script
 * finds our rule by this exact description and upserts only it, leaving every other
 * rule in the cache phase untouched. Never change it without a migration — a new
 * value orphans the old rule (the tool would create a second rule and leave the
 * first behind).
 */
export const CACHE_RULE_DESCRIPTION = 'boardsesh:og-edge-cache (managed by scripts/cloudflare-apply.ts)';

/** Marker for the www board-render cache rule. Same never-rename contract as above. */
export const BOARD_RENDER_CACHE_RULE_DESCRIPTION =
  'boardsesh:board-render-edge-cache (managed by scripts/cloudflare-apply.ts)';

/** Marker for the Railway board-render cache rule. Never rename without migrating the live rule. */
export const BACKEND_BOARD_RENDER_CACHE_RULE_DESCRIPTION =
  'boardsesh:backend-board-render-edge-cache (managed by scripts/cloudflare-apply.ts)';

/** Marker for the www list/climb-view HTML cache rule. Never rename without migrating the live rule. */
export const WWW_HTML_CACHE_RULE_DESCRIPTION = 'boardsesh:www-html-edge-cache (managed by scripts/cloudflare-apply.ts)';

/** Markers for the two WAF custom rules. Same never-rename contract as above. */
export const CRAWLER_ALLOW_RULE_DESCRIPTION =
  'boardsesh:allow-search-crawlers (managed by scripts/cloudflare-apply.ts)';
export const CRAWLER_BLOCK_RULE_DESCRIPTION = 'boardsesh:block-seo-scrapers (managed by scripts/cloudflare-apply.ts)';

/**
 * Marker for the board-content managed-challenge rule. Same never-rename
 * contract as above — the STRING still says `climb-view` because renaming it
 * would orphan the live rule and create a second one beside it, even though the
 * rule now also covers `/list` and `/setter/`.
 */
export const BOARD_CONTENT_CHALLENGE_RULE_DESCRIPTION =
  'boardsesh:climb-view-challenge (managed by scripts/cloudflare-apply.ts)';

/** Marker for the climb-view rate-limit rule. Same never-rename contract as above. */
export const CLIMB_VIEW_RATE_LIMIT_RULE_DESCRIPTION =
  'boardsesh:climb-view-rate-limit (managed by scripts/cloudflare-apply.ts)';

/** Marker for the apex → www redirect rule. Same never-rename contract as above. */
export const APEX_REDIRECT_RULE_DESCRIPTION = 'boardsesh:apex-to-www (managed by scripts/cloudflare-apply.ts)';

/** The rulesets phase that holds cache-eligibility rules. */
export const CACHE_RULE_PHASE = 'http_request_cache_settings';

/** The rulesets phase that holds WAF custom rules. */
export const WAF_RULE_PHASE = 'http_request_firewall_custom';

/**
 * The rulesets phase that holds rate-limiting rules.
 *
 * Unlike the cache and WAF phases, a zone that has never carried a rate-limit
 * rule has no entrypoint ruleset here at all. `fetchPhaseRules` already reads a
 * 404 as an empty phase, so the first apply creates it rather than failing.
 */
export const RATE_LIMIT_RULE_PHASE = 'http_ratelimit';

/**
 * The rulesets phase that holds Single Redirects (Cloudflare's "Redirect Rules").
 *
 * Like the rate-limit phase, a zone that has never carried a redirect rule has
 * no entrypoint ruleset here at all; `fetchPhaseRules` reads that 404 as an
 * empty phase and the first apply creates it.
 */
export const DYNAMIC_REDIRECT_RULE_PHASE = 'http_request_dynamic_redirect';

/** Cloudflare SSL/TLS modes ordered weakest → strongest, for the "is the live mode weaker?" check. */
export const SSL_MODE_STRENGTH = ['off', 'flexible', 'full', 'strict'] as const;
export type SslMode = (typeof SSL_MODE_STRENGTH)[number];

/** SSL/TLS mode we require for the zone. `strict` = Full (strict); Flexible causes redirect loops with Railway. */
export const REQUIRED_SSL_MODE: SslMode = 'strict';

interface DnsRecordDesiredBase {
  name: string;
  proxied: boolean;
}

/** A pre-existing record for which this tool owns only Cloudflare's proxy flag. */
export interface ProxyOnlyDnsRecordDesired extends DnsRecordDesiredBase {
  management: 'proxied-only';
}

/** A record whose complete writable DNS shape is owned by this repo. */
export interface FullyManagedDnsRecordDesired extends DnsRecordDesiredBase {
  management: 'full';
  /**
   * `A`/`AAAA` are here for the originless apex, which points at a reserved
   * placeholder address rather than a hostname — see APEX_ORIGINLESS_ADDRESS.
   * `AAAA` stays in the union because Cloudflare documents both placeholder
   * forms; nothing declares one today.
   */
  type: 'A' | 'AAAA' | 'CNAME';
  content: string;
  /** Cloudflare API value 1 means automatic TTL. */
  ttl: number;
  /**
   * Keep the literal CNAME visible so the third-party provider can verify it.
   *
   * Optional, and omitted rather than set to `true` on a PROXIED record:
   * Cloudflare always flattens a proxied CNAME — the public answer is its own
   * anycast address — so `flatten_cname` is not a field we get to own there,
   * and sending it risks a 400 on the record. Leaving it out is also how
   * `diffDnsRecord` is told the field is unmanaged for that record.
   */
  settings?: {
    flatten_cname: false;
  };
}

export type DnsRecordDesired = ProxyOnlyDnsRecordDesired | FullyManagedDnsRecordDesired;

export interface CacheRuleActionParameters {
  /** true = eligible for cache. */
  cache: boolean;
  edge_ttl: {
    /**
     * bypass_by_default = honour Cache-Control when present (og 200s are
     * immutable, 1y) and BYPASS when absent — error responses (400/429/503)
     * send no Cache-Control and must never be edge-cached.
     */
    mode: 'bypass_by_default';
  };
  browser_ttl: {
    /** Honour the origin max-age so a zone-level Browser Cache TTL can't override it. */
    mode: 'respect_origin';
  };
}

export interface CacheRuleDesired {
  description: string;
  expression: string;
  action: 'set_cache_settings';
  action_parameters: CacheRuleActionParameters;
  enabled: boolean;
}

export interface SslDesired {
  mode: SslMode;
}

/**
 * A WAF custom rule. `skip` carries `{ ruleset: 'current' }` — skip every
 * remaining rule in this phase — which is what makes the allow rule a true
 * escape hatch. `block` needs no action parameters.
 */
export interface WafRuleDesired {
  description: string;
  expression: string;
  /**
   * `managed_challenge` is the softest of the three and the only one that can
   * separate a headless fetcher from a person: passing it requires executing
   * JavaScript, which a real browser does transparently. Unlike the rate-limit
   * phase — where the Free plan refused it outright (see the note on
   * RateLimitRuleDesired) — custom rules accept it on every plan.
   */
  action: 'block' | 'skip' | 'managed_challenge';
  action_parameters?: { ruleset: 'current' };
  enabled: boolean;
}

/**
 * A Cloudflare rate-limiting rule (the `http_ratelimit` phase).
 *
 * `action` is deliberately a union rather than a constant because the softest
 * option is plan-gated: `log` observes without mitigating anything, which is
 * what you want while sizing a threshold against real traffic, but Cloudflare
 * restricts it to Enterprise. On lower plans the gentlest available action is
 * `managed_challenge` — a real browser passes it transparently, a headless
 * farm mostly does not — and `block` is the blunt instrument. Changing the
 * mitigation is a one-word edit to the declared rule below.
 *
 * `characteristics` is what the counter is keyed on. `cf.colo.id` is required
 * by Cloudflare on non-Enterprise plans and makes the budget per-datacentre
 * rather than global, so the effective allowance is somewhat higher than
 * `requests_per_period` suggests.
 */
export interface RateLimitRuleDesired {
  description: string;
  expression: string;
  action: 'log' | 'managed_challenge' | 'block';
  ratelimit: {
    characteristics: string[];
    /** Counting window in seconds. */
    period: number;
    /** Requests allowed per key per `period` before the action fires. */
    requests_per_period: number;
    /** How long the action keeps firing for a key that went over, in seconds. */
    mitigation_timeout: number;
  };
  enabled: boolean;
}

/**
 * A Cloudflare Single Redirect (the `http_request_dynamic_redirect` phase).
 *
 * The nesting is Cloudflare's, not ours: the redirect payload sits under
 * `action_parameters.from_value`, and `target_url` is a one-key object that is
 * EITHER `{ value }` for a fixed destination or `{ expression }` for one built
 * from the request. A rule carrying both is rejected.
 *
 * `preserve_query_string` is what keeps the query string, so the expression only
 * has to rebuild the path. Cloudflare's rules language has no ternary operator,
 * so hand-assembling `?…` inside the expression is not an option anyway.
 */
export interface RedirectRuleDesired {
  description: string;
  expression: string;
  action: 'redirect';
  action_parameters: {
    from_value: {
      /** 301 = permanent. Search engines fold the apex into www rather than treating both as live. */
      status_code: 301;
      target_url: { expression: string };
      preserve_query_string: boolean;
    };
  };
  enabled: boolean;
}

export interface CloudflareDesiredState {
  zoneName: string;
  dnsRecords: DnsRecordDesired[];
  /** Order is not significant: cache rules are matched by expression, not precedence. */
  cacheRules: CacheRuleDesired[];
  /**
   * Order IS significant and is preserved on apply: the allow rule must be
   * evaluated before the block rule, or a token collision would take out a
   * search engine. See upsertManagedRules in ./plan.
   */
  wafRules: WafRuleDesired[];
  /**
   * Order is not significant: each rate-limit rule counts independently, and
   * Cloudflare evaluates every matching rule rather than stopping at the first.
   */
  rateLimitRules: RateLimitRuleDesired[];
  /** Order is not significant: Cloudflare stops at the first matching redirect and there is only one. */
  redirectRules: RedirectRuleDesired[];
  ssl: SslDesired;
}

/** The Cloudflare Rules-language expression matching og share-card requests on the ws host. */
export const OG_CACHE_EXPRESSION = `(http.host eq "${WS_HOSTNAME}" and starts_with(http.request.uri.path, "${OG_PATH_PREFIX}"))`;

/** Board-image renders on www. Host-scoped so a future origin on another hostname can't inherit it silently. */
export const BOARD_RENDER_CACHE_EXPRESSION = `(http.host eq "${WWW_HOSTNAME}" and starts_with(http.request.uri.path, "${BOARD_RENDER_PATH_PREFIX}"))`;

/** Canonical and released Live Activity Railway renders; adjacent REST and GraphQL routes stay dynamic. */
export const BACKEND_BOARD_RENDER_CACHE_EXPRESSION = `(http.host eq "${WS_HOSTNAME}" and (http.request.uri.path eq "${BACKEND_BOARD_RENDER_PATH}" or http.request.uri.path eq "${BOARD_RENDER_PATH_PREFIX}"))`;

/**
 * Locale path prefixes on www, in the shape a Cloudflare expression sees them.
 *
 * The empty string is en-US, which is served UNPREFIXED (see `detectLocale` in
 * packages/web/app/lib/i18n/detect-locale.ts — it skips DEFAULT_LOCALE). The
 * other three are real path prefixes, and the middleware strips them before it
 * decides whether to decorate the response, so `/es/kilter/…/list` gets the
 * same CDN-Cache-Control as `/kilter/…/list`. Cloudflare has no way to strip a
 * prefix, so the prefixes are enumerated here instead.
 */
export const WWW_HTML_CACHE_LOCALE_PREFIXES = ['', '/es', '/fr', '/de'] as const;

/**
 * The first path segment of every page tree that renders a board list or climb
 * view: `b` for the slug tree (`/b/{board_slug}/{angle}/…`) plus one segment per
 * board for the legacy numeric tree (`/{board}/{layout}/{size}/{sets}/{angle}/…`).
 *
 * Mirrors SUPPORTED_BOARDS in packages/shared-schema/src/types/board-config.ts,
 * which is what `getListPageCacheTTL` / `getClimbViewPageCacheTTL` test the first
 * segment against. It is duplicated rather than imported because
 * infra/cloudflare is declarative data with no workspace dependencies, and
 * because the web list is feature-flag-gated at runtime (MoonBoard) while a
 * desired-state file has to be deterministic. A test reads the schema file and
 * fails if a board is added there and not here — a missed board only costs the
 * cache, but it costs it silently.
 */
export const WWW_HTML_CACHE_ROOT_SEGMENTS = [
  'b',
  'kilter',
  'tension',
  'moonboard',
  'decoy',
  'touchstone',
  'grasshopper',
  'soill',
  'woods',
] as const;

/** Path suffix of every list page (`getListPageCacheTTL` fast-paths on exactly this). */
export const LIST_PAGE_PATH_SUFFIX = '/list';

/** Path segment every climb-view URL shape shares, in both trees and all four locales. */
export const CLIMB_VIEW_PATH_SEGMENT = '/view/';

/**
 * Setter front doors. A `contains` rather than a `starts_with` so the `/de`,
 * `/es` and `/fr` twins are covered by the same clause — Cloudflare cannot
 * strip a locale prefix, and enumerating the cross product here would drift
 * from the locale list.
 */
export const SETTER_PATH_SEGMENT = '/setter/';

/**
 * The substring shared by every name the NextAuth session cookie can carry.
 *
 * Production writes `__Secure-next-auth.session-token`; a non-HTTPS context
 * writes the bare `next-auth.session-token`, which the read paths still honour
 * (see sessionCookieNameCandidates in packages/web/app/lib/auth/secure-cookies.ts);
 * an oversized session is split into `<name>.0`, `<name>.1`, … Every one of
 * those contains this substring, so one `http.cookie contains` clause covers the
 * lot — including a chunked cookie, which an equality test would miss.
 */
export const SESSION_COOKIE_NAME_SUBSTRING = 'next-auth.session-token';

/**
 * Next's React Server Component request header, lowercased (Cloudflare
 * lowercases the keys of `http.request.headers`).
 *
 * Measured against production on 2026-09-02: `RSC: 1` on a list page returns a
 * **307 to `?_rsc`** that carries `CDN-Cache-Control: s-maxage=86400,
 * stale-while-revalidate=604800` and NO `Cache-Control` — i.e. a redirect the
 * edge would happily store for a day. `RSC: 2` and an empty `RSC:` both return
 * the ordinary 200 HTML, so `1` is today's only trigger; the rule bypasses on
 * ANY non-empty value so a Next.js change cannot quietly reopen it.
 *
 * The response's `Vary: rsc, next-router-state-tree, next-router-prefetch,
 * next-router-segment-prefetch, Accept-Encoding` does NOT save us: Cloudflare
 * honours Vary for Accept-Encoding only below Enterprise and ignores the rest,
 * so the 307 and the HTML document share one cache key. That is the failure
 * this clause exists to prevent, and `list-page-cache.ts` already carries the
 * matching warning from #4592 — a cacheable redirect loop at this TTL pins for
 * a full day.
 *
 * The other three Vary'd headers need no clause of their own: sent WITHOUT
 * `RSC`, each was measured returning the byte-identical anonymous HTML, and
 * Next's router never sends them without `RSC: 1`.
 */
export const RSC_REQUEST_HEADER_NAME = 'rsc';

/** The query parameter Next appends to RSC fetches, and the target of that 307. */
export const RSC_QUERY_PARAM = '_rsc';

/** Every `{locale}{root}` path prefix the middleware decorates, as Cloudflare sees it. */
export function buildWwwHtmlCachePathPrefixes(): string[] {
  return WWW_HTML_CACHE_LOCALE_PREFIXES.flatMap((localePrefix) =>
    WWW_HTML_CACHE_ROOT_SEGMENTS.map((rootSegment) => `${localePrefix}/${rootSegment}/`),
  );
}

/**
 * List and climb-view HTML on www — the surface `packages/web/middleware.ts`
 * decorates with `CDN-Cache-Control: s-maxage=86400, stale-while-revalidate=604800`
 * (TTLs from app/lib/list-page-cache.ts).
 *
 * Those headers have been inert since www moved behind this proxy: measured
 * 2026-09-02, a logged-out list page returns the header and
 * `cf-cache-status: DYNAMIC`, because Cloudflare caches by file extension by
 * default and an HTML page route has none. Every crawler hit re-renders at the
 * single us-west2 Railway replica against Postgres. This rule is what makes the
 * origin's own declared TTL take effect.
 *
 * Read as five ANDed gates:
 *
 * 1. `http.host` — www only. ws, assets, app and updates keep serving themselves.
 * 2. Shape — a `/list` suffix or a `/view/` segment, the two things
 *    `getListPageCacheTTL` and `getClimbViewPageCacheTTL` key on. Cloudflare
 *    cannot count path segments without `matches`, which needs a Business plan,
 *    so the segment-count half of those functions is not reproduced; the origin
 *    still applies it, and gate 5 defers to the origin.
 * 3. Prefix — the full {locale} × {board tree root} cross product, because the
 *    middleware tests the first segment of the LOCALE-STRIPPED path and
 *    Cloudflare cannot strip. Enumerated rather than loosened so a future www
 *    route that happens to end in `/list` and sets its own public max-age
 *    cannot inherit this rule.
 * 4. Bypasses — session cookie, RSC header, `?_rsc`. See the constants above.
 *    `Vary` is not a substitute for any of them: Cloudflare ignores it except
 *    for Accept-Encoding.
 * 5. `edge_ttl: bypass_by_default` on the rule itself, which is the real
 *    guarantee: a response with no cacheable directive never enters the edge.
 *    A list page carrying a user-specific filter (`?onlyDrafts=true`,
 *    `?minUserRating=4`) was measured returning `Cache-Control: private,
 *    no-cache, no-store` and NO `CDN-Cache-Control`, so it bypasses without the
 *    expression having to enumerate USER_SPECIFIC_SEARCH_PARAMS.
 *
 * Not bypassed on purpose: the legacy numeric `/view/` URLs that 308 to their
 * slug form. Caching that deterministic redirect is the point — see the comment
 * on CLIMB_VIEW_PAGE_CACHE_TTL_SECONDS in list-page-cache.ts.
 */
export const WWW_HTML_CACHE_EXPRESSION =
  `(http.host eq "${WWW_HOSTNAME}"` +
  ` and (http.request.uri.path contains "${CLIMB_VIEW_PATH_SEGMENT}"` +
  ` or ends_with(http.request.uri.path, "${LIST_PAGE_PATH_SUFFIX}")` +
  ` or http.request.uri.path contains "${CLIMB_VIEW_PATH_SEGMENT}")` +
  ` and (${buildWwwHtmlCachePathPrefixes()
    .map((pathPrefix) => `starts_with(http.request.uri.path, "${pathPrefix}")`)
    .join(' or ')})` +
  ` and not (http.cookie contains "${SESSION_COOKIE_NAME_SUBSTRING}")` +
  ` and not (any(http.request.headers["${RSC_REQUEST_HEADER_NAME}"][*] != ""))` +
  ` and not (http.request.uri.query contains "${RSC_QUERY_PARAM}"))`;

/**
 * Search engines and social unfurlers that must never be blocked. Brave runs its
 * OWN index (not a Bing/Google reseller), so losing it loses real coverage — it is
 * listed explicitly rather than assumed.
 *
 * Cloudflare's `cf.client.bot` "verified bot" signal is deliberately NOT used here:
 * AhrefsBot and SemrushBot are themselves verified bots, so that field is true for
 * precisely the crawlers CRAWLER_BLOCK_TOKENS exists to stop.
 */
export const CRAWLER_ALLOW_TOKENS = [
  'googlebot',
  'google-inspectiontool',
  'storebot-google',
  'google-pagerenderer',
  'bingbot',
  'bingpreview',
  'duckduckbot',
  'brave-search',
  'bravebot',
  'applebot',
  // Added 2026-09-11 with the climb-view challenge below. Both send people back
  // (Baidu 7, Qwant 1 over 30 days) and neither was on either list, so they
  // passed by default — which stopped working the moment an unlisted agent
  // started getting challenged.
  'baiduspider',
  'qwantify',
  // Share-card unfurlers. Blocking these breaks link previews, not crawling —
  // and so does CHALLENGING them, which is how climb previews broke on
  // 2026-09-11. None of these execute JavaScript, so a managed challenge is an
  // unconditional fail for every one of them. Extended the same day from the
  // original seven after Signal, Bluesky, Mastodon and Teams were all measured
  // getting `403 cf-mitigated: challenge` on a climb page.
  'twitterbot',
  'facebookexternalhit',
  'slackbot',
  'discordbot',
  'linkedinbot',
  'telegrambot',
  'whatsapp',
  'signalbot',
  'cardyb',
  'mastodon',
  'microsoftpreview',
  'skypeuripreview',
  'redditbot',
  'pinterest',
  'vkshare',
  'embedly',
  'iframely',
  'nuzzel',
  'quora link preview',
] as const;

/**
 * Commercial SEO/backlink crawlers. Each was verified reaching our origin on
 * 2026-08-24 by the #4716 probe. They sell backlink data and send Boardsesh no
 * traffic, so they are pure cost: page render, DB reads, and (before #4650's warm
 * gate) a 3 GB board-render invocation each.
 *
 * `dotbot/` keeps its slash because the bare token is short enough to collide with
 * an unrelated UA; the rest are distinctive on their own.
 *
 * Yandex is here rather than in the allow list: 2026-09-10 origin logs put it at
 * 36% of www requests against 3.6% for real browsers, on the most expensive SSR
 * path we have. See COST_BLOCKED_CRAWLER_TOKENS in crawler-policy.ts.
 *
 * AI training/search crawlers are explicit too: September 7 origin logs showed
 * Claude-SearchBot on www and GPTBot bypassing Cloudflare via the Railway domain,
 * despite synthetic probes receiving 403. The shared list also drives robots.txt
 * and the web origin's early rejection. Do not rely on the unmanaged AI rule.
 *
 * NOT listed, on purpose:
 * - `archive.org_bot` — it reaches us and it loops, but it is the Internet Archive,
 *   it is low volume, and excluding it is a values call rather than a cost one.
 */
export const CRAWLER_BLOCK_TOKENS = [
  ...BLOCKED_CRAWLER_TOKENS,
  'ahrefsbot',
  'ahrefssiteaudit',
  'semrushbot',
  'dataforseobot',
  'mj12bot',
  'dotbot/',
  'blexbot',
  'barkrowler',
  'serpstatbot',
  'seznambot',
  'zoominfobot',
  'screaming frog',
] as const;

/**
 * Build a user-agent alternation. `lower()` is load-bearing: Cloudflare's `contains`
 * is CASE-SENSITIVE, so a bare `contains "AhrefsBot"` silently misses `ahrefsbot`
 * and the rule looks installed while matching nothing.
 */
export function buildUserAgentExpression(tokens: readonly string[]): string {
  return tokens.map((token) => `lower(http.user_agent) contains "${token}"`).join(' or ');
}

/**
 * Scoped to GET on purpose.
 *
 * The allow rule's action is `skip` with `ruleset: 'current'`, so an agent that
 * matches it walks past every later rule in the WAF custom ruleset. That is the
 * intent for reads — a search engine must never be caught by a rule aimed at
 * scrapers — but it also meant an allow-listed agent could never be constrained
 * on a write, and no rule added after this one would apply to it.
 *
 * A crawler has no legitimate POST. Applebot has one: it executes our
 * JavaScript, and a 2026-09-10 sample of boardsesh-web caught it sending 190 of
 * its 253 requests as `POST /monitoring` (the Sentry tunnel from
 * next.config.mjs). The origin-side fix for that ships in
 * instrumentation-client.ts; this gate is what keeps the ruleset composable, so
 * the next rule aimed at bot writes is actually reachable.
 *
 * HEAD is not included: crawlers that HEAD a URL before fetching it are doing a
 * read, but nothing in this ruleset blocks them today, so widening the skip
 * would buy nothing.
 */
export const CRAWLER_ALLOW_EXPRESSION = `(http.request.method eq "GET" and (${buildUserAgentExpression(
  CRAWLER_ALLOW_TOKENS,
)}))`;
export const CRAWLER_BLOCK_EXPRESSION = buildUserAgentExpression(CRAWLER_BLOCK_TOKENS);

/**
 * Climb-view pages on www, across every URL shape that renders one.
 *
 * Deliberately a `/view/` path match rather than an enumeration of the route
 * trees: the config-tuple tree, the `/b/{slug}` short tree and the `/de`,
 * `/es` and `/fr` locale prefixes all render the same expensive SSR, and a
 * pattern per tree would silently miss whichever one is added next. Nothing
 * else on www uses a `/view/` segment.
 *
 * Host-scoped so a future origin on another hostname cannot inherit it.
 *
 * Host + path only — no header check. A prefetch-exclusion clause
 * (`http.request.headers.names[*] == "next-router-prefetch"`) shipped here
 * once and production apply rejected it: `not entitled: the use of field
 * http.request.headers.names is not allowed, an higher Advanced Rate
 * Limiting plan is required`. The Free plan's rate-limit expressions cannot
 * reference request headers at all, so Next.js router prefetches off a list
 * page are counted along with real page loads. That is why the threshold
 * below carries headroom rather than a tight ~60/min budget.
 */
export const CLIMB_VIEW_SURFACE_EXPRESSION = `(http.host eq "${WWW_HOSTNAME}" and http.request.uri.path contains "/view/")`;

/** The rate limit and the challenge deliberately cover the same surface. */
export const CLIMB_VIEW_RATE_LIMIT_EXPRESSION = CLIMB_VIEW_SURFACE_EXPRESSION;

/**
 * Managed-challenge the climb-view surface for anything the allow rule did not
 * already wave through.
 *
 * **Why a challenge and not a UA rule or a tighter rate limit.** The population
 * this exists for rotates user agents: a 3.6-minute sample of production on
 * 2026-09-11 found nine ordinary Chrome, Edge and Safari strings at roughly 45
 * requests each, walking 350 climb pages across all four locales. No allow or
 * block list can name it. The rate limit cannot reach it either — it runs about
 * 12 requests a minute per agent against a Free-plan floor of 60 per 10 s
 * (~360/min), and lowering the threshold far enough to catch it would take out
 * a gym behind one NAT, which is exactly the failure the rate-limit rule's own
 * comment warns about.
 *
 * **What it can be caught by.** In that same sample those nine agents fetched
 * 350 HTML pages and **zero** JavaScript — not one `/_next/static` chunk, not
 * one Sentry tunnel POST. The one real visitor in the window did the mirror
 * image: 33 chunks and no climb pages. A managed challenge is precisely that
 * test, so it separates the two with no list to maintain.
 *
 * **Who never sees it.** The allow rule is first and its action is `skip` over
 * the current ruleset, so every search engine and share unfurler on
 * CRAWLER_ALLOW_TOKENS bypasses this. That is why `baiduspider` and `qwantify`
 * were added there in the same change: they send people back and were relying
 * on passing by default, which this rule ends.
 *
 * **What it costs.** A first-time human visitor landing on a climb page from
 * search gets one sub-second check, then a `cf_clearance` cookie covers them.
 * At roughly 30-50 real web visitors a day that is a small price for dropping
 * the majority of origin renders.
 *
 * Deliberately NOT excluding signed-in visitors on a session-cookie check. The
 * WAF can only test that a cookie NAME is present, so `Cookie:
 * <session-name>=anything` would be a one-line bypass for the scraper. The
 * clearance cookie already keeps a logged-in climber from being re-challenged.
 *
 * **Broadened from `/view/` alone to `/view/` + `/list` + `/setter/` three
 * hours after it shipped, because the farm did not leave — it moved.** Same
 * nine rotating strings, measured 2026-09-11 08:34-08:53 UTC (n=501): zero
 * climb-view requests, and instead 102 `/setter/` and 67 `/list`, 81% of what
 * it still sends. `/list` is the expensive half at 395 ms average against
 * `/setter/`'s 167 ms.
 *
 * **Then `/view/` came back OUT the same day, because it broke link previews.**
 * A climb page is the thing people share, and an unfurler reads its `og:image`
 * tag. No unfurler executes JavaScript, so a managed challenge is an
 * unconditional fail for every one of them — measured on a live climb page:
 * Slackbot, Discordbot, Twitterbot, facebookexternalhit, WhatsApp and Applebot
 * passed only because they are on CRAWLER_ALLOW_TOKENS, while Signal, Bluesky,
 * Mastodon, Teams and a plain Safari string all got `403 cf-mitigated:
 * challenge` and never saw the tag.
 *
 * That is structural, not a tuning problem: **you cannot JavaScript-challenge a
 * page you want people to share**, because naming every unfurler that will ever
 * exist is not a list anyone can finish. The allow list was widened anyway so
 * the common ones survive if `/view/` is ever re-challenged, but the durable
 * answer is to leave shareable surfaces out of this rule.
 *
 * It costs nothing today: the farm had already abandoned `/view/` entirely by
 * the 08:34 sample. If it returns there, the lever is a non-JavaScript signal,
 * not this one.
 *
 * The homepage is deliberately still NOT challenged. The farm hit it 8 times
 * in that window, and it is the one page a real first-time visitor is most
 * likely to land on before any clearance cookie exists.
 *
 * `/setter/` is a `contains`, not a `starts_with`, so the `/de`, `/es` and
 * `/fr` twins come along; Cloudflare cannot strip a locale prefix. `/list`
 * keeps `ends_with` to match the cache rule's definition of the same surface.
 */
export const BOARD_CONTENT_CHALLENGE_EXPRESSION =
  `(http.host eq "${WWW_HOSTNAME}"` +
  ` and (ends_with(http.request.uri.path, "${LIST_PAGE_PATH_SUFFIX}")` +
  ` or http.request.uri.path contains "${SETTER_PATH_SEGMENT}"))`;

/**
 * The apex, and only the apex. `http.host` is the request's Host header, so this
 * never matches www, ws, assets, app or updates — each of which is a different
 * host on the same zone and must keep serving itself.
 */
export const APEX_REDIRECT_EXPRESSION = `http.host eq "${APEX_HOSTNAME}"`;

/**
 * The destination, rebuilt per request so `/kilter/…` lands on the same page
 * under www rather than on the homepage.
 *
 * Only the path is concatenated: `preserve_query_string: true` on the rule
 * appends the original query string, which is both simpler and the shape
 * Cloudflare documents. `http.request.uri.path` always starts with `/`, so a
 * bare `https://boardsesh.com` redirects to `https://www.boardsesh.com/`.
 */
export const APEX_REDIRECT_TARGET_EXPRESSION = `concat("https://${WWW_HOSTNAME}", http.request.uri.path)`;

/** Public custom domain for the R2 user-media bucket. */
export const MEDIA_HOSTNAME = 'media.boardsesh.com';

/**
 * R2 buckets this repo owns, and whether each one is public.
 *
 * `customDomain` is the entire access-control story for an R2 bucket. R2
 * implements no object ACLs and no bucket policies, so there is no way to make
 * one prefix private: attaching a custom domain publishes EVERY object in the
 * bucket. That is why user data exports live in their own bucket rather than
 * under a prefix, and why `customDomain: null` is a hard assertion here rather
 * than a default — the apply fails if such a bucket ever grows a domain.
 *
 * Buckets are created when absent and NEVER deleted by this tool. Deleting
 * object storage is not something a converge loop should be able to do.
 */
export interface R2BucketDesired {
  name: string;
  /** Hostname serving this bucket publicly, or null when it must stay unreachable. */
  customDomain: string | null;
  /**
   * Cloudflare location hint, applied only at creation time and immutable
   * afterwards. Omitted lets Cloudflare choose on first write.
   */
  locationHint?: 'apac' | 'eeur' | 'enam' | 'oc' | 'weur' | 'wnam';
}

export const desiredR2Buckets: readonly R2BucketDesired[] = [
  // Avatars, gym images, beta-link thumbnails and every resize variant.
  { name: 'boardsesh-user-media', customDomain: MEDIA_HOSTNAME },
  // User data exports and MoonBoard OCR submissions. MUST stay domain-less.
  { name: 'boardsesh-user-private', customDomain: null },
];

export const desiredCloudflareState: CloudflareDesiredState = {
  zoneName: ZONE_NAME,
  dnsRecords: [
    {
      management: 'proxied-only',
      name: WS_HOSTNAME,
      proxied: true,
    },
    {
      management: 'full',
      name: ASSETS_HOSTNAME,
      type: 'CNAME',
      content: ASSETS_CNAME_TARGET,
      ttl: 1,
      proxied: false,
      settings: {
        flatten_cname: false,
      },
    },
    // www points at the Railway web service (#4655, epic #4648). It landed here
    // first as proxy-only, orange-cloud-only ownership of a record that still
    // pointed at Vercel; this entry is the flip that took ownership of the
    // target too and PATCHed it onto Railway. The apex → www redirect (#5027)
    // must already be live before this record is applied, or the apex briefly
    // has nothing behind it. No `settings`: Cloudflare always flattens a
    // proxied CNAME, so flatten_cname is not a field this record can own (see
    // FullyManagedDnsRecordDesired.settings). See the "Flipping www to a new
    // origin" section of docs/cloudflare.md for the full mechanics and rollback.
    {
      management: 'full',
      name: WWW_HOSTNAME,
      type: 'CNAME',
      content: WWW_RAILWAY_CNAME_TARGET,
      ttl: 1,
      proxied: true,
    },
    // The apex is originless: it exists so Cloudflare terminates the request and
    // the apex → www redirect rule below answers it. Until now it was a DNS-only
    // A record to Vercel (76.76.21.21) and VERCEL served the apex → www 308;
    // converging this record takes Vercel out of that path entirely.
    //
    // `A` deliberately matches the type the live record already has, so the
    // apply is an in-place update of content + the proxied flag rather than a
    // type change — see APEX_ORIGINLESS_ADDRESS.
    {
      management: 'full',
      name: APEX_HOSTNAME,
      type: 'A',
      content: APEX_ORIGINLESS_ADDRESS,
      ttl: 1,
      // Load-bearing. Grey-clouded, this record answers with an unroutable
      // address and boardsesh.com stops resolving to anything that serves.
      proxied: true,
    },
  ],
  cacheRules: [
    {
      description: CACHE_RULE_DESCRIPTION,
      expression: OG_CACHE_EXPRESSION,
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'bypass_by_default' },
        // Pin browser TTL to the origin header so a zone-level Browser Cache TTL
        // can't override the 1y immutable max-age.
        browser_ttl: { mode: 'respect_origin' },
      },
      enabled: true,
    },
    {
      description: BOARD_RENDER_CACHE_RULE_DESCRIPTION,
      expression: BOARD_RENDER_CACHE_EXPRESSION,
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        // Same reasoning as the og rule: a successful render is immutable for a
        // year, while a 503 from the render semaphore's load-shedding path sends
        // `Cache-Control: no-store` and a 400 sends none at all. bypass_by_default
        // caches the first and never the others.
        edge_ttl: { mode: 'bypass_by_default' },
        browser_ttl: { mode: 'respect_origin' },
      },
      enabled: true,
    },
    {
      description: BACKEND_BOARD_RENDER_CACHE_RULE_DESCRIPTION,
      expression: BACKEND_BOARD_RENDER_CACHE_EXPRESSION,
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        edge_ttl: { mode: 'bypass_by_default' },
        browser_ttl: { mode: 'respect_origin' },
      },
      enabled: true,
    },
    // The www HTML pages the middleware already marks CDN-cacheable (#4652).
    // Without this rule those headers are inert — Cloudflare caches by file
    // extension by default, so a page route measured `cf-cache-status: DYNAMIC`
    // while sending `s-maxage=86400`, and every crawler hit re-rendered at the
    // single Railway replica. See WWW_HTML_CACHE_EXPRESSION for what each gate
    // in the expression is holding back.
    {
      description: WWW_HTML_CACHE_RULE_DESCRIPTION,
      expression: WWW_HTML_CACHE_EXPRESSION,
      action: 'set_cache_settings',
      action_parameters: {
        cache: true,
        // Load-bearing, and the reason the expression does not have to
        // enumerate every dynamic case. Next overwrites `Cache-Control` with
        // `private, no-cache, no-store` on these routes and the middleware adds
        // `CDN-Cache-Control` alongside it, which Cloudflare ranks higher; a
        // genuinely dynamic response (a user-specific filter, the sticky-locale
        // 307) reaches the edge with NO CDN-Cache-Control and so bypasses on
        // its own. `override_origin` would be the dangerous setting here: it
        // ignores the origin AND strips Set-Cookie in order to cache.
        edge_ttl: { mode: 'bypass_by_default' },
        browser_ttl: { mode: 'respect_origin' },
      },
      enabled: true,
    },
  ],
  wafRules: [
    // MUST stay first — see the ordering contract on CloudflareDesiredState.wafRules.
    {
      description: CRAWLER_ALLOW_RULE_DESCRIPTION,
      expression: CRAWLER_ALLOW_EXPRESSION,
      action: 'skip',
      action_parameters: { ruleset: 'current' },
      enabled: true,
    },
    {
      description: CRAWLER_BLOCK_RULE_DESCRIPTION,
      expression: CRAWLER_BLOCK_EXPRESSION,
      action: 'block',
      enabled: true,
    },
    // MUST stay last. It is the only rule here that can catch an ordinary
    // browser string, so every agent we have an opinion about — allowed or
    // blocked — has to be judged before it.
    {
      description: BOARD_CONTENT_CHALLENGE_RULE_DESCRIPTION,
      expression: BOARD_CONTENT_CHALLENGE_EXPRESSION,
      action: 'managed_challenge',
      enabled: true,
    },
  ],
  rateLimitRules: [
    {
      description: CLIMB_VIEW_RATE_LIMIT_RULE_DESCRIPTION,
      expression: CLIMB_VIEW_RATE_LIMIT_EXPRESSION,
      // The Free plan allows exactly one rate-limit action: `block`. Every
      // gentler option was rejected at apply time — `log` (Enterprise-only)
      // and `managed_challenge` (`not entitled to use the managed_challenge
      // action in ratelimiting`). So the threshold below is deliberately
      // generous: it is sized to catch a single-IP bulk crawler, not to
      // shave a busy gym's traffic, because a block — even a 10 s one —
      // is exactly the failure mode that throttles climbers behind one NAT.
      // Roll back by flipping `enabled: false` and re-applying.
      action: 'block',
      ratelimit: {
        characteristics: ['ip.src', 'cf.colo.id'],
        // The zone is confirmed FREE plan: the production apply of period: 60
        // failed with `not entitled to use the period 60, can only use a
        // period among [10]` — 10s is the only period Free accepts.
        period: 10,
        // 60 per 10 s per IP per colo (≈360/min sustained). A bulk crawler
        // sustaining 6 req/s from one address trips it; a gym behind one NAT
        // would need 60 climb-page loads (prefetches included — the Free
        // plan cannot exclude them, see the expression note) inside 10 s, and
        // is then blocked for 10 s, not challenged.
        requests_per_period: 60,
        // 10s is the Free-plan ceiling (Pro allows up to 60s). Raise to 60
        // once the zone's plan is confirmed Pro or above.
        mitigation_timeout: 10,
      },
      enabled: true,
    },
  ],
  redirectRules: [
    {
      description: APEX_REDIRECT_RULE_DESCRIPTION,
      expression: APEX_REDIRECT_EXPRESSION,
      action: 'redirect',
      action_parameters: {
        from_value: {
          status_code: 301,
          target_url: { expression: APEX_REDIRECT_TARGET_EXPRESSION },
          preserve_query_string: true,
        },
      },
      enabled: true,
    },
  ],
  ssl: {
    mode: REQUIRED_SSL_MODE,
  },
};
