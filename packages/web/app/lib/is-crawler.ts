/**
 * Crawler classification for the two sticky-locale gates in `middleware.ts`.
 *
 * `next/server` exposes `userAgent(request).isBot`, and #4667 used it. Two
 * problems with that:
 *
 * 1. `userAgent()` is `{ ...uaparser(input), isBot: isBot(input) }` — the full
 *    ua-parser-js parse runs on every matched request just to read one boolean.
 *    `isBot` itself is not re-exported from `next/server` (see
 *    `next/server.d.ts`, which exports only `userAgent` and
 *    `userAgentFromString`), so there is no cheap way to reach it. Importing
 *    `next/dist/server/web/spec-extension/user-agent` directly does resolve
 *    today, but that is a deep import into Next internals with no stability
 *    guarantee, so the tokens are inlined below instead and a test pins the
 *    superset property against the installed copy.
 * 2. Next's list names no scraper newer than ~2023, so the crawlers that
 *    actually still loop through our locale twins walk straight past it.
 *
 * Probed against production on 2026-08-24 with
 * `curl -sSI -A '<ua>' -H 'Cookie: boardsesh-locale=es' https://www.boardsesh.com/<climb-view-url>`:
 * AhrefsBot, AhrefsSiteAudit, SemrushBot, DataForSeoBot, MJ12bot, DotBot,
 * BLEXBot, Barkrowler, serpstatbot, SeznamBot, ZoominfoBot, Screaming Frog and
 * archive.org_bot all reached the origin and all got the 307 to the /es twin,
 * while Googlebot (named by Next) correctly got a 200. Those thirteen are the
 * extension list.
 *
 * Deliberately NOT listed: the AI crawlers (ClaudeBot, Claude-User,
 * PerplexityBot, GPTBot, OAI-SearchBot, ChatGPT-User, Bytespider, Amazonbot,
 * CCBot, PetalBot, meta-externalagent). The same probe returned `HTTP/2 403`
 * from `server: cloudflare` with no `x-vercel-cache` header for every one of
 * them — Cloudflare's AI-bot block stops them before Vercel, so a middleware UA
 * regex can never see them and adding them would be dead code. Re-run the probe
 * and revisit this list if that Cloudflare rule is ever relaxed, and as part of
 * the Railway cutover (#4652), which moves the edge.
 *
 * `Google-Extended` is also absent on purpose: it is a robots.txt-only opt-out
 * control token and never appears in a User-Agent header.
 *
 * Two things this cannot do, both fine:
 * - A false positive is graceful. The visitor gets a default-locale 200 for the
 *   URL they actually asked for, which is already the deliberate behaviour of
 *   the bot branch, not an error page. Every token below is crawler-only — no
 *   bare `bot`, `spider` or `crawler` alternative — so a device-model string
 *   cannot trip it.
 * - It cannot catch a UA-rotating headless farm. One walked ~2,500 climb-view
 *   URLs on 2026-08-22 presenting ordinary Chrome/Firefox/Edge UAs (PostHog:
 *   2,031 distinct persons, one pageview each, `$referring_domain` null on
 *   every event). That population needs an edge rate-limit, not a UA list —
 *   see `docs/vercel-compute-baseline.md`.
 */

/**
 * Next 16.2.12's own bot tokens, copied token-for-token from the `isBot` regex
 * in `next/dist/server/web/spec-extension/user-agent.js`. Kept as a separate
 * half so `is-crawler.test.ts` can assert we are still a superset of whatever
 * the installed Next ships.
 */
const NEXT_BOT_TOKENS = [
  'Googlebot',
  'Mediapartners-Google',
  'AdsBot-Google',
  'googleweblight',
  'Storebot-Google',
  'Google-PageRenderer',
  'Google-InspectionTool',
  'Bingbot',
  'BingPreview',
  'Slurp',
  'DuckDuckBot',
  'baiduspider',
  'yandex',
  'sogou',
  'LinkedInBot',
  'bitlybot',
  'tumblr',
  'vkShare',
  'quora link preview',
  'facebookexternalhit',
  'facebookcatalog',
  'Twitterbot',
  'applebot',
  'redditbot',
  'Slackbot',
  'Discordbot',
  'WhatsApp',
  'SkypeUriPreview',
  'ia_archiver',
  'GPTBot',
] as const;

/**
 * SEO/backlink scrapers and archivers that Next omits and that were verified to
 * reach our origin — see the probe in the file header. These are the agents
 * still bouncing through the locale twins today.
 */
const SEO_SCRAPER_TOKENS = [
  'AhrefsBot',
  'AhrefsSiteAudit',
  'SemrushBot',
  'DataForSeoBot',
  'MJ12bot',
  'DotBot',
  'BLEXBot',
  'Barkrowler',
  'serpstatbot',
  'SeznamBot',
  'ZoominfoBot',
  'Screaming Frog SEO Spider',
  'archive.org_bot',
] as const;

const escapeRegExpLiteral = (token: string): string => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Case-insensitive alternation over every token above. No `g` flag on purpose:
 * a module-level `g`-flagged regex carries `lastIndex` between `.test()` calls
 * and would alternate true/false on repeated identical input.
 */
export const CRAWLER_USER_AGENT_PATTERN = new RegExp(
  [...NEXT_BOT_TOKENS, ...SEO_SCRAPER_TOKENS].map(escapeRegExpLiteral).join('|'),
  'i',
);

export function isCrawlerUserAgent(userAgentHeader: string | null | undefined): boolean {
  return userAgentHeader ? CRAWLER_USER_AGENT_PATTERN.test(userAgentHeader) : false;
}
