/**
 * Web-fork export parity (issue #4242).
 *
 * `X.ts` / `X.web.ts` (or `.tsx`) pairs let a module diverge for the Expo web
 * target while keeping one import path for callers — Metro swaps in the
 * `.web` file when bundling for the browser. Nothing forces the two files to
 * export the same names. When the native side gains an export and the web
 * fork doesn't, every neutral (non-forked) caller that imports the new name
 * still typechecks against `X.ts` but crashes at runtime on web, because
 * Metro resolved `X.web.ts` and that name isn't there.
 *
 * That's exactly what happened to `session-store.ts` / `session-store.web.ts`
 * (Sentry BOARDSESH-BW): #3502 added `getStoredCreatedSessionId` and its
 * siblings to the native file; the `.web` fork didn't get them for 9 days,
 * until #4199 backfilled it. This test would have caught that the moment the
 * regression landed.
 *
 * The check is usage-based, not "every fork pair must export the same set".
 * A blind superset check fails today on three real, harmless divergences:
 * `auth-store.ts`'s `storeTokensForGeneration`/`clearTokensForGeneration`,
 * `auth.ts`'s `oauthNativeSignIn`, and `share-target-provider.tsx`'s
 * `extractSharedLink`. Each is only ever imported by a module that is *itself*
 * a fork pair's native side (`auth-interceptor.ts`, `auth.ts` importing from
 * `auth-store.ts`) or not imported outside its own file at all — so Metro-web
 * never resolves into the gap. Flagging those would just teach people to
 * ignore the test. Instead this walks the real import graph: for every fork
 * pair, does any *platform-neutral* module (one Metro bundles unchanged for
 * every platform) import a name from the native side that the web fork lacks?
 *
 * Deliberately not modelled (none of these occur in any current fork-pair
 * usage — see .boardsesh/plan-4242.json for the verification):
 *   - `export default`, `export *`, `export class`, destructuring exports
 *   - `import * as ns` namespace access into a forked module
 *   - dynamic `require('./forked-module')` / `import('./forked-module')`
 *     (the one real case, `use-native-climb-render.ts`'s board-renderer
 *     `require`, is a pair that's already export-symmetric today)
 *   - the separate ios/android/web three-way split (`Button`, `SwitchRow`,
 *     `AppMenu`, …), which has no bare `X.ts` native file to diff against —
 *     those ship a hand-written `.d.ts` ambient contract instead.
 * A future contributor exercising one of those patterns against a forked
 * module won't get coverage from this test.
 *
 * No new dependency: `.boardsesh/DECISIONS.md` for #4242 requires reusing the
 * repo's existing `typescript` package for AST work, with `bun.lock`
 * untouched. The pinned `typescript@~7.0.2` (TypeScript's native port) does
 * not expose a source-text parser from its default entry point — its `"."`
 * export resolves only to `lib/version.cjs` (`{version, versionMajorMinor}`);
 * see the same gap documented in `packages/web/scripts/check-orphaned-i18n-keys.ts`
 * and `packages/web/app/__tests__/import-graph-invariant.test.ts`, both of
 * which route around it via the `typescript-compiler-api` (pinned TS 6.x)
 * devDependency alias. Adding that same alias to `packages/mobile` would
 * touch `bun.lock`, which is exactly what's ruled out here. So this file
 * extracts exports and named imports with line-anchored regexes over the
 * statement-starting keyword instead of a real AST walk — verified safe
 * against every one of the 36 real fork pairs in the repo today (no
 * `export default`/`export *`/`export class`/destructuring export, and no
 * mixed `import Default, { … }` import, appears in any of them).
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MOBILE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Directories that never contribute fork pairs or importers. */
const SKIPPED_DIR_NAMES = new Set(['node_modules', '__tests__', 'web-runtime', 'dist', 'ios', 'android']);

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function toMobileRelative(mobileRoot: string, absolutePath: string): string {
  return relative(mobileRoot, absolutePath).split(sep).join('/');
}

