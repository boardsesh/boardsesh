/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The viewer marker module (#7596) is for www's server and client and the
 * codec beside it. Native code never imports it: the phone bundle ships this
 * package's other modules by OTA, and acceptance 7 keeps native unchanged.
 * Expo web carries its own copy in a `.web` file (`viewer-marker.web.ts`),
 * held to the same value vector, so the app package needs no new dependency.
 */
const repoRoot = resolve(import.meta.dirname, '../../../../..');
const PACKAGE_ROOT = 'packages/shared/auth-protocol';
const MODULE_FILE = `${PACKAGE_ROOT}/src/viewer-marker.ts`;
const SUBPATH = '@boardsesh/auth-protocol/viewer-marker';
/** The only importers outside www and the backend: the codec, and this package's tests. */
const ALLOWED_IMPORTERS = [`${PACKAGE_ROOT}/src/browser-session-cookie.ts`];
const ALLOWED_IMPORTER_ROOTS = ['packages/web/', 'packages/backend/', `${PACKAGE_ROOT}/src/__tests__/`];
const SOURCE_EXTENSIONS = /\.(?:[cm]?[jt]sx?)$/;
const MODULE_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"]([^'"]*(?:auth-protocol\/viewer-marker|\/viewer-marker)(?:\.[cm]?[jt]s)?)['"]/g;

const trackedSourceFiles = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'packages'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter((path) => SOURCE_EXTENSIONS.test(path) && !path.includes('/node_modules/'));

function moduleSpecifiers(path: string): string[] {
  const source = readFileSync(join(repoRoot, path), 'utf8');
  return [...source.matchAll(MODULE_SPECIFIER)]
    .map((match) => match[1])
    .filter((specifier) => specifier.includes('auth-protocol') || path.startsWith(PACKAGE_ROOT));
}

describe('viewer marker import boundary', () => {
  it('finds the tracked sources it scans', () => {
    expect(trackedSourceFiles).toContain(MODULE_FILE);
    expect(trackedSourceFiles.some((path) => path.startsWith('packages/mobile/'))).toBe(true);
  });

  it('is published only as its own subpath', () => {
    const manifest = JSON.parse(readFileSync(join(repoRoot, PACKAGE_ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string }>;
    };
    expect(manifest.exports['./viewer-marker']?.default).toBe('./src/viewer-marker.ts');
    const otherTargets = Object.entries(manifest.exports)
      .filter(([subpath]) => subpath !== './viewer-marker')
      .map(([, target]) => target.default);
    expect(otherTargets).not.toContain('./src/viewer-marker.ts');
  });

  it('is imported inside its package by the codec only, never by the root index', () => {
    const importers = trackedSourceFiles.filter(
      (path) =>
        path.startsWith(`${PACKAGE_ROOT}/src/`) &&
        !path.startsWith(`${PACKAGE_ROOT}/src/__tests__/`) &&
        moduleSpecifiers(path).length > 0,
    );
    expect(importers).toEqual(ALLOWED_IMPORTERS);
  });

  it('is imported from nowhere but www, the backend and the codec: never from the app or a shared package', () => {
    const importers = trackedSourceFiles.filter(
      (path) =>
        !ALLOWED_IMPORTER_ROOTS.some((root) => path.startsWith(root)) &&
        !ALLOWED_IMPORTERS.includes(path) &&
        moduleSpecifiers(path).length > 0,
    );
    expect(importers).toEqual([]);
  });

  it('recognises every import form it guards against', () => {
    const forms = [
      `import { readViewerMarker } from '${SUBPATH}';`,
      `const marker = await import('${SUBPATH}');`,
      `const marker = require("${SUBPATH}");`,
    ];
    for (const form of forms) expect([...form.matchAll(MODULE_SPECIFIER)]).toHaveLength(1);
  });
});
