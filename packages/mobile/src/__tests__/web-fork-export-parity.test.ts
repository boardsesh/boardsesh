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
 * every platform) import a name from the contract side that the web fork lacks?
 *
 * Two kinds of pair are checked, both keyed on the same question — what does a
 * caller typecheck against, and what does Metro-web actually bundle?
 *   - `X.ts`/`X.tsx` + `X.web.ts(x)` — the store/provider forks. The bare file
 *     is both the native implementation and the type contract.
 *   - `X.d.ts` + `X.web.tsx` — the ios/android/web three-way primitives
 *     (`Button`, `SwitchRow`, `AppMenu`, `MoreForm`, …). There is no bare
 *     `X.ts`; the hand-written ambient `.d.ts` is the contract every caller
 *     typechecks against, while Metro-web resolves `X.web.tsx`. A name
 *     declared in the `.d.ts` and implemented in `X.ios.tsx` but missing from
 *     `X.web.tsx` is the same silent runtime crash, in the files that churn
 *     most — every native-control migration touches them.
 *
 * Deliberately not modelled (none of these occur in any current fork-pair
 * usage — re-verified across `src` + `app` + `modules` on every pair):
 *   - `export default`, `export *`, destructuring exports
 *   - `import * as ns` namespace access into a forked module, and default-only
 *     `import Default from './forked-module'`. A mixed
 *     `import Default, { … }` *is* handled — only its named half is checked.
 *   - dynamic `require('./forked-module')` / `import('./forked-module')`
 *     (the one real case, `use-native-climb-render.ts`'s board-renderer
 *     `require`, is a pair that's already export-symmetric today)
 *   - the *other* web-fork mechanism: `metro.config.js`'s `WEB_SHIM_MODULES`
 *     redirects seven bare specifiers (`expo-secure-store`, `expo-sqlite`,
 *     `@expo/ui/community/bottom-sheet`, `@react-native-community/blur`, …)
 *     to `src/web-shims/*` on the web platform only. Same drift class, but
 *     callers reach those through namespace/default imports of a *bare*
 *     specifier, so none of the resolution machinery here applies. Checked by
 *     hand when this landed: every member currently used is present in its
 *     shim.
 *   - signature drift: the same name on both sides with a different parameter
 *     list or return type typechecks clean (callers only ever resolve the
 *     contract file) and still breaks web at runtime.
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
 * against every real fork pair in the repo (no `export default`, `export *`
 * or destructuring export appears in any of them). Note the failure modes are
 * asymmetric but self-limiting: an export shape the regexes miss is missed on
 * *both* sides of a pair, so it yields a silent pass rather than a false
 * alarm, and the fork-pair / importer-count floors in the real-repo test keep
 * the discovery itself from quietly collapsing to nothing.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

/**
 * Statement-starting declarations that publish a *value* under a name. `enum`
 * is here because it emits a runtime object; `type`/`interface` are not,
 * because they vanish at build time and a web fork missing one can't crash
 * anything. `declare` is optional throughout so the same patterns read an
 * ambient `X.d.ts` contract and a real implementation file.
 */
const VALUE_EXPORT_PATTERNS: RegExp[] = [
  /^export\s+(?:declare\s+)?async\s+function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:declare\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm,
  // The `(?!enum\s)` guard keeps `export const enum Foo` out of this pattern,
  // which would otherwise capture the literal word `enum` as the export name.
  /^export\s+(?:declare\s+)?(?:const|let|var)\s+(?!enum\s)([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm,
  /^export\s+(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/gm,
];

/** Value-level export identifiers a neutral module could import by name. */
function extractExportNames(sourceText: string): Set<string> {
  const names = new Set<string>();

  for (const pattern of VALUE_EXPORT_PATTERNS) {
    for (const match of sourceText.matchAll(pattern)) names.add(match[1]);
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

/**
 * `contractPath` is the file a caller typechecks against: the bare native
 * `X.ts(x)` for a store-style fork, or the hand-written ambient `X.d.ts` for
 * an ios/android/web three-way primitive that has no bare implementation.
 * `webPath` is what Metro actually bundles for the browser.
 */
type ForkPair = { contractPath: string; webPath: string; contractExports: Set<string>; webExports: Set<string> };

/** `foo.web.tsx` -> `{ base: 'foo', preferredExt: '.tsx' }`; null if not a `.web` file. */
function webForkBase(absolutePath: string): { base: string; preferredExt: '.ts' | '.tsx' } | null {
  if (absolutePath.endsWith('.web.tsx'))
    return { base: absolutePath.slice(0, -'.web.tsx'.length), preferredExt: '.tsx' };
  if (absolutePath.endsWith('.web.ts')) return { base: absolutePath.slice(0, -'.web.ts'.length), preferredExt: '.ts' };
  return null;
}

/**
 * Pairs a `.web.ts(x)` file with the module a caller typechecks against:
 * the bare native `X.ts`/`X.tsx` sibling when there is one, otherwise the
 * hand-written ambient `X.d.ts`. The `.d.ts` case covers the ios/android/web
 * three-way primitives (`Button`, `SwitchRow`, `MoreForm`, …) — they have no
 * bare implementation file, but their declaration file is exactly the export
 * list every caller compiles against, so a name it declares that
 * `X.web.tsx` doesn't implement is the same web-only runtime crash.
 *
 * A `.web` file with neither sibling (`auth-cookie-lock.web.ts`,
 * `overlay-cache-store.web.ts`) is web-only: nothing to diff against.
 */
function discoverForkPairs(allSourceFiles: string[]): ForkPair[] {
  const pairs: ForkPair[] = [];
  for (const filePath of allSourceFiles) {
    const forkBase = webForkBase(filePath);
    if (!forkBase) continue;

    const candidateExtensions: Array<'.ts' | '.tsx' | '.d.ts'> =
      forkBase.preferredExt === '.tsx' ? ['.tsx', '.ts', '.d.ts'] : ['.ts', '.tsx', '.d.ts'];
    const contractPath = candidateExtensions
      .map((ext) => forkBase.base + ext)
      .find((candidate) => existsSync(candidate));
    if (!contractPath) continue;

    pairs.push({
      contractPath,
      webPath: filePath,
      contractExports: extractExportNames(readFileSync(contractPath, 'utf8')),
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

  // `.d.ts` last: it only wins when there is no implementation file at all,
  // which is exactly the ios/android/web three-way case.
  for (const extension of ['.ts', '.tsx', '.d.ts']) {
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

type Violation = { importer: string; line: number; name: string; contractPath: string; webPath: string };

/**
 * Discovers fork pairs under `forkPairRoots`, then walks every
 * platform-neutral module under `importerRoots` for named imports /
 * re-exports that reach into a fork pair's contract side for a name the web
 * fork lacks. Against the real repo both roots are the same three trees
 * (`src`, `app`, `modules`): Metro applies the `.web` platform extension in
 * all of them, so a fork pair can live in any one, and a module in any one
 * can be the neutral importer that falls into the gap. Keeping the two root
 * lists identical also keeps the "is this importer itself a fork native
 * side?" exclusion honest — a pair discovered in one list but not the other
 * would make its native side look neutral.
 *
 * `importerCount` comes back so callers can assert the walk actually found
 * something: an empty importer list produces zero violations, which reads as
 * a pass.
 */
function findViolations(
  mobileRoot: string,
  forkPairRoots: string[],
  importerRoots: string[],
): { violations: Violation[]; forkPairs: ForkPair[]; importerCount: number } {
  const forkPairSourceFiles = forkPairRoots.flatMap((root) => listSourceFiles(root));
  const forkPairs = discoverForkPairs(forkPairSourceFiles);
  const contractPathToPair = new Map(forkPairs.map((pair) => [pair.contractPath, pair]));

  const importerFiles = importerRoots
    .flatMap((root) => listSourceFiles(root))
    .filter((filePath) => {
      const fileName = basename(filePath);
      if (isTestFile(fileName)) return false;
      if (isPlatformSuffixed(fileName)) return false;
      // A declaration file emits nothing at runtime, so it can't be the module
      // that falls into a gap — it's only ever a pair's contract side.
      if (fileName.endsWith('.d.ts')) return false;
      // The native side of a fork pair is never bundled for web (its `.web`
      // sibling is used instead), so its own imports don't reach Metro-web.
      if (contractPathToPair.has(filePath)) return false;
      return true;
    });

  const violations: Violation[] = [];
  for (const importerPath of importerFiles) {
    const sourceText = readFileSync(importerPath, 'utf8');
    for (const edge of extractNamedEdges(sourceText)) {
      const targetPath = resolveSpecifier(edge.specifier, importerPath, mobileRoot);
      if (targetPath === null) continue;

      const pair = contractPathToPair.get(targetPath);
      if (!pair) continue;

      for (const name of edge.names) {
        if (pair.contractExports.has(name) && !pair.webExports.has(name)) {
          violations.push({
            importer: toMobileRelative(mobileRoot, importerPath),
            line: edge.line,
            name,
            contractPath: toMobileRelative(mobileRoot, pair.contractPath),
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
    importerCount: importerFiles.length,
  };
}

function describeViolation(violation: Violation): string {
  return [
    `  packages/mobile/${violation.importer}:${violation.line}`,
    `    imports '${violation.name}' from ${violation.contractPath}`,
    `    which the web fork ${violation.webPath} does not export`,
  ].join('\n');
}

// ---------------------------------------------------------------------------

describe('web-fork export parity: neutral importers never reach a gap in a .web fork', () => {
  const realTrees = [join(MOBILE_ROOT, 'src'), join(MOBILE_ROOT, 'app'), join(MOBILE_ROOT, 'modules')];
  const realRoots = { mobileRoot: MOBILE_ROOT, forkPairRoots: realTrees, importerRoots: realTrees };

  it('scans every tree it claims to — a missing root must fail, not silently skip', () => {
    // `listSourceFiles` returns [] for a directory that doesn't exist, so a
    // renamed or moved tree would drop out of both lists with no failure: the
    // real-repo check below would keep passing while covering nothing there.
    // Most fork pairs live under `src`, so even the fork-pair floor wouldn't
    // notice. Name the roots explicitly instead.
    for (const root of realTrees) {
      expect(
        existsSync(root),
        `${toMobileRelative(MOBILE_ROOT, root)} is no longer a directory under packages/mobile —
update realTrees (and confirm Metro still applies .web resolution there)
rather than letting this check quietly stop scanning it.`,
      ).toBe(true);
    }
  });

  it('has no unallowed gap across the real repo', () => {
    const { violations, forkPairs, importerCount } = findViolations(
      realRoots.mobileRoot,
      realRoots.forkPairRoots,
      realRoots.importerRoots,
    );

    // Sanity check the discovery itself found the fork pairs and the neutral
    // modules this test is meant to guard. Both walks return an empty list for
    // a tree that isn't there, and an empty importer list yields zero
    // violations — which reads exactly like a pass. Floors sit well under
    // today's counts (56 pairs, 13 of them `.d.ts`-contract, 890 importers) so
    // ordinary churn doesn't trip them.
    expect(forkPairs.length).toBeGreaterThan(20);
    expect(importerCount).toBeGreaterThan(200);
    // The ios/android/web primitives only pair through their ambient `.d.ts`.
    // Without this they'd drop out of the check the moment that resolution
    // broke, and nothing else here would notice.
    expect(forkPairs.filter((pair) => pair.contractPath.endsWith('.d.ts')).length).toBeGreaterThan(5);

    // One missing export on a widely-used primitive (Button has 72 neutral
    // importers) would otherwise print a wall of near-identical entries. The
    // first handful names the gap; the count above says how wide it is.
    const REPORTED_VIOLATION_LIMIT = 15;
    const report = [
      ...violations.slice(0, REPORTED_VIOLATION_LIMIT).map(describeViolation),
      ...(violations.length > REPORTED_VIOLATION_LIMIT
        ? [`  … and ${violations.length - REPORTED_VIOLATION_LIMIT} more`]
        : []),
    ].join('\n\n');
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
          contractPath: 'store.ts',
          webPath: 'store.web.ts',
        },
      ]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('catches a Button-shaped regression: a .d.ts contract the .web fork does not implement', () => {
    // The ios/android/web three-way primitives (Button, SwitchRow, MoreForm,
    // …) have no bare `X.ts` — the hand-written `X.d.ts` is what every caller
    // compiles against, while Metro-web resolves `X.web.tsx`. Add a control to
    // the `.d.ts` + the native implementations and forget the web one and you
    // get the identical crash the store forks produce, so the `.d.ts` counts
    // as a contract side here.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'web-fork-export-parity-ambient-'));
    try {
      writeFileSync(
        join(fixtureDir, 'Button.d.ts'),
        [
          `export declare function Button(props: { title: string }): null;`,
          `export declare const BUTTON_HEIGHT: number;`,
          ``,
        ].join('\n'),
      );
      writeFileSync(
        join(fixtureDir, 'Button.ios.tsx'),
        [`export function Button(): null { return null; }`, ``].join('\n'),
      );
      // The regression: the web implementation never picked up BUTTON_HEIGHT.
      writeFileSync(
        join(fixtureDir, 'Button.web.tsx'),
        [`export function Button(): null { return null; }`, ``].join('\n'),
      );
      writeFileSync(
        join(fixtureDir, 'screen.tsx'),
        [`import { Button, BUTTON_HEIGHT } from './Button';`, ``, `void [Button, BUTTON_HEIGHT];`, ``].join('\n'),
      );

      const { violations, forkPairs } = findViolations(fixtureDir, [fixtureDir], [fixtureDir]);

      expect(forkPairs.map((pair) => pair.contractPath.endsWith('Button.d.ts'))).toEqual([true]);
      expect(violations).toEqual([
        {
          importer: 'screen.tsx',
          line: 1,
          name: 'BUTTON_HEIGHT',
          contractPath: 'Button.d.ts',
          webPath: 'Button.web.tsx',
        },
      ]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  it('extracts the value-export shapes a crash can hide behind: enum, abstract class, declare', () => {
    // Each of these emits a runtime value, so a web fork missing one is a real
    // crash. Missing them in `extractExportNames` is a silent pass, not a
    // visible failure, which is the worst way for a guard to break.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'web-fork-export-parity-shapes-'));
    try {
      writeFileSync(
        join(fixtureDir, 'shapes.ts'),
        [
          `export enum Direction { Up, Down }`,
          `export const enum Fixed { One }`,
          `export abstract class Base {}`,
          // A type-only export must NOT be treated as a value: it vanishes at
          // build time, so a web fork lacking it cannot crash anything.
          `export type Only = 'type';`,
          ``,
        ].join('\n'),
      );
      writeFileSync(join(fixtureDir, 'shapes.web.ts'), [`export type Only = 'type';`, ``].join('\n'));
      writeFileSync(
        join(fixtureDir, 'caller.ts'),
        [`import { Direction, Fixed, Base } from './shapes';`, ``, `void [Direction, Fixed, Base];`, ``].join('\n'),
      );
      writeFileSync(join(fixtureDir, 'type-caller.ts'), [`import { Only } from './shapes';`, ``].join('\n'));

      const { violations } = findViolations(fixtureDir, [fixtureDir], [fixtureDir]);

      expect(violations.map((violation) => violation.name)).toEqual(['Base', 'Direction', 'Fixed']);
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

  it('spans trees: a fork pair in one root is checked against an importer in another', () => {
    // The real run scans `src`, `app` and `modules` as both fork-pair source
    // and importer source. Dropping a tree from either list silently loses
    // coverage — a pair in an unscanned tree is invisible, and its native
    // side then looks like a neutral importer. This locks that in.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'web-fork-export-parity-cross-tree-'));
    try {
      const treeWithPair = join(fixtureDir, 'src');
      const treeWithImporter = join(fixtureDir, 'app');
      mkdirSync(treeWithPair);
      mkdirSync(treeWithImporter);

      writeFileSync(join(treeWithPair, 'store.ts'), [`export function onlyNative(): void {}`, ``].join('\n'));
      writeFileSync(join(treeWithPair, 'store.web.ts'), [`export {};`, ``].join('\n'));
      writeFileSync(
        join(treeWithImporter, 'screen.ts'),
        [`import { onlyNative } from '../src/store';`, ``, `onlyNative();`, ``].join('\n'),
      );

      const { violations } = findViolations(
        fixtureDir,
        [treeWithPair, treeWithImporter],
        [treeWithPair, treeWithImporter],
      );

      expect(violations).toEqual([
        {
          importer: 'app/screen.ts',
          line: 1,
          name: 'onlyNative',
          contractPath: 'src/store.ts',
          webPath: 'src/store.web.ts',
        },
      ]);
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
          contractPath: 'store.ts',
          webPath: 'store.web.ts',
        },
        {
          importer: 're-export-caller.ts',
          line: 1,
          name: 'onlyNative',
          contractPath: 'store.ts',
          webPath: 'store.web.ts',
        },
      ]);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
