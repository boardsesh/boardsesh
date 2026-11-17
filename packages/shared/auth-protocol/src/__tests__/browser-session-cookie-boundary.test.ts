/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The browser session cookie codec uses `node:crypto` and belongs to the Next
 * server and the backend only. The native app ships this package's other
 * modules by OTA, so the codec must never be reachable from a native entry
 * point: not through the package root, not through a sibling module, and not
 * through any shared package the app depends on.
 */
const repoRoot = resolve(import.meta.dirname, '../../../../..');
const PACKAGE_ROOT = 'packages/shared/auth-protocol';
const CODEC_FILE = `${PACKAGE_ROOT}/src/browser-session-cookie.ts`;
const SUBPATH = '@boardsesh/auth-protocol/browser-session-cookie';
/** Server-only packages that may import the codec. Everything else, including every shared package, may not. */
const ALLOWED_IMPORTER_ROOTS = ['packages/web/', 'packages/backend/', `${PACKAGE_ROOT}/src/__tests__/`];
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
/** A module specifier naming the codec, in a static import, export-from, dynamic import or require. */
const CODEC_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]*browser-session-cookie(?:\.[cm]?[jt]s)?)['"]/g;

const trackedSourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'packages'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((path) => SOURCE_EXTENSIONS.test(path) && !path.includes('/node_modules/'));

function codecSpecifiers(path: string): string[] {
  const source = readFileSync(join(repoRoot, path), 'utf8');
  return [...source.matchAll(CODEC_SPECIFIER)].map((match) => match[1]);
}

describe('browser session cookie import boundary', () => {
  it('finds the tracked sources it scans', () => {
    expect(trackedSourceFiles).toContain(CODEC_FILE);
    expect(trackedSourceFiles.some((path) => path.startsWith('packages/mobile/'))).toBe(true);
  });

  it('is published only as its own subpath', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string }>;
    };
    expect(manifest.exports['./browser-session-cookie']?.default).toBe('./src/browser-session-cookie.ts');
    const otherTargets = Object.entries(manifest.exports)
      .filter(([subpath]) => subpath !== './browser-session-cookie')
      .map(([, target]) => target.default);
    expect(otherTargets).not.toContain('./src/browser-session-cookie.ts');
  });

  it('is imported by no module of its own package, including the root index', () => {
    const importers = trackedSourceFiles.filter(
      (path) =>
        path.startsWith(`${PACKAGE_ROOT}/src/`) &&
        !path.startsWith(`${PACKAGE_ROOT}/src/__tests__/`) &&
        codecSpecifiers(path).length > 0,
    );
    expect(importers).toEqual([]);
  });

  it('is imported from nowhere but the web and backend servers', () => {
    const importers = trackedSourceFiles.filter(
      (path) => !ALLOWED_IMPORTER_ROOTS.some((root) => path.startsWith(root)) && codecSpecifiers(path).length > 0,
    );
    expect(importers).toEqual([]);
  });

  it('recognises every import form it guards against', () => {
    const forms = [
      `import { signBrowserSessionCookie } from '${SUBPATH}';`,
      `export * from "./browser-session-cookie";`,
      `import '../browser-session-cookie.ts';`,
      `const codec = await import('${SUBPATH}');`,
      `const codec = require("${SUBPATH}");`,
    ];
    for (const form of forms) {
      expect([...form.matchAll(CODEC_SPECIFIER)]).toHaveLength(1);
    }
    expect([...`import { parseBrowserSessionMode } from './browser-session-mode';`.matchAll(CODEC_SPECIFIER)]).toEqual(
      [],
    );
  });
});
