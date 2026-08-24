import { describe, it, expect } from 'vite-plus/test';
// Deep import into Next internals, used ONLY here: `next/server` re-exports
// `userAgent` but not `isBot`, and this suite needs the live regex to prove we
// are still a superset of it. Production code never takes this path — see the
// header of `is-crawler.ts`.
import { isBot } from 'next/dist/server/web/spec-extension/user-agent';
import { CRAWLER_USER_AGENT_PATTERN, isCrawlerUserAgent } from '@/app/lib/is-crawler';

/**
 * Pull the alternatives out of the installed Next's `isBot` source rather than
 * hand-copying them, so a future Next widening fails this suite instead of
 * silently leaving our pattern narrower than the one we replaced.
 */
function extractNextBotTokens(): string[] {
  const isBotSource = String(isBot);
  const regexLiteral = /\/((?:\\.|\[[^\]]*\]|[^/\\])+)\/i\.test\(/.exec(isBotSource);
  if (!regexLiteral) {
    throw new Error(`Could not find the isBot regex literal in the installed Next. Source was:\n${isBotSource}`);
  }
  return regexLiteral[1].split('|');
}

const nextBotTokens = extractNextBotTokens();

// Realistic-shaped UA that embeds one token, so each case exercises a substring
// match in context rather than the bare token on its own.
const uaContaining = (token: string) => `Mozilla/5.0 (compatible; ${token}/2.1; +http://example.invalid/bot.html)`;

describe('isCrawlerUserAgent is a superset of the installed Next bot list', () => {
  it('extracted a plausible token list from the installed Next, not regex debris', () => {
    // Guards the extraction itself: if Next ever ships a differently-shaped
    // isBot, this must fail loudly rather than leave the it.each below vacuous
    // or, worse, iterating over fragments that happen to number 30+. A count
    // alone would not catch that, so anchor on tokens Next has shipped since
    // 2019 and reject anything that does not look like a UA token.
    expect(nextBotTokens.length).toBeGreaterThanOrEqual(30);
    expect(nextBotTokens.length).toBeLessThan(200);
    for (const anchorToken of ['Googlebot', 'Bingbot', 'facebookexternalhit', 'Twitterbot', 'GPTBot']) {
      expect(nextBotTokens).toContain(anchorToken);
    }
    for (const token of nextBotTokens) {
      expect(token.length).toBeGreaterThan(2);
      expect(token.length).toBeLessThan(40);
      // UA tokens, not regex fragments: no leftover grouping or quantifiers.
      expect(/^[\w .+-]+$/.test(token)).toBe(true);
    }
  });

  it.each(nextBotTokens)('still classifies Next token %s as a crawler', (token) => {
    const userAgentHeader = uaContaining(token);
    // Sanity: the fixture really does embed the token Next matches on.
    expect(isBot(userAgentHeader)).toBe(true);
    expect(isCrawlerUserAgent(userAgentHeader)).toBe(true);
  });
});

