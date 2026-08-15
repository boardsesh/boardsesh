import { describe, expect, it } from 'vite-plus/test';
import { standingsCacheKey } from '../graphql/resolvers/social/standings-cache';

/**
 * The cache key is a privacy boundary, not just a perf detail.
 *
 * A standings payload carries viewer-specific fields: `isViewer` per row, the
 * viewer block, and — critically — the viewer's own real name and user id on a
 * row that is anonymised for everybody else. If two viewers shared a cache
 * entry, the second one would receive the first one's identity on a row they
 * were never allowed to see, which is exactly what the anonymity setting exists
 * to withhold.
 */
describe('standingsCacheKey', () => {
  const base = { scopeId: 'global', window: 'month', limit: 50, offset: 0, viewerId: 'user-1' };

  it('separates viewers, so one climber never receives another climber-specific page', () => {
    expect(standingsCacheKey(base)).not.toBe(standingsCacheKey({ ...base, viewerId: 'user-2' }));
  });

  it('separates a signed-out reader from a signed-in one', () => {
    expect(standingsCacheKey({ ...base, viewerId: null })).not.toBe(standingsCacheKey(base));
  });

  it('separates every field that changes the response', () => {
    const variants = [
      { ...base, scopeId: 'board:abc' },
      { ...base, window: 'week' },
      { ...base, limit: 20 },
      { ...base, offset: 50 },
    ];
    const keys = variants.map(standingsCacheKey);
    // Each variant differs from the base, and from each other.
    expect(new Set([standingsCacheKey(base), ...keys]).size).toBe(variants.length + 1);
  });

  it('is stable for identical inputs, or the cache never hits', () => {
    expect(standingsCacheKey(base)).toBe(standingsCacheKey({ ...base }));
  });

  it('is namespaced and versioned, so a ranking-logic change can invalidate cleanly', () => {
    // Without the version segment a scoring change would serve stale rankings
    // for the whole TTL rather than recomputing.
    expect(standingsCacheKey(base)).toMatch(/^boardsesh:standings:v\d+:/);
  });
});
