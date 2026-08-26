/**
 * W-19 (#4437) and W-20b (#4439): the private web surfaces are gone from www.
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
 *  - no same-origin redirect lands on a path that any other rule would redirect
 *    again — matched against the compiled source patterns, not literal strings,
 *    because most sources here are parameterised.
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
  // W-20b (#4439): the notification centre. The route tree and its components
  // are listed alongside the four hooks and the root-layout subscription
  // manager, because a merge can restore any one of them independently —
  // `import-graph-invariant` only sees a resurrected file once a kept surface
  // imports it, which is true of the subscription manager and of nothing else
  // here. `climb-redirect` is a live HTTP endpoint if it comes back.
  'app/notifications',
  'app/components/notifications',
  'app/components/providers/notification-subscription-manager.tsx',
  'app/hooks/use-grouped-notifications.ts',
  'app/hooks/use-mark-notifications-read.ts',
  'app/hooks/use-notification-subscription.ts',
  'app/hooks/use-unread-notification-count.ts',
  'app/api/internal/climb-redirect',
  'app/lib/ssr-timeout.ts',
];

/**
 * Concrete entry points, not bare directories: `existsSync` is true for an empty
 * directory, so a sweep that emptied `app/join/` while leaving the folder would
 * pass a directory-only assertion and 404 every session share link the mobile
 * app has ever emitted.
 */
const KEPT_PATHS = [
  'app/session',
  'app/session/[sessionId]/page.tsx',
  'app/join',
  'app/join/[sessionId]/page.tsx',
  'app/api/internal/climb-search-cache/revalidate/route.ts',
  'app/lib/climb-search-cache.ts',
  'app/api/internal/profile/route.ts',
  'app/lib/auth/user-board-mappings.ts',
  // `app/lib/server-popular-configs.ts` is the live twin of the deleted
  // `server-board-configs.ts` — the sitemap shard registry imports it.
  'app/lib/server-popular-configs.ts',
  'app/components/activity-feed/activity-feed.tsx',
  'app/components/activity-feed/social-feed-item.tsx',
  // The assets the epic marks never-touch. `ws-auth` is the party-session
  // handshake; `climb-card/` is the shared card the board lists and the social
  // feeds both render. The legacy board-render URL is now an unconditional
  // external rewrite in next.config.mjs, not a Next route file.
  'app/api/internal/ws-auth/route.ts',
  'app/components/climb-card/climb-title.tsx',
];

const LOCALE_PREFIXES = ['/es', '/fr', '/de'];

/** Base sources this PR must 30x, before locale expansion. */
const REDIRECTED_SOURCES = ['/you', '/you/:path*', '/feed', '/discover', '/import-beta', '/notifications'];

type Redirect = { source: string; destination: string; permanent: boolean };
type NextConfigWithRedirects = { redirects?: () => Promise<Redirect[]> };

const configModule = await import('../../next.config.mjs');
const nextConfig = configModule.default as unknown as NextConfigWithRedirects;
const redirects = (await nextConfig.redirects?.()) ?? [];
const redirectSources = new Set(redirects.map((redirect) => redirect.source));

function isCrossOrigin(destination: string): boolean {
  return destination.startsWith('http://') || destination.startsWith('https://');
}

function escapeLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a Next redirect `source` into a matcher.
 *
 * The chain guard has to compare a destination against the *patterns* the rule
 * table declares, not against the literal source strings: most sources here are
 * parameterised, so `redirectSources.has('/you/sessions')` is false even though
 * `/you/:path*` matches it in production. A literal-only guard would let a later
 * wave ship `/old-logbook → /you/sessions → app.boardsesh.com/profile` — two
 * hops — while staying green.
 *
 * This covers the path-to-regexp subset the table actually uses: `:name`,
 * `:name(custom)` and the `*`/`+`/`?` modifiers.
 */
const PARAM_PATTERN = /:([A-Za-z0-9_]+)(?:\(((?:[^()\\]|\\.)*)\))?([*+?])?/;

function compileSource(source: string): RegExp {
  let pattern = '';
  let rest = source;

  while (rest.length > 0) {
    const match = PARAM_PATTERN.exec(rest);
    if (!match) {
      pattern += escapeLiteral(rest);
      break;
    }

    const [whole, , custom, modifier] = match;
    const literal = rest.slice(0, match.index);
    const segment = custom ?? '[^/]+';

    if (modifier === '*' || modifier === '+') {
      // `/:path*` repeats whole segments, so the slash in front of it belongs
      // inside the repeat group — `/you/:path*` must match a bare `/you`.
      const slashLed = literal.endsWith('/');
      pattern += escapeLiteral(slashLed ? literal.slice(0, -1) : literal);
      pattern += slashLed ? `(?:/(?:${segment}))${modifier}` : `(?:${segment})${modifier}`;
    } else {
      pattern += `${escapeLiteral(literal)}(?:${segment})${modifier ?? ''}`;
    }

    rest = rest.slice(match.index + whole.length);
  }

  return new RegExp(`^${pattern}$`);
}

const sourceMatchers = redirects.map((redirect) => ({
  source: redirect.source,
  matches: compileSource(redirect.source),
}));

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
      .flatMap((redirect) => {
        const destinationPath = redirect.destination.split('?')[0];
        const hit = sourceMatchers.find(
          (candidate) => candidate.source !== redirect.source && candidate.matches.test(destinationPath),
        );

        return hit ? [`${redirect.source} -> ${redirect.destination} (matched by ${hit.source})`] : [];
      });

    expect(chained).toEqual([]);
  });

  it('never lands a same-origin redirect on a trailing slash', () => {
    // `trailingSlash` is at its default and `skipTrailingSlashRedirect` is
    // unset, so Next unshifts its own `/:path+/ → /:path+` 308 ahead of every
    // custom rule. A destination that ends in `/` is therefore a two-hop
    // redirect that the chain guard above cannot see — the extra hop comes from
    // Next, not from this rule table.
    const trailing = redirects
      .filter((redirect) => !isCrossOrigin(redirect.destination))
      .filter((redirect) => {
        const destinationPath = redirect.destination.split('?')[0];
        return destinationPath !== '/' && destinationPath.endsWith('/');
      })
      .map((redirect) => `${redirect.source} -> ${redirect.destination}`);

    expect(trailing).toEqual([]);
  });
});
