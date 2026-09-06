/**
 * Invariants for two `next.config.mjs` surfaces that no other test pins.
 *
 * `rewrites()` is what keeps `/api/internal/board-render` answering. The ESP32
 * firmware pins `https://www.boardsesh.com` as its render host
 * (embedded/projects/board-controller/src/config/board_config.h:41, same define
 * at embedded/projects/moonboard-dev-server/src/config/board_config.h:17) and
 * builds that path in `thumbnail_client.cpp`. The Next route behind it was
 * deleted in #4715 and replaced by an unconditional external rewrite to the
 * Railway renderer, so what has to hold now is that the rewrite is
 * unconditional: every `return` in `rewrites()` must carry it, including the
 * two early ones. Miss it on one branch and boards on the wall get a 404 from
 * a build that passed everything else.
 *
 * (W-26's issue text says "keep `outputFileTracingIncludes`" — the WASM include
 * that used to serve this. There is nothing left to keep: #4715 removed the
 * route, and with it the include. The invariant moved, it did not disappear.)
 *
 * `transpilePackages` accumulates dead entries whenever a shared package loses
 * its last web consumer. The reposition teardown left five: `queue-runtime`,
 * `queue-react` and `party-profile` orphaned by W-16's climbing-UI delete
 * (`d5a8336c8`), `ble-protocol` by W-19's `/development` delete (`fac5032af`,
 * its last web reference having been a test file), and `crypto` earlier still —
 * it had zero web consumers from `ed17174cc` (Aurora settings moved to the
 * backend, 2026-06-13), two months before W-16. This test asserts every
 * remaining entry is still *imported* by non-test source under `packages/web`,
 * so a future prune wave — or a revert of this one — has a red test to catch it
 * instead of a silent no-op transpile config.
 *
 * What "imported" means here is load-bearing and was got wrong twice before:
 * the scan anchors on a module-specifier position (`from '…'`, `import '…'`,
 * `import('…')`, `require('…')`), NOT a bare substring of the package name.
 * A prose comment, a JSDoc line or a string literal naming `@boardsesh/<pkg>`
 * anywhere under `packages/web` used to satisfy the check, which made it
 * self-supplying: this file's own `prunedInW26` array is five such literals.
 *
 * Known residual, stated rather than papered over: this is a regex, not a
 * parser, so a comment that quotes a whole import statement
 * (`// re-exported from '@boardsesh/foo'`) still counts. That is why the
 * `prunedInW26` backstop below names the five by hand — belt and braces, not
 * the only working assertion.
 */
import { describe, expect, it } from 'vite-plus/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Rewrite = { source: string; destination: string };

type NextConfig = {
  transpilePackages?: string[];
  rewrites: () => Promise<Rewrite[] | Record<string, Rewrite[]>>;
};

const configModule = await import('../../next.config.mjs');
const nextConfig = configModule.default as unknown as NextConfig;

// Directories that never contain a real first-party import — walking them only
// slows the scan down or (for node_modules) pulls in every dependency's own
// source, which would make the "has a consumer" check vacuous.
const SKIPPED_DIR_NAMES = new Set(['node_modules', '.next', 'dist']);

// `next.config.mjs` names every transpiled package without importing any of
// them — it *is* the list under test — and it is a `.mjs` file, so the walk
// would otherwise read it. (`package.json` needs no entry here: it lists all 36
// @boardsesh workspace deps, but `.json` is not in SOURCE_EXTENSIONS, so the
// walk never opens it.)
const SKIPPED_RELATIVE_FILES = new Set(['next.config.mjs']);

// Test files do not count as consumers. `transpilePackages` exists to make the
// Next *build* compile a workspace package's source; vitest resolves workspace
// TS directly and needs no entry at all. `@boardsesh/ble-protocol` is the worked
// example: after W-16 its only remaining web reference was
// `app/development/components/__tests__/payload-decoder.test.ts`, i.e. an entry
// that was already dead for the build while still looking alive to any scan
// that counts tests. Excluding them also excludes THIS file, whose `prunedInW26`
// array names all five pruned packages as string literals.
//
// Verified safe to tighten: all 21 kept entries still have at least one
// non-test import (counts 1..130), so this narrows the check without
// weakening it.
const TEST_FILE_PATTERN = /(?:^|[\\/])__tests__[\\/]|\.(?:test|spec)\.[cm]?[jt]sx?$/;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** `@boardsesh/board-config/holds` → `@boardsesh/board-config`; `./x` → null. */
function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return null;
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) return segments.length >= 2 ? `${segments[0]}/${segments[1]}` : null;
  return segments[0] || null;
}

/**
 * Collects the packages that are actually imported by non-test source under
 * `rootDir`.
 *
 * The anchor is what makes this a real check: a specifier only counts when it
 * sits where a module specifier can sit — after `from`, after a bare or dynamic
 * `import`, or inside `require(...)`. Matching the package name anywhere in the
 * file counts comments and string literals, which is how the first two versions
 * of this test ended up supplying their own evidence.
 *
 * It collects every package, not just `@boardsesh/*`. Every entry in
 * `transpilePackages` happens to be a workspace package today, but scoping the
 * scan to that prefix would red the suite the day someone legitimately adds a
 * third-party ESM-only dep — a false failure on a correct config is the other
 * way a guard stops being trusted.
 */
