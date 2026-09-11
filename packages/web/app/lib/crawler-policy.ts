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
export const COST_BLOCKED_CRAWLER_TOKENS = ['yandexbot', 'yandexrenderresourcesbot'] as const;

/**
 * Every crawler we refuse, whatever the reason. This is the single list behind
 * all three enforcement points — the Cloudflare WAF block rule, `robots.ts`,
 * and the origin fallback in `middleware.ts` — so a token can never be blocked
 * at one layer and allowed at another.
 */
export const BLOCKED_CRAWLER_TOKENS = [...AI_CRAWLER_TOKENS, ...COST_BLOCKED_CRAWLER_TOKENS] as const;

export function isBlockedCrawler(userAgent: string | null): boolean {
  const normalizedUserAgent = userAgent?.toLowerCase() ?? '';
  return BLOCKED_CRAWLER_TOKENS.some((token) => normalizedUserAgent.includes(token));
}