function isSourceFile(fileName: string): boolean {
  return fileName.endsWith('.ts') || fileName.endsWith('.tsx');
}

function isTestFile(fileName: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(fileName);
}

/** `.web.`, `.ios.`, `.android.` — a platform fork of some kind. */
function isPlatformSuffixed(fileName: string): boolean {
  return /\.(web|ios|android)\.tsx?$/.test(fileName);
}

function listSourceFiles(absoluteDir: string, collected: string[] = []): string[] {
  if (!existsSync(absoluteDir)) return collected;
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      listSourceFiles(absolutePath, collected);
      continue;
    }
    if (isSourceFile(entry.name)) collected.push(absolutePath);
  }
  return collected;
}

// ---------------------------------------------------------------------------
// Export extraction
// ---------------------------------------------------------------------------

/** Value-level export identifiers a neutral module could import by name. */
function extractExportNames(sourceText: string): Set<string> {
  const names = new Set<string>();

  for (const match of sourceText.matchAll(/^export\s+async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of sourceText.matchAll(/^export\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of sourceText.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of sourceText.matchAll(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  // `export { a, b as c }` and `export { a } from '...'`. `export type { … }`
  // is a separate, type-only statement and is skipped by the `(type\s+)?`
  // capture below when present.
  for (const match of sourceText.matchAll(/^export\s+(type\s+)?\{([^}]*)\}(?:\s*from\s*['"][^'"]+['"])?/gm)) {
    const [, isTypeOnlyStatement, braceContent] = match;
    if (isTypeOnlyStatement) continue;
    for (const name of parseSpecifierExportedNames(braceContent)) names.add(name);
  }

  return names;
}

/**
 * `{ a, b as c, type d }` -> ['a', 'c'] — the name a consumer would import,
 * skipping individually type-only specifiers.
 */
function parseSpecifierExportedNames(braceContent: string): string[] {
  const names: string[] = [];
  for (const rawSpecifier of braceContent.split(',')) {
    const specifier = rawSpecifier.trim().replace(/\s+/g, ' ');
    if (specifier.length === 0) continue;
    if (specifier.startsWith('type ')) continue;
    const asMatch = /^(.+?)\s+as\s+(.+)$/.exec(specifier);
    names.push(asMatch ? asMatch[2] : specifier);
  }
  return names;
}

/**
 * `{ a, b as c, type d }` -> ['a', 'b'] — the name being pulled from the
 * *source* module (left of `as`), skipping individually type-only specifiers.
 * Mirrors `parseSpecifierExportedNames` but keeps the pre-`as` identifier.
 */
function parseSpecifierSourceNames(braceContent: string): string[] {
  const names: string[] = [];
  for (const rawSpecifier of braceContent.split(',')) {
    const specifier = rawSpecifier.trim().replace(/\s+/g, ' ');
    if (specifier.length === 0) continue;
    if (specifier.startsWith('type ')) continue;
    const asMatch = /^(.+?)\s+as\s+(.+)$/.exec(specifier);
    names.push(asMatch ? asMatch[1] : specifier);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Import (and re-export) extraction
// ---------------------------------------------------------------------------

type NamedEdge = { names: string[]; specifier: string; line: number };

function lineOf(sourceText: string, index: number): number {
  let line = 1;
  for (let position = 0; position < index; position += 1) {
    if (sourceText.charCodeAt(position) === 10 /* \n */) line += 1;
  }
  return line;
}

/**
 * Named `import { a, b as c } from '...'` and re-export `export { a } from
 * '...'` edges. `import type { … }` / `export type { … } from '...'`
 * (statement-level) are skipped, as are `import * as ns` and default-only
 * imports (neither has a `{ … }` for the regex to match) — see the module
 * doc comment for why that scope cut is safe today.
 */
function extractNamedEdges(sourceText: string): NamedEdge[] {
  const edges: NamedEdge[] = [];

  const importPattern = /^import\s+(type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
  for (const match of sourceText.matchAll(importPattern)) {
    const [, isTypeOnlyStatement, braceContent, specifier] = match;
    if (isTypeOnlyStatement) continue;
    const names = parseSpecifierSourceNames(braceContent);
    if (names.length === 0) continue;
    edges.push({ names, specifier, line: lineOf(sourceText, match.index ?? 0) });
  }

  const reExportPattern = /^export\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/gm;
  for (const match of sourceText.matchAll(reExportPattern)) {
    const [, isTypeOnlyStatement, braceContent, specifier] = match;
    if (isTypeOnlyStatement) continue;
    const names = parseSpecifierSourceNames(braceContent);
    if (names.length === 0) continue;
    edges.push({ names, specifier, line: lineOf(sourceText, match.index ?? 0) });
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Fork-pair discovery
// ---------------------------------------------------------------------------

type ForkPair = { nativePath: string; webPath: string; nativeExports: Set<string>; webExports: Set<string> };

/** `foo.web.tsx` -> `{ base: 'foo', preferredExt: '.tsx' }`; null if not a `.web` file. */
function webForkBase(absolutePath: string): { base: string; preferredExt: '.ts' | '.tsx' } | null {
  if (absolutePath.endsWith('.web.tsx'))
    return { base: absolutePath.slice(0, -'.web.tsx'.length), preferredExt: '.tsx' };
  if (absolutePath.endsWith('.web.ts')) return { base: absolutePath.slice(0, -'.web.ts'.length), preferredExt: '.ts' };
  return null;
}

/**
 * Pairs a `.web.ts(x)` file with its native `X.ts`/`X.tsx` sibling. Files
 * with no native sibling (the ios/android/web three-way components, and the
 * two web-only files `auth-cookie-lock.web.ts` / `overlay-cache-store.web.ts`)
 * are skipped — there's nothing to diff their exports against.
 */
function discoverForkPairs(allSourceFiles: string[]): ForkPair[] {
  const pairs: ForkPair[] = [];
  for (const filePath of allSourceFiles) {
    const forkBase = webForkBase(filePath);
    if (!forkBase) continue;

    const candidateExtensions: Array<'.ts' | '.tsx'> =
      forkBase.preferredExt === '.tsx' ? ['.tsx', '.ts'] : ['.ts', '.tsx'];
    const nativePath = candidateExtensions.map((ext) => forkBase.base + ext).find((candidate) => existsSync(candidate));
    if (!nativePath) continue;

    pairs.push({
      nativePath,
      webPath: filePath,
      nativeExports: extractExportNames(readFileSync(nativePath, 'utf8')),
      webExports: extractExportNames(readFileSync(filePath, 'utf8')),
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Specifier resolution
// ---------------------------------------------------------------------------

function resolveToFile(candidateBase: string): string | null {
  if (existsSync(candidateBase) && statSync(candidateBase).isFile()) return candidateBase;

  for (const extension of ['.ts', '.tsx']) {
    const withExtension = `${candidateBase}${extension}`;
    if (existsSync(withExtension)) return withExtension;
  }

  if (existsSync(candidateBase) && statSync(candidateBase).isDirectory()) {
    for (const extension of ['.ts', '.tsx']) {
      const indexFile = join(candidateBase, `index${extension}`);
      if (existsSync(indexFile)) return indexFile;
    }
  }

  return null;
}

/** Relative imports resolve against the importer; `@/...` against `src/`; bare packages resolve to null. */
function resolveSpecifier(specifier: string, importerAbsolutePath: string, mobileRoot: string): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolveToFile(resolve(dirname(importerAbsolutePath), specifier));
  }
  if (specifier.startsWith('@/')) {
    return resolveToFile(join(mobileRoot, 'src', specifier.slice('@/'.length)));
  }
  return null; // bare package
}

// ---------------------------------------------------------------------------
// Violation search
// ---------------------------------------------------------------------------

type Violation = { importer: string; line: number; name: string; nativePath: string; webPath: string };

/**
 * Discovers fork pairs under `roots` (default: real `src` + `modules`), then
 * walks every platform-neutral module under `importerRoots` (default: real
 * `src` + `app` — `modules` is fork-pair source material, not itself scanned
 * for importers) for named imports / re-exports that reach into a fork
 * pair's native side for a name the web fork lacks.
 */
function findViolations(
  mobileRoot: string,
  forkPairRoots: string[],
  importerRoots: string[],
): { violations: Violation[]; forkPairs: ForkPair[] } {
  const forkPairSourceFiles = forkPairRoots.flatMap((root) => listSourceFiles(root));
  const forkPairs = discoverForkPairs(forkPairSourceFiles);
  const nativePathToPair = new Map(forkPairs.map((pair) => [pair.nativePath, pair]));

  const importerFiles = importerRoots
    .flatMap((root) => listSourceFiles(root))
    .filter((filePath) => {
      const fileName = basename(filePath);
      if (isTestFile(fileName)) return false;
      if (isPlatformSuffixed(fileName)) return false;
      // The native side of a fork pair is never bundled for web (its `.web`
      // sibling is used instead), so its own imports don't reach Metro-web.
      if (nativePathToPair.has(filePath)) return false;
      return true;
    });

  const violations: Violation[] = [];
  for (const importerPath of importerFiles) {
    const sourceText = readFileSync(importerPath, 'utf8');
    for (const edge of extractNamedEdges(sourceText)) {
      const targetPath = resolveSpecifier(edge.specifier, importerPath, mobileRoot);
      if (targetPath === null) continue;

      const pair = nativePathToPair.get(targetPath);
      if (!pair) continue;

      for (const name of edge.names) {
        if (pair.nativeExports.has(name) && !pair.webExports.has(name)) {
          violations.push({
            importer: toMobileRelative(mobileRoot, importerPath),
            line: edge.line,
            name,
            nativePath: toMobileRelative(mobileRoot, pair.nativePath),
            webPath: toMobileRelative(mobileRoot, pair.webPath),
          });
        }
      }
    }
  }

  return {
    violations: violations.sort(
      (left, right) =>
        left.importer.localeCompare(right.importer) || left.line - right.line || left.name.localeCompare(right.name),
    ),
    forkPairs,
  };
}

function describeViolation(violation: Violation): string {
  return [
    `  packages/mobile/${violation.importer}:${violation.line}`,
    `    imports '${violation.name}' from ${violation.nativePath}`,
    `    which the web fork ${violation.webPath} does not export`,
  ].join('\n');
}

// ---------------------------------------------------------------------------

describe('web-fork export parity: neutral importers never reach a gap in a .web fork', () => {
  const realRoots = {
    mobileRoot: MOBILE_ROOT,
    forkPairRoots: [join(MOBILE_ROOT, 'src'), join(MOBILE_ROOT, 'modules')],
    importerRoots: [join(MOBILE_ROOT, 'src'), join(MOBILE_ROOT, 'app')],
  };

  it('has no unallowed gap across the real repo', () => {
    const { violations, forkPairs } = findViolations(
      realRoots.mobileRoot,
      realRoots.forkPairRoots,
      realRoots.importerRoots,
    );

    // Sanity check the discovery itself found the fork pairs this test is
    // meant to guard — an empty result here would mean the walk is broken,
    // not that the repo has no forks.
    expect(forkPairs.length).toBeGreaterThan(20);

    const report = violations.map(describeViolation).join('\n\n');
    expect(
      violations,
      violations.length === 0
        ? ''
        : [
            `${violations.length} neutral import(s) reach past a gap in a .web fork:`,
            '',
            report,
            '',
            'Add the missing export(s) to the .web fork, or make the importer stop',
            'depending on the platform-specific behaviour.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('catches a session-store-shaped regression: native export dropped from the web fork and imported by a neutral caller', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'web-fork-export-parity-regression-'));
    try {
      writeFileSync(
        join(fixtureDir, 'store.ts'),
        [`export function foo(): void {}`, ``, `export function bar(): void {}`, ``].join('\n'),
      );
      // The regression: the web fork never picked up `bar`.
      writeFileSync(join(fixtureDir, 'store.web.ts'), [`export function foo(): void {}`, ``].join('\n'));
      writeFileSync(join(fixtureDir, 'caller.ts'), [`import { bar } from './store';`, ``, `bar();`, ``].join('\n'));

      const { violations } = findViolations(fixtureDir, [fixtureDir], [fixtureDir]);

      expect(violations).toEqual([
        {
          importer: 'caller.ts',
          line: 1,
          name: 'bar',
          nativePath: 'store.ts',
          webPath: 'store.web.ts',
        },
      ]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('does not flag a native-only export nothing neutral imports (locks in the usage-based design)', () => {
    // Mirrors the real, currently-harmless repo divergences (auth-store.ts's
    // storeTokensForGeneration, auth.ts's oauthNativeSignIn,
    // share-target-provider.tsx's extractSharedLink): the web fork is missing
    // an export, but the only importer is itself a fork pair's native side —
    // so it never reaches Metro-web and must not be flagged. A future
    // contributor "fixing" this into a blind full-export-superset check
    // would immediately red all three real cases; this test exists to stop
    // that.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'web-fork-export-parity-harmless-'));
    try {
      writeFileSync(
        join(fixtureDir, 'store.ts'),
        [`export function foo(): void {}`, ``, `export function nativeOnly(): void {}`, ``].join('\n'),
      );
      writeFileSync(join(fixtureDir, 'store.web.ts'), [`export function foo(): void {}`, ``].join('\n'));
      // `other.ts` is itself the native side of its own fork pair, so it's
      // excluded from the "neutral importer" scan below.
      writeFileSync(
        join(fixtureDir, 'other.ts'),
        [`import { nativeOnly } from './store';`, ``, `nativeOnly();`, ``].join('\n'),
      );
      writeFileSync(join(fixtureDir, 'other.web.ts'), [`export {};`, ``].join('\n'));

      const { violations } = findViolations(fixtureDir, [fixtureDir], [fixtureDir]);

      expect(violations).toEqual([]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('resolves the edge kinds a grep would miss: multi-line import lists, aliases, and export-from re-exports', () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), 'web-fork-export-parity-edge-kinds-'));
    try {
      writeFileSync(join(fixtureDir, 'store.ts'), [`export function onlyNative(): void {}`, ``].join('\n'));
      writeFileSync(join(fixtureDir, 'store.web.ts'), [`export {};`, ``].join('\n'));

      writeFileSync(
        join(fixtureDir, 'multiline-caller.ts'),
        [`import {`, `  onlyNative as renamed,`, `} from './store';`, ``, `renamed();`, ``].join('\n'),
      );
      writeFileSync(join(fixtureDir, 're-export-caller.ts'), [`export { onlyNative } from './store';`, ``].join('\n'));
      // Type-only imports never reach the runtime bundle and must not be flagged.
      writeFileSync(
        join(fixtureDir, 'type-only-caller.ts'),
        [`import type { onlyNative } from './store';`, ``].join('\n'),
      );

      const { violations } = findViolations(fixtureDir, [fixtureDir], [fixtureDir]);

      expect(violations).toEqual([
        {
          importer: 'multiline-caller.ts',
          line: 1,
          name: 'onlyNative',
          nativePath: 'store.ts',
          webPath: 'store.web.ts',
        },
        {
          importer: 're-export-caller.ts',
          line: 1,
          name: 'onlyNative',
          nativePath: 'store.ts',
          webPath: 'store.web.ts',
        },
      ]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
