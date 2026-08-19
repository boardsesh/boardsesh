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
 * `transpilePackages` accumulates dead entries whenever a shared package
 * loses its last web consumer (W-16's climbing-UI delete left five). This
 * test asserts every remaining entry still has a real import somewhere under
 * `packages/web`, so a future prune wave — or a revert of this one — has a
 * red test to catch it instead of a silent no-op transpile config.
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

// Files that legitimately name every transpiled package without being an
// "import" of it — package.json lists all 36 @boardsesh workspace deps and
// next.config.mjs contains the list under test. Including either would make
// assertion (b) trivially true for any entry, including the five just
// pruned. This test file is skipped too: `prunedInW26` below spells out the
// five pruned package names as string literals, which would otherwise supply
// false "consumer" evidence for itself and blind the "has a real import"
// assertion to exactly the regression it exists to catch.
const SKIPPED_RELATIVE_FILES = new Set([
  'package.json',
  'next.config.mjs',
  'app/__tests__/next-config-tracing-and-transpile.test.ts',
]);

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

function collectBoardseshSpecifiers(rootDir: string): Set<string> {
  const specifiers = new Set<string>();
  const specifierPattern = /@boardsesh\/[a-z0-9-]+/g;

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

      const contents = readFileSync(entryPath, 'utf8');
      for (const match of contents.matchAll(specifierPattern)) {
        specifiers.add(match[0]);
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
  const specifiers = collectBoardseshSpecifiers(WEB_ROOT);

  it('has at least one real web import for every entry', () => {
    const entries = nextConfig.transpilePackages ?? [];
    expect(entries.length).toBeGreaterThan(0);

    for (const entry of entries) {
      expect(specifiers.has(entry), `transpilePackages entry "${entry}" has no import under packages/web`).toBe(true);
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
