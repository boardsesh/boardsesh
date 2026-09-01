/// <reference types="node" />

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
// 2. www.boardsesh.com is the Vercel-backed marketing/SEO surface, and the two rules
//    below are cost controls for it (#4650, epic #4648). Measured 2026-08-25:
//    ~442,600 Vercel function invocations/day, of which /api/internal/board-render
//    was ~215,600 and the climb-view page ~203,900, against a published sitemap of
//    only ~60k URLs and ~2,000 homepage hits. See docs/cloudflare.md.
//    Its DNS record is managed here too — proxy flag only, for now — so the
//    Vercel → Railway origin flip is a reviewable diff rather than a dashboard
//    click (#4655).
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

/** The Vercel-backed www origin whose crawl cost these rules exist to cap. */
export const WWW_HOSTNAME = 'www.boardsesh.com';

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

/** Markers for the two WAF custom rules. Same never-rename contract as above. */
export const CRAWLER_ALLOW_RULE_DESCRIPTION =
  'boardsesh:allow-search-crawlers (managed by scripts/cloudflare-apply.ts)';
export const CRAWLER_BLOCK_RULE_DESCRIPTION = 'boardsesh:block-seo-scrapers (managed by scripts/cloudflare-apply.ts)';

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
  action: 'block' | 'skip';
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
  // Share-card unfurlers. Blocking these breaks link previews, not crawling.
  'twitterbot',
  'facebookexternalhit',
  'slackbot',
  'discordbot',
  'linkedinbot',
  'telegrambot',
  'whatsapp',
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
 * NOT listed, on purpose:
 * - The AI crawlers (ClaudeBot, GPTBot, PerplexityBot, Bytespider, CCBot, ...) —
 *   the same probe got `HTTP/2 403` from `server: cloudflare` for every one, so a
 *   separate zone rule already stops them and duplicating it here would be dead
 *   config that drifts.
 * - `archive.org_bot` — it reaches us and it loops, but it is the Internet Archive,
 *   it is low volume, and excluding it is a values call rather than a cost one.
 */
export const CRAWLER_BLOCK_TOKENS = [
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

export const CRAWLER_ALLOW_EXPRESSION = buildUserAgentExpression(CRAWLER_ALLOW_TOKENS);
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
export const CLIMB_VIEW_RATE_LIMIT_EXPRESSION = `(http.host eq "${WWW_HOSTNAME}" and http.request.uri.path contains "/view/")`;

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
    // www is proxied today and points at Vercel, by hand, in the dashboard. This
    // repo takes over only the orange cloud for now, which is a no-op against
    // the live record and gives the Vercel → Railway origin flip (#4655, epic
    // #4648) a single line to change instead of a dashboard click. See the
    // "Flipping www to a new origin" section of docs/cloudflare.md for the exact
    // edit and its rollback.
    {
      management: 'proxied-only',
      name: WWW_HOSTNAME,
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
