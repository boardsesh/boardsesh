import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Board content — climb view, climb list, setter — is the one place we
 * deliberately cross-canonicalise locale twins onto the default locale and emit
 * no `hreflang`. The twins are translated chrome over identical data, so four
 * URLs for one page bought nothing but a 4x crawl surface: ~205k climb-view
 * renders/day with Postgres at 183/200 connections when this was measured.
 *
 * That decision only holds if two things stay true together, and neither is
 * visible from the other's file:
 *
 * 1. **Every** metadata call in these route files goes through
 *    `createBoardContentPageMetadata`. They call into metadata 19 times between
 *    them (fallback, notFound and redirect paths), so one missed call site
 *    silently republishes a self-canonicalising twin.
 * 2. Their sitemap shards do not list the twins. Advertising a URL whose own
 *    canonical points elsewhere is a contradiction Google resolves by ignoring
 *    one of the two signals.
 *
 * A missing import is checkable where a missed argument is not, which is why
 * this is a separate function rather than a flag on `createPageMetadata`.
 */

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The surfaces that cross-canonicalise. Both route trees, plus setter. */
const BOARD_CONTENT_ROUTE_FILES = [
  'app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page.tsx',
  'app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/list/page.tsx',
  'app/b/[board_slug]/[angle]/view/[climb_uuid]/page.tsx',
  'app/b/[board_slug]/[angle]/list/page.tsx',
  'app/setter/[setter_username]/page.tsx',
] as const;

/** Shards whose pages cross-canonicalise, so they must not fan out to locales. */
const DEFAULT_LOCALE_ONLY_SHARDS = ['boards', 'setters'] as const;

const SHARD_REGISTRY_PATH = 'app/lib/seo/sitemap/shard-registry.ts';

/**
 * The shard registry is read as SOURCE, not imported: it is `server-only` and
 * pulls in the board-config query, so importing it needs a DATABASE_URL. A guard
 * over a config shape should not need a database — same approach
 * `ci-lint-scope.test.ts` takes over `vite.config.ts`.
 */
function shardLiteral(source: string, id: string): string {
  const start = source.indexOf(`id: '${id}'`);
  if (start < 0) throw new Error(`no shard "${id}" in ${SHARD_REGISTRY_PATH}`);
  const next = source.indexOf("id: '", start + 1);
  return source.slice(start, next < 0 ? source.length : next);
}

/** `createPageMetadata` as a call or import, but not as part of the longer name. */
const BARE_METADATA_HELPER = /(?<!BoardContent)\bcreatePageMetadata\b/;

function readRoute(relativePath: string): string {
  return readFileSync(join(WEB_ROOT, relativePath), 'utf8');
}

/**
 * Strip block and line comments so prose naming the helper isn't read as a call.
 *
 * The line-comment pass deliberately requires the `//` not to be preceded by a
 * colon, so `https://…` in a comment or string survives intact. An earlier
 * version matched only FULL-line comments, which left a trailing
 * `doThing(); // createPageMetadata` able to fail the guard spuriously.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('board-content metadata guard', () => {
  it('reads every route file it claims to check', () => {
    // Guard the guard: a bad path would make every assertion below vacuous.
    expect(BOARD_CONTENT_ROUTE_FILES.length).toBe(5);
    for (const relativePath of BOARD_CONTENT_ROUTE_FILES) {
      expect(readRoute(relativePath).length, relativePath).toBeGreaterThan(0);
    }
  });

  it.each(BOARD_CONTENT_ROUTE_FILES)('%s uses the board-content helper', (relativePath) => {
    const source = withoutComments(readRoute(relativePath));
    expect(source, `${relativePath} must import createBoardContentPageMetadata`).toContain(
      'createBoardContentPageMetadata',
    );
  });

  it.each(BOARD_CONTENT_ROUTE_FILES)('%s never reaches for the plain helper', (relativePath) => {
    // The failure this catches: a new metadata call added later that defaults
    // back to self-canonicalising, re-splitting the page across four URLs.
    const source = withoutComments(readRoute(relativePath));
    expect(BARE_METADATA_HELPER.test(source), `${relativePath} still calls createPageMetadata`).toBe(false);
  });

  it('keeps the sitemap in step: shards for these pages list one locale only', () => {
    const registry = readRoute(SHARD_REGISTRY_PATH);
    for (const id of DEFAULT_LOCALE_ONLY_SHARDS) {
      expect(shardLiteral(registry, id), `shard "${id}" must not fan out to locale twins`).toContain(
        "expansion: 'default-locale-only'",
      );
    }
  });

  it('leaves genuinely translated surfaces fanning out to every locale', () => {
    // The counter-assertion. `/about`, `/legal` and `/docs` are real translated
    // content, and cross-canonicalising those is the W-22 "no return links" bug
    // that hreflang-return-metadata.test.ts exists to catch. This carve-out must
    // not spread to them.
    const registry = readRoute(SHARD_REGISTRY_PATH);
    expect(shardLiteral(registry, 'static')).not.toContain('expansion:');
  });
});
