import { describe, it, expect } from 'vite-plus/test';
import robots from '../robots';

function getRules(result: ReturnType<typeof robots>) {
  return Array.isArray(result.rules) ? result.rules[0] : result.rules;
}

function toList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Evaluate a path the way a crawler does, so these assertions test what
 * `robots.ts` actually emits rather than restating the literals under test.
 *
 * Per the Robots Exclusion Protocol (RFC 9309 §2.2.2) the most specific —
 * longest — matching rule wins regardless of the order rules appear in the
 * file, and Allow wins a tie against Disallow. Path matching is a prefix
 * match against the path, ignoring the query string.
 */
function isPathCrawlable(rules: ReturnType<typeof getRules>, url: string): boolean {
  const path = url.split('?')[0];
  const longestMatch = (patterns: string[]) =>
    patterns
      .filter((pattern) => path.startsWith(pattern))
      .reduce((longest, pattern) => Math.max(longest, pattern.length), -1);

  const allowLength = longestMatch(toList(rules.allow));
  const disallowLength = longestMatch(toList(rules.disallow));

  return allowLength >= disallowLength;
}

describe('robots', () => {
  it('allows crawling the root path', () => {
    const result = robots();
    const rules = getRules(result);
    expect(rules.userAgent).toBe('*');
    expect(toList(rules.allow)).toEqual(expect.arrayContaining(['/']));
  });

  it('disallows crawling /feed, /api/, /auth/, and /settings', () => {
    const result = robots();
    const rules = getRules(result);
    expect(rules.disallow).toEqual(expect.arrayContaining(['/feed', '/api/', '/auth/', '/settings']));
  });

  it('includes a sitemap URL', () => {
    const result = robots();
    expect(result.sitemap).toBe('https://www.boardsesh.com/sitemap.xml');
  });

  it('carves out Googlebot-Image access to OG images and the board-render LCP image despite the blanket /api/ disallow', () => {
    const rules = getRules(robots());

    // Each of these is fetched by a crawler as an image: the OG cards for the
    // setter/profile/playlist/session pages (buildVersionedOgImagePath emits
    // relative /api/og/... paths) and the climb page's LCP board render.
    expect(isPathCrawlable(rules, '/api/og/setter')).toBe(true);
    expect(isPathCrawlable(rules, '/api/og/profile/abc?v=2')).toBe(true);
    expect(isPathCrawlable(rules, '/api/internal/board-render?frames=p1')).toBe(true);

    // The carve-outs must stay carve-outs: the rest of /api/ is still closed.
    expect(isPathCrawlable(rules, '/api/internal/dev-metadata')).toBe(false);
    expect(isPathCrawlable(rules, '/api/v1/kilter/proxy/search')).toBe(false);
  });

  it('keeps the private surfaces closed while the climb list stays open', () => {
    const rules = getRules(robots());

    expect(isPathCrawlable(rules, '/feed')).toBe(false);
    expect(isPathCrawlable(rules, '/auth/signin')).toBe(false);
    expect(isPathCrawlable(rules, '/settings')).toBe(false);
    expect(isPathCrawlable(rules, '/you')).toBe(false);

    expect(isPathCrawlable(rules, '/kilter/1/7/1,20/40/list')).toBe(true);
    expect(isPathCrawlable(rules, '/b/my-board/40/list')).toBe(true);
  });
});
