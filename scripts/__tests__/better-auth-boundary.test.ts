/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const repoRoot = resolve(import.meta.dirname, '../..');

const BACKEND_RUNTIME_PACKAGES = ['@better-auth/drizzle-adapter', '@better-auth/oauth-provider', 'better-auth'];
const PINNED_VERSION = '1.7.17';
const BACKEND_MANIFEST_PATH = 'packages/backend/package.json';
/** The prototype and the partner authority are the only folders allowed to import Better Auth. */
const PROTOTYPE_ROOT = 'packages/backend/src/auth/prototype/';
const PARTNER_ROOT = 'packages/backend/src/auth/partner/';
/** Partner modules that load Better Auth at runtime. Everything else must stay importable with the mode off. */
const PARTNER_RUNTIME_IMPORTERS = ['authority.ts', 'family-guard.ts', 'fence.ts'];

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface DependabotConfig {
  updates: { directory: string; ignore?: { 'dependency-name': string }[] }[];
}

const readRepoFile = (path: string): string => readFileSync(join(repoRoot, path), 'utf8');

const trackedPackageFiles = execFileSync('git', ['ls-files', 'packages'], {
  cwd: repoRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\n')
  .filter(Boolean);

const trackedSourceFiles = trackedPackageFiles.filter((path) => /\.[cm]?[jt]sx?$/.test(path));

const IMPORT_SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)['"`]([^'"`]+)['"`]/g;

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(IMPORT_SPECIFIER)].map(([, specifier]) => specifier);
}

function isBetterAuthSpecifier(specifier: string): boolean {
  return specifier === 'better-auth' || specifier.startsWith('better-auth/') || specifier.startsWith('@better-auth/');
}

function runtimeImportSpecifiers(source: string): string[] {
  // A bare `import type` is erased at compile time, so it cannot pull a module in.
  return importSpecifiers(source.replace(/import\s+type\s[^;]*;/g, ''));
}

function isPrototypeSpecifier(specifier: string): boolean {
  return specifier.includes('/prototype/') || specifier.endsWith('/prototype') || specifier.includes('auth-prototype');
}

function filesImporting(paths: string[], matches: (specifier: string) => boolean): string[] {
  return paths.filter((path) => importSpecifiers(readRepoFile(path)).some(matches));
}

function resolvesIntoPartnerFolder(importerPath: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return /(^|\/)auth\/partner(\/|$)/.test(specifier);
  return `${posix.join(posix.dirname(importerPath), specifier)}/`.startsWith(PARTNER_ROOT);
}

function isProductionSource(path: string): boolean {
  return !path.includes('/__tests__/') && !/\.test\.[cm]?[jt]sx?$/.test(path);
}

describe('import scanner', () => {
  it.each([
    [`import { betterAuth } from 'better-auth';`],
    [`import 'better-auth/api';`],
    [`const loaded = await import('@better-auth/oauth-provider');`],
    [`const loaded = require("@better-auth/drizzle-adapter");`],
    [`export { oauthProvider } from '@better-auth/oauth-provider';`],
  ])('finds %s', (source) => {
    expect(importSpecifiers(source).some(isBetterAuthSpecifier)).toBe(true);
  });

  it.each([[`const cookie = 'better-auth.session_token';`], [`import { hash } from 'bcryptjs';`]])(
    'ignores %s',
    (source) => {
      expect(importSpecifiers(source).some(isBetterAuthSpecifier)).toBe(false);
    },
  );
});

describe('partner folder resolution', () => {
  const importer = 'packages/backend/src/auth/session.ts';

  it.each([
    [importer, './partner/mode'],
    [importer, './partner'],
    ['packages/backend/src/handlers/oauth.ts', '../auth/partner/load-authority'],
    ['packages/backend/src/handlers/deep/route.ts', '../../auth/partner'],
    [importer, 'boardsesh-backend/src/auth/partner/mode'],
  ])('%s importing %s is caught', (path, specifier) => {
    expect(resolvesIntoPartnerFolder(path, specifier)).toBe(true);
  });

  it.each([
    [importer, './partners'],
    [importer, './prototype/authority'],
    ['packages/backend/src/handlers/oauth.ts', '../utils/partner'],
  ])('%s importing %s is not', (path, specifier) => {
    expect(resolvesIntoPartnerFolder(path, specifier)).toBe(false);
  });
});

describe('Better Auth dependency boundary', () => {
  it('is a backend runtime dependency, pinned exactly', () => {
    const manifest = JSON.parse(readRepoFile(BACKEND_MANIFEST_PATH)) as Manifest;
    for (const packageName of BACKEND_RUNTIME_PACKAGES) {
      expect(manifest.dependencies?.[packageName], packageName).toBe(PINNED_VERSION);
      expect(manifest.devDependencies?.[packageName], packageName).toBeUndefined();
    }
  });

  it('is declared by no other workspace package', () => {
    const offenders = trackedPackageFiles
      .filter((path) => path.endsWith('package.json') && path !== BACKEND_MANIFEST_PATH)
      .filter((path) => {
        const manifest = JSON.parse(readRepoFile(path)) as Manifest;
        return Object.keys({
          ...manifest.dependencies,
          ...manifest.devDependencies,
          ...manifest.optionalDependencies,
          ...manifest.peerDependencies,
        }).some(isBetterAuthSpecifier);
      });
    expect(offenders).toEqual([]);
  });

  it('is imported only by the prototype and the partner authority, so web and mobile can never bundle it', () => {
    const importers = filesImporting(trackedSourceFiles, isBetterAuthSpecifier);
    expect(importers.length).toBeGreaterThan(0);
    expect(importers.filter((path) => !path.startsWith(PROTOTYPE_ROOT) && !path.startsWith(PARTNER_ROOT))).toEqual([]);
  });

  it('keeps the prototype out of every production backend module', () => {
    const productionModules = trackedSourceFiles.filter(
      (path) =>
        path.startsWith('packages/backend/src/') && !path.startsWith(PROTOTYPE_ROOT) && isProductionSource(path),
    );
    expect(productionModules.length).toBeGreaterThan(0);
    expect(filesImporting(productionModules, isPrototypeSpecifier)).toEqual([]);
  });

  it('confines runtime Better Auth imports inside the partner folder to the listed modules', () => {
    const partnerModules = trackedSourceFiles.filter(
      (path) => path.startsWith(PARTNER_ROOT) && isProductionSource(path),
    );
    expect(partnerModules.length).toBeGreaterThan(0);
    const runtimeImporters = partnerModules
      .filter((path) => runtimeImportSpecifiers(readRepoFile(path)).some(isBetterAuthSpecifier))
      .map((path) => path.slice(PARTNER_ROOT.length));
    expect(runtimeImporters.sort()).toEqual([...PARTNER_RUNTIME_IMPORTERS].sort());
  });

  it('keeps the partner authority out of production code until a route imports it through the loader', () => {
    const productionModules = trackedSourceFiles.filter(
      (path) =>
        path.startsWith('packages/backend/src/') &&
        !path.startsWith(PROTOTYPE_ROOT) &&
        !path.startsWith(PARTNER_ROOT) &&
        isProductionSource(path),
    );
    expect(productionModules.length).toBeGreaterThan(0);
    const importers = productionModules.filter((path) =>
      importSpecifiers(readRepoFile(path)).some((specifier) => resolvesIntoPartnerFolder(path, specifier)),
    );
    expect(importers).toEqual([]);
  });

  it('reaches the authority only through a dynamic import in the loader', () => {
    const loaderPath = `${PARTNER_ROOT}load-authority.ts`;
    const partnerModules = trackedSourceFiles.filter(
      (path) => path.startsWith(PARTNER_ROOT) && isProductionSource(path),
    );
    const authorityImporters = partnerModules.filter((path) =>
      runtimeImportSpecifiers(readRepoFile(path)).includes('./authority'),
    );
    expect(authorityImporters).toEqual([loaderPath]);
    expect(readRepoFile(loaderPath)).toContain("await import('./authority')");
  });

  it('keeps Dependabot from opening Better Auth upgrades', () => {
    const config = parse(readRepoFile('.github/dependabot.yml')) as DependabotConfig;
    const rootUpdate = config.updates.find((update) => update.directory === '/');
    const ignoredNames = rootUpdate?.ignore?.map((rule) => rule['dependency-name']);
    expect(ignoredNames).toEqual(expect.arrayContaining(['better-auth', '@better-auth/*']));
  });

  it('carries no release-age exclusions for the pinned packages', () => {
    const workspace = parse(readRepoFile('pnpm-workspace.yaml')) as { minimumReleaseAgeExclude?: string[] };
    const excluded = workspace.minimumReleaseAgeExclude ?? [];
    expect(excluded.filter((entry) => /^(?:better-auth|@better-auth\/|better-call)/.test(entry))).toEqual([]);
  });
});
