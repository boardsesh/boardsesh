/** Automated AI training/search crawlers. Human-triggered unfurlers are separate. */
export const AI_CRAWLER_TOKENS = [
  'gptbot',
  'oai-searchbot',
  'claudebot',
  'claude-searchbot',
  'perplexitybot',
  'amzn-searchbot',
  'amazonbot',
  'bytespider',
  'ccbot',
  'meta-externalagent',
] as const;

/**
 * Crawlers blocked on cost rather than on what they do with the content.
 *
 * Yandex was added to CRAWLER_ALLOW_TOKENS on 2026-09-07 (51a046118) without a
 * stated reason, bundled into the AI-crawler commit. Production HTTP logs four
 * days later made the case against it. In a 5-minute sample of boardsesh-web
 * (2026-09-10 14:25 UTC, n=501) YandexBot was 36% of all requests against 3.6%
 * for real browsers, and 171 of its 181 requests were climb-view pages — the
 * most expensive SSR path we have. It also averaged 510 ms per request against
 * Applebot's 222 ms, so it is the costliest crawler we carry per page fetched.
 *
 * Boardsesh is an English-language climbing site; Yandex sends back no
 * measurable traffic to set against that. The Cloudflare rate limit cannot
 * reach it either — the Free plan caps the period at 10 s and Yandex ran ~34
 * requests/min, nowhere near the 60-per-10 s threshold.
 *
 * Both tokens are needed: `yandexrenderresourcesbot` does not contain
 * `yandexbot` as a substring, and the renderer was 6% of the Yandex traffic in
 * the same sample.
 */
export const COST_BLOCKED_CRAWLER_TOKENS = [
  'yandexbot',
  'yandexrenderresourcesbot',
  // Lightpanda is a headless browser built for AI agents. It executes our
  // JavaScript, so it costs a page render on www AND the GraphQL and PostHog
  // calls that page makes on ws. Measured 2026-09-26 in Railway HTTP logs: 483
  // of 501 www requests in one 16-second window, and 218 of 501 on the backend.
  // No block list named it, and the default-deny below cannot see it either:
  // its UA is a bare `Lightpanda/1.0` with no generic signature, so it has to
  // be named.
  'lightpanda',
] as const;

/**
 * Every crawler we refuse, whatever the reason. This is the single list behind
 * all three enforcement points — the Cloudflare WAF block rule, `robots.ts`,
 * and the origin fallback in `middleware.ts` — so a token can never be blocked
 * at one layer and allowed at another.
 */
export const BLOCKED_CRAWLER_TOKENS = [...AI_CRAWLER_TOKENS, ...COST_BLOCKED_CRAWLER_TOKENS] as const;

/**
 * Search engines, share unfurlers and the operational agents we depend on.
 * Every agent here is exempt from the default-deny below, and at the edge the
 * Cloudflare allow rule skips the rest of the WAF ruleset for it on GET. Web and
 * Cloudflare import this one list, so the origin and the edge cannot disagree.
 *
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
  // Added 2026-09-26 with the automation default-deny, which would otherwise
  // catch them on the `bot` signature. DuckDuckGo's favicon fetcher draws the
  // icon beside our results; DuckAssist answers from pages DuckDuckGo already
  // indexes; Kagi runs its own small index. AdsBot-Google checks landing pages
  // and msnbot-media is Bing's image crawler: neither is covered by `googlebot`
  // or `bingbot` as a substring.
  'duckduckgo-favicons-bot',
  'duckassistbot',
  'kagibot',
  'adsbot-google',
  'msnbot-media',
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
  // Also added with the default-deny. Snapchat's unfurler says `bot` in its UA
  // (`Snap URL Preview Service; bot; snapchat`), and climb pages get shared
  // there. AppleNewsBot builds Apple News and Messages previews; `applebot`
  // is not a substring of it.
  'snap url preview',
  'applenewsbot',
  // The Internet Archive. It reaches us and it loops, but it is low volume and
  // excluding it is a values call rather than a cost one (see
  // CRAWLER_BLOCK_TOKENS in infra/cloudflare/config.ts). It passed by default
  // until the default-deny, so it is named to keep it passing.
  'archive.org_bot',
  // Added 2026-09-26 with the automation default-deny. Each of these carries a
  // generic signature (`bot`, `curl/` …) and would be blocked without an entry.
  //
  // Operational: the Sentry uptime alarm (www `/`, `/api/health`, ws `/health`),
  // and the iOS and Android deep-link association fetches. The two smoke tests
  // send `boardsesh-production-smoke/1.0`, which carries no signature, but it
  // is listed so renaming it to something bot-like cannot silently break them.
  'sentryuptimebot',
  'aasa-bot',
  'googleassociationservice',
  'boardsesh-production-smoke',
  // Our own ESP32 board controller. Its thumbnail client
  // (embedded/libs/thumbnail-client) GETs www /api/internal/board-render with
  // the Arduino HTTPClient default UA, `ESP32HTTPClient`, which carries the
  // `httpclient` signature. Flashed devices cannot be patched from here.
  'esp32httpclient',
  // A person asked an assistant to open this page. These are fetches on a
  // human's behalf, not crawls, and the origin has let them through since the
  // AI-crawler block (see middleware.test.ts). ChatGPT-User carries
  // `openai.com/bot` in its UA, so it needs an entry now.
  'chatgpt-user',
  'claude-user',
  'perplexity-user',
  // Not an agent: Cubot is an Android phone brand, and its model string
  // (`CUBOT P50`) lands in real browser and Dalvik UAs. Without this, the
  // `bot` signature would block climbers on those phones.
  'cubot',
] as const;

/**
 * Substrings only self-identified automation carries. Anything whose UA
 * matches one of these is blocked on GET unless it is on CRAWLER_ALLOW_TOKENS —
 * the allow-list model: a crawler has to be named to get in.
 *
 * This can only ever govern agents that SAY they are automated. Real climbers
 * arrive as `Mozilla/…`, and so do the UA-rotating scrapers, so browser strings
 * are never default-denied; that population is left to the /list + /setter/
 * challenge and the /view/ rate limit.
 *
 * Checked against 6,012 Railway HTTP log entries from 12 windows between
 * 2026-09-19 and 2026-09-26 (www and ws). Deliberately absent:
 * - `okhttp` — the Android app's HTTP client (572 requests in the sample).
 * - `node` — our own servers calling ws, e.g. the www share-card fetch of
 *   `/og/climb` (385 requests). Too short to match safely anyway.
 * - `cfnetwork`, `dalvik` — the iOS and Android app.
 * `python` covers python-requests, python-httpx, Python-urllib and aiohttp
 * (`Python/3.x aiohttp/…`); no browser string contains it.
 */
