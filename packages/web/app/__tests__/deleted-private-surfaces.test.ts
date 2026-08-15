/**
 * W-19 (#4437): the private web surfaces are gone from www.
 *
 * A delete PR has a weak correctness oracle — nothing fails when a deleted tree
 * quietly comes back in a merge, and nothing fails when a redirect that was
 * supposed to ship with the delete is dropped. This file is that oracle:
 *
 *  - the deleted trees stay deleted,
 *  - the surfaces the epic explicitly keeps stay present (an over-eager sweep
 *    into `/session`, `/join`, `climb-search-cache` or `/api/internal/profile`
 *    reds here rather than in production),
 *  - every deleted path 30x's in all four locales, and
 *  - no same-origin redirect lands on a path that is itself a redirect source.
 *
 * That last one is the trap this PR fixes: `/you/logbook` used to 301 onto
 * `/you`, which is now itself a redirect, so shipping both would have made every
 * old logbook link a two-hop.
 */
import { describe, expect, it } from 'vite-plus/test';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const DELETED_PATHS = [
  'app/you',
  'app/feed',
  'app/import-beta',
  'app/development',
  'app/discover',
  'app/api/internal/favorites',
  'app/api/internal/hold-classifications',
  'app/api/internal/user-board-mapping',
  'app/lib/auth/use-auth-integration.ts',
  'app/lib/server-board-configs.ts',
  'app/components/activity-feed/proposal-feed.tsx',
  'app/components/activity-feed/comment-feed.tsx',
];

const KEPT_PATHS = [
  'app/session',
  'app/join',
  'app/api/internal/climb-search-cache/revalidate/route.ts',
  'app/lib/climb-search-cache.ts',
  'app/api/internal/profile/route.ts',
  'app/lib/auth/user-board-mappings.ts',
  // `app/lib/server-popular-configs.ts` is the live twin of the deleted
  // `server-board-configs.ts` — the sitemap shard registry imports it.
  'app/lib/server-popular-configs.ts',
  'app/components/activity-feed/activity-feed.tsx',
  'app/components/activity-feed/social-feed-item.tsx',
];

const LOCALE_PREFIXES = ['/es', '/fr', '/de'];

/** Base sources this PR must 30x, before locale expansion. */
const REDIRECTED_SOURCES = ['/you', '/you/:path*', '/feed', '/import-beta'];

type Redirect = { source: string; destination: string; permanent: boolean };
type NextConfigWithRedirects = { redirects?: () => Promise<Redirect[]> };

const configModule = await import('../../next.config.mjs');
const nextConfig = configModule.default as unknown as NextConfigWithRedirects;
const redirects = (await nextConfig.redirects?.()) ?? [];
const redirectSources = new Set(redirects.map((redirect) => redirect.source));

function isCrossOrigin(destination: string): boolean {
  return destination.startsWith('http://') || destination.startsWith('https://');
}

describe('deleted private surfaces', () => {
  it('leaves no trace of a deleted surface in the tree', () => {
    const surviving = DELETED_PATHS.filter((path) => existsSync(join(WEB_ROOT, path)));
    expect(surviving).toEqual([]);
  });

  it('keeps every surface the epic explicitly spared', () => {
    const missing = KEPT_PATHS.filter((path) => !existsSync(join(WEB_ROOT, path)));
    expect(missing).toEqual([]);
  });

  it('30x-es every deleted path in all four locales', () => {
    const missing = REDIRECTED_SOURCES.flatMap((source) =>
      [source, ...LOCALE_PREFIXES.map((prefix) => `${prefix}${source}`)].filter(
        (candidate) => !redirectSources.has(candidate),
      ),
    );

    expect(missing).toEqual([]);
  });

  it('deliberately leaves /development with no redirect', () => {
    // `/development` called `notFound()` whenever NODE_ENV !== 'development',
    // so it never returned 200 in production. A 301 would tell crawlers a
    // public page moved when none ever existed. This is the one deleted path
    // that does not 30x, on purpose.
    const developmentRules = [...redirectSources].filter(
      (source) => source === '/development' || source.endsWith('/development'),
    );

    expect(developmentRules).toEqual([]);
  });

  it('never chains one redirect into another', () => {
    const chained = redirects
      .filter((redirect) => !isCrossOrigin(redirect.destination))
      .filter((redirect) => redirectSources.has(redirect.destination.split('?')[0]))
      .map((redirect) => `${redirect.source} -> ${redirect.destination}`);

    expect(chained).toEqual([]);
  });
});
