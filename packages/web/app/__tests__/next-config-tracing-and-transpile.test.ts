/**
 * Invariants for two `next.config.mjs` keys that no other test pins.
 *
 * `outputFileTracingIncludes` is the only thing that puts the board-renderer
 * WASM binary into the standalone output for `/api/internal/board-render`.
 * That route is the ESP32 firmware's render host
 * (embedded/projects/board-controller/src/config/board_config.h:41 pins
 * `https://www.boardsesh.com`), so deleting the block ships a bundle that
 * 500s for every board on the wall with no CI signal — the standalone build
 * just silently omits the `.wasm` files.
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
 */
import { describe, expect, it } from 'vite-plus/test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type NextConfig = {
  outputFileTracingIncludes?: Record<string, string[]>;
  transpilePackages?: string[];
};

const configModule = await import('../../next.config.mjs');
const nextConfig = configModule.default as unknown as NextConfig;

// Directories that never contain a real `@boardsesh/*` import — walking them
// only slows the scan down or (for node_modules) pulls in every dependency's
// own source, which would make the "has a consumer" check vacuous.
const SKIPPED_DIR_NAMES = new Set(['node_modules', '.next', 'dist']);

// Files that legitimately name every transpiled package without importing it:
// package.json lists all 36 @boardsesh workspace deps and next.config.mjs
// contains the list under test. Neither is a source file the scanner would
// read anyway once the specifier anchor is in place, but they are cheap to
// skip and they document the two obvious sources of false evidence.
const SKIPPED_RELATIVE_FILES = new Set(['package.json', 'next.config.mjs']);

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

/**
 * Collects the `@boardsesh/*` packages that are actually imported by non-test
 * source under `rootDir`.
 *
 * The anchor is what makes this a real check: the specifier only counts when it
 * sits where a module specifier can sit — after `from`, after a bare/dynamic
 * `import`, or inside `require(...)`. Matching the package name anywhere in the
 * file counts comments and string literals, which is how the first two versions
 * of this test ended up supplying their own evidence.
 */
function collectImportedBoardseshPackages(rootDir: string): Set<string> {
  const specifiers = new Set<string>();
  const specifierPattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*['"](@boardsesh\/[a-z0-9-]+)/g;

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
        specifiers.add(match[1]);
      }
    }
  };

  walk(rootDir);
  return specifiers;
}

describe('next.config.mjs outputFileTracingIncludes', () => {
  it('keeps the board-renderer WASM globs for /api/internal/board-render — the ESP32 render host', () => {
    const boardRenderIncludes = nextConfig.outputFileTracingIncludes?.['/api/internal/board-render'];

    expect(boardRenderIncludes).toEqual(
      expect.arrayContaining([
        './node_modules/@boardsesh/board-renderer-wasm/pkg/*.wasm',
        '../../node_modules/@boardsesh/board-renderer-wasm/pkg/*.wasm',
        './public/images/**',
      ]),
    );
  });
});

describe('next.config.mjs transpilePackages', () => {
  const importedPackages = collectImportedBoardseshPackages(WEB_ROOT);

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