export const AUTOMATION_SIGNATURE_TOKENS = [
  'bot',
  'crawler',
  'spider',
  'scraper',
  'headless',
  'python',
  'go-http-client',
  'java/',
  'libwww',
  'wget/',
  'curl/',
  'scrapy',
  'httpclient',
] as const;

/**
 * Paths the default-deny never touches, whatever the UA says.
 *
 * - Health endpoints are polled by our own CI with bare curl
 *   (`mobile-ota-production.yml` waits on ws `/health`,
 *   `railway-cost-monitor.yml` reads `/health/db`). They are cheap, and a 403
 *   there would stall an OTA publish rather than save a byte.
 * - `/robots.txt` stays readable so an unlisted bot can see the Disallow
 *   lines and stop on its own. A 403 there reads as "no restrictions" under
 *   RFC 9309. Named crawlers are still refused by the block rule.
 * - `/.well-known/` holds the app-site-association files the OS fetches. The
 *   fetchers are allow-listed too, but a renamed Apple or Google agent must not
 *   be able to break deep links.
 * - `/api/v1/` (www public read API) and `/v1/partner/` (ws partner API) are
 *   programmatic surfaces: a script or a partner server calling them is the
 *   intended client, and will often send python-requests or Go-http-client.
 */
export const AUTOMATION_DEFAULT_DENY_EXEMPT_PATHS = ['/health', '/health/db', '/api/health', '/robots.txt'] as const;
export const AUTOMATION_DEFAULT_DENY_EXEMPT_PATH_PREFIXES = ['/.well-known/', '/api/v1/', '/v1/partner/'] as const;

function includesAny(normalizedUserAgent: string, tokens: readonly string[]): boolean {
  return tokens.some((token) => normalizedUserAgent.includes(token));
}

function isDefaultDenyExemptPath(pathname: string): boolean {
  return (
    (AUTOMATION_DEFAULT_DENY_EXEMPT_PATHS as readonly string[]).includes(pathname) ||
    AUTOMATION_DEFAULT_DENY_EXEMPT_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

/**
 * The origin's copy of the two Cloudflare block rules, for requests that reach
 * Railway without passing the edge (GPTBot did that through the Railway
 * hostname in September).
 *
 * 1. A named crawler (BLOCKED_CRAWLER_TOKENS) is blocked on every method.
 * 2. Any other self-identified automation is blocked on GET, off the exempt
 *    paths, unless CRAWLER_ALLOW_TOKENS names it. GET-only matches the edge
 *    rule, whose allow-rule `skip` is GET-only too.
 *
 * Pass `automationDefaultDeny: false` to apply rule 1 alone. The middleware
 * does that outside production (see `isOriginAutomationDefaultDenyEnabled`).
 */
export function isBlockedCrawler(
  userAgent: string | null,
  request: { method: string; pathname: string },
  { automationDefaultDeny = true }: { automationDefaultDeny?: boolean } = {},
): boolean {
  const normalizedUserAgent = userAgent?.toLowerCase() ?? '';
  if (includesAny(normalizedUserAgent, BLOCKED_CRAWLER_TOKENS)) return true;
  if (!automationDefaultDeny) return false;
  if (request.method !== 'GET' || isDefaultDenyExemptPath(request.pathname)) return false;
  return (
    includesAny(normalizedUserAgent, AUTOMATION_SIGNATURE_TOKENS) &&
    !includesAny(normalizedUserAgent, CRAWLER_ALLOW_TOKENS)
  );
}

/**
 * Whether the origin applies rule 2 of `isBlockedCrawler` (the automation
 * default-deny). Named crawlers are refused in every environment regardless.
 *
 * The Cloudflare edge rule is the primary enforcement. The origin copy exists
 * only for requests that reach the Railway hostname directly, and that never
 * happens in dev or e2e — while those environments are full of legitimate
 * automation: Playwright's headless Chromium announces itself as
 * `HeadlessChrome`, and local scripts use curl. So the default-deny runs only
 * in a production build, and `BOARDSESH_E2E=1` turns it off for the CI e2e
 * shards, which serve a production build (`next start`) to Playwright.
 */
export function isOriginAutomationDefaultDenyEnabled(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.BOARDSESH_E2E !== '1';
}