describe('isCrawlerUserAgent covers the scrapers Next omits', () => {
  // Every UA here was sent at production on 2026-08-24 and reached the origin
  // (HTTP 200 on the /es twin, HTTP 307 to the twin on the unprefixed URL).
  const SCRAPER_UAS: [string, string][] = [
    ['AhrefsBot', 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)'],
    ['AhrefsSiteAudit', 'Mozilla/5.0 (compatible; AhrefsSiteAudit/6.1; +http://ahrefs.com/robot/)'],
    ['SemrushBot', 'Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)'],
    ['DataForSeoBot', 'Mozilla/5.0 (compatible; DataForSeoBot/1.0; +https://dataforseo.com/dataforseo-bot)'],
    ['MJ12bot', 'Mozilla/5.0 (compatible; MJ12bot/v1.4.8; http://mj12bot.com/)'],
    ['DotBot', 'Mozilla/5.0 (compatible; DotBot/1.2; +https://opensiteexplorer.org/dotbot; help@moz.com)'],
    ['BLEXBot', 'Mozilla/5.0 (compatible; BLEXBot/1.0; +http://webmeup-crawler.com/)'],
    ['Barkrowler', 'Mozilla/5.0 (compatible; Barkrowler/0.9; +https://babbar.tech/crawler)'],
    ['serpstatbot', 'Mozilla/5.0 (compatible; serpstatbot/2.1; +http://serpstatbot.com/)'],
    ['SeznamBot', 'Mozilla/5.0 (compatible; SeznamBot/4.0; +http://napoveda.seznam.cz/seznambot-intro/)'],
    ['ZoominfoBot', 'Mozilla/5.0 (compatible; ZoominfoBot; zoominfobot at zoominfo dot com)'],
    ['Screaming Frog', 'Screaming Frog SEO Spider/21.4'],
    ['archive.org_bot', 'Mozilla/5.0 (compatible; archive.org_bot +http://www.archive.org/details/archive.org_bot)'],
  ];

  it.each(SCRAPER_UAS)('classifies %s as a crawler', (_token, userAgentHeader) => {
    expect(isCrawlerUserAgent(userAgentHeader)).toBe(true);
  });

  it.each(SCRAPER_UAS)('%s is not already covered by Next', (_token, userAgentHeader) => {
    // If Next ever adds one of these, drop it from SEO_SCRAPER_TOKENS rather
    // than carrying the same token in both halves.
    expect(isBot(userAgentHeader)).toBe(false);
  });

  it('escapes the dot in archive.org_bot instead of letting it match any character', () => {
    expect(isCrawlerUserAgent('Mozilla/5.0 (compatible; archiveXorg_bot)')).toBe(false);
  });
});

describe('isCrawlerUserAgent leaves real browsers alone', () => {
  // A false positive costs a real visitor their sticky locale, so these are the
  // cases that must never regress.
  const BROWSER_UAS: [string, string][] = [
    [
      'Chrome on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    ],
    ['Firefox on Linux', 'Mozilla/5.0 (X11; Linux x86_64; rv:129.0) Gecko/20100101 Firefox/129.0'],
    [
      'Safari on iOS',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
    ],
    [
      'Edge on Windows',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.2739.42',
    ],
    [
      'Samsung Internet',
      'Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
    ],
    [
      'Yandex Browser desktop',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 YaBrowser/23.9.1.962 Yowser/2.5 Safari/537.36',
    ],
    [
      'Yandex Browser Android',
      'Mozilla/5.0 (Linux; arm_64; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/106.0.0.0 YaBrowser/22.11.3.104.00 SA/3 Mobile Safari/537.36',
    ],
  ];

  it.each(BROWSER_UAS)('does not classify %s as a crawler', (_label, userAgentHeader) => {
    expect(isCrawlerUserAgent(userAgentHeader)).toBe(false);
  });

  it('inherits one Yandex false positive from Next, and it fails gracefully', () => {
    // The Yandex Search in-app browser spells `YandexSearch`, which contains the
    // `yandex` substring Next matches on. We keep the token rather than diverge
    // from Next: the cost is that this visitor gets a default-locale 200 for the
    // URL they asked for instead of a sticky-locale redirect — the same
    // behaviour the bot branch was designed to give, not an error.
    const yandexSearchInAppUa =
      'Mozilla/5.0 (Linux; Android 13; SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/106.0.0.0 Mobile Safari/537.36 YandexSearch/1.0';
    expect(isBot(yandexSearchInAppUa)).toBe(true);
    expect(isCrawlerUserAgent(yandexSearchInAppUa)).toBe(true);
  });
});

describe('isCrawlerUserAgent handles a missing header', () => {
  it('returns false for null', () => {
    expect(isCrawlerUserAgent(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isCrawlerUserAgent(undefined)).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isCrawlerUserAgent('')).toBe(false);
  });
});

describe('CRAWLER_USER_AGENT_PATTERN is stateless', () => {
  it('carries no g flag, so repeated .test() calls do not alternate', () => {
    expect(CRAWLER_USER_AGENT_PATTERN.flags).toBe('i');

    const ahrefsUa = 'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)';
    expect(CRAWLER_USER_AGENT_PATTERN.test(ahrefsUa)).toBe(true);
    expect(CRAWLER_USER_AGENT_PATTERN.test(ahrefsUa)).toBe(true);
    expect(CRAWLER_USER_AGENT_PATTERN.test(ahrefsUa)).toBe(true);
  });
});
