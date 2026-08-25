/// <reference types="node" />

/**
 * Guards the React Native app's wrapper-only board-art rule.
 *
 * Board WebPs are native-wrapper resources, never Metro/OTA assets and never a
 * native network fetch. Remote user media and Expo web CDN URLs are allowed.
 *
 * Usage: vp run check:mobile-board-art-network
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type SourceFile = {
  path: string;
  text: string;
};

export type BoardArtNetworkViolation = {
  path: string;
  line: number;
  rule: string;
  text: string;
};

type Rule = {
  name: string;
  message: string;
  test: (lineText: string) => boolean;
};

const SOURCE_ROOTS = [
  'packages/mobile/app',
  'packages/mobile/src',
  'packages/mobile/modules/live-activity',
  'packages/mobile/modules/board-renderer',
  'packages/mobile/targets/BoardseshWidgets',
  'packages/shared',
] as const;

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.swift', '.kt']);

const IGNORED_PATH_PARTS = [
  '/__tests__/',
  '/generated/',
  '/ios-tests/',
  '/test/',
  '/tests/',
  '.test.ts',
  '.test.tsx',
] as const;

const RULES: readonly Rule[] = [
  {
    name: 'remote-board-image-host',
    message: 'Do not reference hosted board-art URLs from native runtime code; use packaged object keys.',
    test: (lineText) => /https?:\/\/[^"'`\s)]*\/images\//.test(lineText),
  },
  {
    name: 'web-base-board-images',
    message: 'Do not build `${WEB_BASE_URL}/images/...` board-art URLs in mobile runtime code.',
    test: (lineText) => lineText.includes('WEB_BASE_URL') && lineText.includes('/images/'),
  },
  {
    name: 'image-prefetch',
    message: 'Do not prefetch board art with React Native Image.prefetch; resolve packaged assets instead.',
    test: (lineText) => lineText.includes('Image.prefetch'),
  },
  {
    name: 'svg-image-background',
    message: 'Do not render board backgrounds through react-native-svg Image href; use bundled file paths.',
    test: (lineText) => /\bSvgImage\b/.test(lineText),
  },
  {
    name: 'board-art-metro-require',
    message: 'Do not import/require packages/web/public/images; board art must stay out of Metro and OTA bundles.',
    test: (lineText) =>
      /\brequire\s*\([^)]*web\/public\/images/.test(lineText) ||
      /\bimport\s*\(\s*["'][^"']*web\/public\/images/.test(lineText) ||
      /(?:from\s+|import\s*)["'][^"']*web\/public\/images/.test(lineText),
  },
  {
    name: 'expo-asset-board-art',
    message: 'Do not materialize board art through expo-asset; native wrappers own the files.',
    test: (lineText) => lineText.includes("from 'expo-asset'") || lineText.includes('asset.downloadAsync('),
  },
  // NOTE: the `server-rendered-background` rule (forbidding include_background=1)
  // was removed for the 2.0 release. The Live Activity thumbnail now fetches the
  // server-composited board image, matching the legacy Capacitor app, because the
  // on-device bundled-art compositing never rendered correctly in production.
  // Re-adding offline board art (and this guard) is tracked in issue #2982.
] as const;

function shouldScanPath(filePath: string): boolean {
  const normalized = filePath.replaceAll('\\', '/');
  if (IGNORED_PATH_PARTS.some((part) => normalized.includes(part))) return false;
  return SOURCE_EXTENSIONS.has(normalized.slice(normalized.lastIndexOf('.')));
}

function readSourceFiles(rootDir: string): SourceFile[] {
  const sourceFiles: SourceFile[] = [];

  function walk(directory: string): void {
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }

    for (const entry of entries) {
      // Dependencies are not our source, and walking them also walks each
      // package's `node_modules/.bin`, where a stale symlink to a binary a
      // dependency no longer ships (typescript 7 dropped `bin/tsserver`) makes
      // the statSync below throw ENOENT and takes the whole guard down.
      if (entry === 'node_modules') continue;
      const absolutePath = join(directory, entry);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!stats.isFile()) continue;
      const repoRelativePath = relative(rootDir, absolutePath).replaceAll('\\', '/');
      if (!shouldScanPath(repoRelativePath)) continue;
      sourceFiles.push({
        path: repoRelativePath,
        text: readFileSync(absolutePath, 'utf8'),
      });
    }
  }

  for (const sourceRoot of SOURCE_ROOTS) walk(resolve(rootDir, sourceRoot));
  return sourceFiles;
}

export function findMobileBoardArtNetworkViolations(sourceFiles: readonly SourceFile[]): BoardArtNetworkViolation[] {
  const violations: BoardArtNetworkViolation[] = [];

  for (const sourceFile of sourceFiles) {
    const lines = sourceFile.text.split(/\r?\n/);
    lines.forEach((lineText, lineIndex) => {
      for (const rule of RULES) {
        if (!rule.test(lineText)) continue;
        violations.push({
          path: sourceFile.path,
          line: lineIndex + 1,
          rule: `${rule.name}: ${rule.message}`,
          text: lineText.trim(),
        });
      }
    });
  }

  return violations;
}

export function main(): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const violations = findMobileBoardArtNetworkViolations(readSourceFiles(repoRoot));

  if (violations.length > 0) {
    console.error('[mobile-board-art-network] FAILED - native board-art packaging invariant was violated:');
    for (const violation of violations) {
      console.error(`  ${violation.path}:${violation.line} ${violation.rule}`);
      console.error(`    ${violation.text}`);
    }
    return 1;
  }

  console.log('[mobile-board-art-network] OK - board art stays out of Metro/OTA and native network fetches.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