function collectImportedPackages(rootDir: string): Set<string> {
  const specifiers = new Set<string>();
  const specifierPattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"]([^'"\n]+)['"]/g;

  const walk = (dir: string) => {
    for (const entryName of readdirSync(dir)) {
      if (SKIPPED_DIR_NAMES.has(entryName)) continue;
      const entryPath = join(dir, entryName);
      const relativePath = entryPath.slice(rootDir.length + 1);
      if (SKIPPED_RELATIVE_FILES.has(relativePath)) continue;

      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        walk(entryPath);
        continue;
      }

      const lastDot = entryName.lastIndexOf('.');
      const extension = lastDot === -1 ? '' : entryName.slice(lastDot);
      if (!SOURCE_EXTENSIONS.has(extension)) continue;
      if (TEST_FILE_PATTERN.test(relativePath)) continue;

      const contents = readFileSync(entryPath, 'utf8');
      for (const match of contents.matchAll(specifierPattern)) {
        const packageName = packageNameOf(match[1]);
        if (packageName) specifiers.add(packageName);
      }
    }
  };

  walk(rootDir);
  return specifiers;
}

describe('next.config.mjs rewrites', () => {
  /**
   * Every rewrite `rewrites()` can return, across all four of its branches.
   *
   * `delete` rather than assigning `undefined`: `process.env` coerces, so
   * `env.BOARDSESH_WEB = undefined` sets the *string* `"undefined"`, which is
   * truthy and steers the config down the wrong branch.
   */
  async function rewriteSetsFor(environment: Record<string, string | undefined>) {
    const saved = { ...process.env };
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      const result = await nextConfig.rewrites();
      const groups = Array.isArray(result) ? { beforeFiles: result } : result;
      return Object.values(groups).flat();
    } finally {
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  }

  // The firmware's host is www in production; the value only has to be a URL
  // the resolver accepts, since what is asserted is the path it appends.
  const WS_URL = 'wss://ws.boardsesh.com/graphql';

  const BRANCHES: [string, Record<string, string | undefined>][] = [
    [
      'production (BOARDSESH_WEB unset)',
      { NEXT_PUBLIC_WS_URL: WS_URL, BOARDSESH_WEB: undefined, NODE_ENV: 'production' },
    ],
    [
      'production with BOARDSESH_WEB=1',
      { NEXT_PUBLIC_WS_URL: WS_URL, BOARDSESH_WEB: '1', BOARDSESH_EXPO_WEB_ORIGIN: undefined, NODE_ENV: 'production' },
    ],
    [
      'dev, no Metro origin',
      { NEXT_PUBLIC_WS_URL: WS_URL, BOARDSESH_WEB: '1', BOARDSESH_EXPO_WEB_ORIGIN: undefined, NODE_ENV: 'development' },
    ],
    [
      'dev with a Metro origin',
      {
        NEXT_PUBLIC_WS_URL: WS_URL,
        BOARDSESH_WEB: '1',
        BOARDSESH_EXPO_WEB_ORIGIN: 'http://127.0.0.1:8081',
        NODE_ENV: 'development',
      },
    ],
  ];

  it.each(BRANCHES)('keeps the ESP32 board-render rewrite on the %s branch', async (_name, environment) => {
    const rewrites = await rewriteSetsFor(environment);
    const boardRender = rewrites.find((rewrite) => rewrite.source === '/api/internal/board-render');

    expect(boardRender, 'the shipped firmware requests this path and cannot be updated').toBeDefined();
    // Pointed at the backend's renderer, not left dangling at a Next route that
    // no longer exists.
    expect(boardRender?.destination).toContain('/render/board');
  });

  it.each(BRANCHES)('keeps the board-geometry rewrite on the %s branch', async (_name, environment) => {
    const rewrites = await rewriteSetsFor(environment);
    const geometry = rewrites.find((rewrite) => rewrite.source === '/api/internal/board-geometry');

    expect(geometry).toBeDefined();
    expect(geometry?.destination).toContain('/render/geometry');
  });
});

describe('next.config.mjs transpilePackages', () => {
  const importedPackages = collectImportedPackages(WEB_ROOT);

  it('is imported by at least one non-test source file under packages/web, for every entry', () => {
    const entries = nextConfig.transpilePackages ?? [];
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(
        importedPackages.has(entry),
        `transpilePackages entry "${entry}" is imported by no non-test source file under packages/web`,
      ).toBe(true);
    }
  });

  it('does not list any of the five packages pruned as dead in W-26 (#4442)', () => {
    const entries = nextConfig.transpilePackages ?? [];
    const prunedInW26 = [
      '@boardsesh/crypto',
      '@boardsesh/ble-protocol',
      '@boardsesh/queue-runtime',
      '@boardsesh/queue-react',
      '@boardsesh/party-profile',
    ];

    for (const prunedEntry of prunedInW26) {
      expect(entries).not.toContain(prunedEntry);
    }
  });
});
