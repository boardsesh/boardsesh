/**
 * Import-graph invariant (Expo Web Program, phases 4–6).
 *
 * www.boardsesh.com is being reduced to a crawlable SSR front door: marketing,
 * climb view, board list, gym/kiosk/admin, auth and the public API. The classic
 * client climbing UI (queue, party, board control, library, session flow) moves
 * to the React Native app compiled for the browser. Later PRs in the programme
 * delete those directories outright.
 *
 * This test is the safety rail for that demolition. It resolves the real import
 * graph over `packages/web` — path aliases, relative imports with `index.*`
 * resolution, `dynamic(() => import(...))`, `.module.css` imports and
 * `export ... from` re-exports — walks the transitive closure from every
 * surface that survives, and fails on any edge that reaches into the delete
 * set. A grep can't see the `dynamic()` and CSS-module edges, and those are
 * exactly where the entanglement hides.
 *
 * Traversal stops at the first delete-set file. It does not walk *through* one:
 * the delete set is heavily cross-linked internally, so walking through it
 * would drag most of the app into the report and make the allowlist useless.
 *
 * The test starts red on purpose. `import-graph-allowlist.json` holds the edges
 * that are known and already assigned to a later PR; each carries a reason and
 * the PR that cuts it. Removing an entry from that file makes this test fail
 * with the file, line and offending import spelled out. Entries that no longer
 * match a real edge fail too, so the allowlist can't rot.
 */
import { describe, expect, it } from 'vite-plus/test';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// TypeScript 7 is the native port and ships no JS compiler API, so the AST
// walk runs on the pinned 6.x copy. See `typescript-compiler-api` in
// packages/web/package.json.
import ts from 'typescript-compiler-api';
import rawAllowlist from './import-graph-allowlist.json';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Extensions we parse for imports, in the order the bundler tries them. */
const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
/** Leaf assets that participate in the graph but have no outgoing edges. */
const ASSET_EXTENSIONS = ['.css', '.json'];

/** Directories that never contribute product edges. */
const SKIPPED_DIR_NAMES = new Set([
  'node_modules',
  '.next',
  'dist',
  '__tests__',
  '__test-helpers__',
  '__mocks__',
  'test-utils',
]);

// ---------------------------------------------------------------------------
// The delete set
// ---------------------------------------------------------------------------

/** Component directories deleted wholesale by the teardown phases. */
const DELETED_COMPONENT_DIRS = [
  'queue-control',
  'graphql-queue',
  'play-view',
  'persistent-session',
  'party-manager',
  'board-lock',
  'sesh-settings',
  'session',
  'session-creation',
  'session-summary',
  'session-details',
  'playback',
  'healthkit',
  'board-bluetooth-control',
  'board-provider',
  'board-page',
  'climb-actions',
  'logbook',
  'library',
  'board-scroll',
  'playlist-generator',
  'create-climb',
  'hold-classification',
  'new-climb-feed',
  'climb-quality-filter',
  'search-drawer',
  'board-search-drawer',
  'board-selector-drawer',
  'my-boards-drawer',
  'my-gyms-drawer',
  'user-drawer',
  'bottom-tab-bar',
  'onboarding',
  'feedback',
  'grade-picker',
  'board-presence',
  'connection-manager',
];

/**
 * `components/climb-card` survives in part. Only these three modules go — the
 * rest of the directory (climb-icons, climb-title, climb-thumbnail, …) is used
 * by the surviving feed and detail surfaces. Matched on the file stem, so
 * `climb-list-item.module.css` goes with `climb-list-item.tsx`, while
 * `climb-card-cover.tsx` is a different stem and stays.
 */
const DELETED_CLIMB_CARD_STEMS = ['climb-card', 'climb-list-item', 'drawer-climb-header'];

/** Hooks that only exist to serve the classic client climbing UI. */
const DELETED_HOOK_STEMS = [
  'use-tick-save',
  'use-effective-angle',
  'use-bluetooth-scan',
  'use-submit-app-feedback',
  'use-create-session',
  'use-climb-actions-data',
];

/**
 * `app/lib/ble` goes with the board-control UI, except `capacitor-utils.ts`,
 * which the Capacitor retirement notice on the surviving web shell still reads.
 */
const KEPT_BLE_FILES = new Set(['app/lib/ble/capacitor-utils.ts']);

/**
 * `components/settings` is deliberately absent: a later PR keeps two of its
 * sections, so it is not an unconditional delete and this test must not
 * pre-judge it.
 */
function deleteSetLabel(webRelativePath: string): string | null {
  for (const componentDir of DELETED_COMPONENT_DIRS) {
    if (webRelativePath.startsWith(`app/components/${componentDir}/`)) return `components/${componentDir}`;
  }

  if (webRelativePath.startsWith('app/components/climb-card/')) {
    const stem = fileStem(webRelativePath);
    if (DELETED_CLIMB_CARD_STEMS.includes(stem)) return `components/climb-card/${stem}`;
  }

  if (webRelativePath.startsWith('app/hooks/')) {
    const stem = fileStem(webRelativePath);
    if (DELETED_HOOK_STEMS.includes(stem)) return `hooks/${stem}`;
  }

  if (webRelativePath.startsWith('app/lib/live-activity/')) return 'lib/live-activity';
  if (webRelativePath.startsWith('app/lib/ble/') && !KEPT_BLE_FILES.has(webRelativePath)) return 'lib/ble';

  return null;
}

/** `climb-list-item.module.css` → `climb-list-item`; `climb-card.tsx` → `climb-card`. */
function fileStem(webRelativePath: string): string {
  const fileName = webRelativePath.slice(webRelativePath.lastIndexOf('/') + 1);
  return fileName.replace(/\.module\.(css|scss)$/, '').replace(/\.[^.]+$/, '');
}

// ---------------------------------------------------------------------------
// The keep roots
// ---------------------------------------------------------------------------

/** Route directories that stay on the SSR front door. */
const KEPT_ROUTE_DIRS = [
  'gym',
  'gym-claim',
  'kiosk',
  'embed',
  'admin',
  'auth',
  'playlists',
  'profile',
  'setter',
  'api',
  'about',
  'help',
  'docs',
  'legal',
  'privacy',
  'aurora-migration',
  'preview',
  'b',
  'session',
  'join',
  'import-beta',
  'settings',
  'notifications',
  'discover',
  '.well-known',
];

/** Component directories the front door still renders. */
const KEPT_COMPONENT_DIRS = [
  'social',
  'activity-feed',
  'gym-entity',
  'board-entity',
  'kiosk',
  'admin',
  'climb-detail',
  'similar-climbs',
  'beta-videos',
  'charts',
  'home-gym-card',
  'notifications',
  'board-renderer',
  'moonboard-renderer',
  'ui',
  'form',
  'i18n',
  'brand',
  'icons',
  'loading',
  'collapsible-section',
  'auth',
  'account',
  'providers',
  'swipeable-drawer',
  'stats-filter-drawer',
  'stats-filter-bridge',
  'profile-header-bridge',
  'capacitor-retirement',
  'dev-url-dialog',
];

/**
 * Top-level app files that anchor the front door, plus the edge middleware —
 * and the three legacy config-tuple route files W-15 converted into front
 * doors.
 *
 * The `[board_name]/…` tree is not in `KEPT_ROUTE_DIRS` and must not be: most of
 * it (`create`, `import`, `liked`, `logbook`, `playlists`, `play`) is still the
 * classic client UI, which W-17 deletes. The reposition's canonical climb page
 * and board list live in exactly these three files, and `KEPT_ENTRY_FILES` takes
 * arbitrary paths (unlike the directory-scoped list above) so the promotion can
 * be exactly this narrow.
 *
 * **What this promotion does NOT cover, deliberately:** the parent shell,
 * `app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/layout.tsx`. It is
 * not a keep root and is not allowlisted, and it still imports eight delete-set
 * modules (`board-page/header`, `graphql-queue`, the two `connection-manager`
 * providers, `persistent-session`, `queue-control/ui-searchparams-provider`,
 * `queue-control/queue-bridge-context`, `board-page/last-used-board-tracker`).
 * So the three pages below render a server-only front door *inside* a shell
 * that still mounts the header, the queue and the WebSocket providers — the
 * walk proves the page subtree is clean, not the whole response. That shell
 * comes down with the rest of the classic UI in W-16/W-17, and adding its edges
 * here would mean growing the allowlist W-15 is supposed to shrink. Until then
 * `vp run typecheck` is the backstop: it hard-fails the day those modules are
 * deleted while this layout still imports them.
 */
const KEPT_ENTRY_FILES = [
  'app/page.tsx',
  'app/layout.tsx',
  'app/robots.ts',
  'app/manifest.ts',
  'middleware.ts',
  'app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/view/[climb_uuid]/page.tsx',
  'app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/list/page.tsx',
  'app/[board_name]/[layout_id]/[size_id]/[set_ids]/[angle]/list/layout.tsx',
];
/** `sitemap.ts` today, but the programme may split it — match the family. */
const KEPT_SITEMAP_PATTERN = /^app\/sitemap[\w.-]*\.tsx?$/;

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function toWebRelative(absolutePath: string): string {
  return relative(WEB_ROOT, absolutePath).split(sep).join('/');
}

function isTestFile(fileName: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(fileName);
}

function listSourceFiles(absoluteDir: string, collected: string[] = []): string[] {
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
      listSourceFiles(absolutePath, collected);
      continue;
    }
    if (isTestFile(entry.name)) continue;
    if (SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) collected.push(absolutePath);
  }
  return collected;
}

function collectKeepRoots(): string[] {
  const roots: string[] = [];

  for (const routeDir of KEPT_ROUTE_DIRS) {
    const absoluteDir = join(WEB_ROOT, 'app', routeDir);
    if (!existsSync(absoluteDir)) throw new Error(`Keep root app/${routeDir} does not exist — update KEPT_ROUTE_DIRS.`);
    roots.push(...listSourceFiles(absoluteDir));
  }

  for (const componentDir of KEPT_COMPONENT_DIRS) {
    const absoluteDir = join(WEB_ROOT, 'app', 'components', componentDir);
    if (!existsSync(absoluteDir)) {
      throw new Error(`Keep root app/components/${componentDir} does not exist — update KEPT_COMPONENT_DIRS.`);
    }
    roots.push(...listSourceFiles(absoluteDir));
  }

  for (const entryFile of KEPT_ENTRY_FILES) {
    const absolutePath = join(WEB_ROOT, entryFile);
    if (!existsSync(absolutePath)) throw new Error(`Keep root ${entryFile} does not exist — update KEPT_ENTRY_FILES.`);
    roots.push(absolutePath);
  }

  const sitemapFiles = readdirSync(join(WEB_ROOT, 'app'))
    .filter((fileName) => KEPT_SITEMAP_PATTERN.test(`app/${fileName}`))
    .map((fileName) => join(WEB_ROOT, 'app', fileName));
  if (sitemapFiles.length === 0) throw new Error('No app/sitemap*.ts found — update KEPT_SITEMAP_PATTERN.');
  roots.push(...sitemapFiles);

  return [...new Set(roots)];
}

// ---------------------------------------------------------------------------
// Import extraction and resolution
// ---------------------------------------------------------------------------

type ImportEdge = { specifier: string; line: number };

function extractImports(absolutePath: string): ImportEdge[] {
  if (!SOURCE_EXTENSIONS.some((extension) => absolutePath.endsWith(extension))) return [];

  const sourceText = readFileSync(absolutePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    absolutePath,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    absolutePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const edges: ImportEdge[] = [];
  const record = (node: ts.Node, specifier: string) => {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    edges.push({ specifier, line: line + 1 });
  };

  const visit = (node: ts.Node) => {
    // `import x from '…'`, `import '…'`, `export … from '…'`
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) record(node, node.moduleSpecifier.text);
    }
    // `dynamic(() => import('…'))`, `await import('…')`, `require('…')`
    else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const [firstArgument] = node.arguments;
      if ((isDynamicImport || isRequire) && firstArgument && ts.isStringLiteral(firstArgument)) {
        record(firstArgument, firstArgument.text);
      }
    }
    // `typeof import('…')` in type position
    else if (ts.isImportTypeNode(node)) {
      const { argument } = node;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteral(argument.literal)) record(node, argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return edges;
}

/** Mirrors packages/web/tsconfig.json "paths" and the vite.config.ts aliases. */
function aliasToAbsolute(specifier: string, importerAbsolutePath: string): string | null {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolve(dirname(importerAbsolutePath), specifier);
  }
  // Order matters: the specific aliases must win over the catch-all `@/`.
  if (specifier.startsWith('@/lib/')) return join(WEB_ROOT, 'app', 'lib', specifier.slice('@/lib/'.length));
  if (specifier.startsWith('@/c/')) return join(WEB_ROOT, 'app', 'components', specifier.slice('@/c/'.length));
  if (specifier.startsWith('@/')) return join(WEB_ROOT, specifier.slice('@/'.length));
  return null; // bare package — outside packages/web
}

function resolveToFile(candidateBase: string): string | null {
  if (existsSync(candidateBase) && statSync(candidateBase).isFile()) return candidateBase;

  for (const extension of [...SOURCE_EXTENSIONS, ...ASSET_EXTENSIONS]) {
    const withExtension = `${candidateBase}${extension}`;
    if (existsSync(withExtension) && statSync(withExtension).isFile()) return withExtension;
  }

  if (existsSync(candidateBase) && statSync(candidateBase).isDirectory()) {
    for (const extension of SOURCE_EXTENSIONS) {
      const indexFile = join(candidateBase, `index${extension}`);
      if (existsSync(indexFile)) return indexFile;
    }
  }

  return null;
}

function resolveSpecifier(specifier: string, importerAbsolutePath: string): string | null {
  const candidateBase = aliasToAbsolute(specifier, importerAbsolutePath);
  if (candidateBase === null) return null;
  return resolveToFile(candidateBase);
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

type Violation = {
  from: string;
  line: number;
  specifier: string;
  to: string;
  label: string;
};

function findViolations(): Violation[] {
  const violations: Violation[] = [];
  const queue = collectKeepRoots();
  const visited = new Set(queue);

  while (queue.length > 0) {
    const importerAbsolutePath = queue.pop() as string;
    const importerRelativePath = toWebRelative(importerAbsolutePath);

    for (const edge of extractImports(importerAbsolutePath)) {
      const targetAbsolutePath = resolveSpecifier(edge.specifier, importerAbsolutePath);
      if (targetAbsolutePath === null) continue;

      const targetRelativePath = toWebRelative(targetAbsolutePath);
      const label = deleteSetLabel(targetRelativePath);
      if (label !== null) {
        // Stop here. Do not walk through a delete-set file.
        violations.push({
          from: importerRelativePath,
          line: edge.line,
          specifier: edge.specifier,
          to: targetRelativePath,
          label,
        });
        continue;
      }

      if (visited.has(targetAbsolutePath)) continue;
      visited.add(targetAbsolutePath);
      queue.push(targetAbsolutePath);
    }
  }

  return violations.sort(
    (left, right) => left.from.localeCompare(right.from) || left.line - right.line || left.to.localeCompare(right.to),
  );
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

type AllowlistEntry = { from: string; to: string; reason: string; cutBy: string };

const allowlist = rawAllowlist as { entries: AllowlistEntry[] };

function edgeKey(edge: { from: string; to: string }): string {
  return `${edge.from} -> ${edge.to}`;
}

function describeViolation(violation: Violation): string {
  return [
    `  packages/web/${violation.from}:${violation.line}`,
    `    imports '${violation.specifier}'`,
    `    which resolves to ${violation.to}  [delete set: ${violation.label}]`,
  ].join('\n');
}

// ---------------------------------------------------------------------------

describe('import-graph invariant: kept surfaces do not reach into the delete set', () => {
  const violations = findViolations();
  const allowedKeys = new Set(allowlist.entries.map(edgeKey));

  it('has no unallowed edge from a kept surface into the delete set', () => {
    const unallowed = violations.filter((violation) => !allowedKeys.has(edgeKey(violation)));
    const report = unallowed.map(describeViolation).join('\n\n');

    expect(
      unallowed,
      unallowed.length === 0
        ? ''
        : [
            `${unallowed.length} kept file(s) still import the delete set:`,
            '',
            report,
            '',
            'Either cut the edge, or add it to app/__tests__/import-graph-allowlist.json',
            'with a reason and the PR id that removes it.',
          ].join('\n'),
    ).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const liveKeys = new Set(violations.map(edgeKey));
    const stale = allowlist.entries.filter((entry) => !liveKeys.has(edgeKey(entry)));

    expect(
      stale,
      stale.length === 0
        ? ''
        : [
            'These allowlist entries no longer match a real edge — the import was cut,',
            'moved, or the path is misspelled. Delete them from',
            'app/__tests__/import-graph-allowlist.json:',
            '',
            ...stale.map((entry) => `  ${edgeKey(entry)}  (cutBy: ${entry.cutBy})`),
          ].join('\n'),
    ).toEqual([]);
  });

  it('attributes every allowlisted edge to a PR or a teardown group', () => {
    for (const entry of allowlist.entries) {
      // `W-<n>` where the programme PR is already known, otherwise
      // `teardown:<group>` naming the delete-set directory that carries it.
      expect(entry.cutBy, `allowlist entry ${edgeKey(entry)} has no usable cutBy`).toMatch(
        /^(W-\d+|teardown:[a-z0-9-]+)$/,
      );
      expect(entry.reason.length, `allowlist entry ${edgeKey(entry)} has no reason`).toBeGreaterThan(10);
    }
  });

  it('has one allowlist entry per importer/target pair', () => {
    const duplicates = allowlist.entries.map(edgeKey).filter((key, index, keys) => keys.indexOf(key) !== index);
    expect(duplicates, `duplicate allowlist entries: ${duplicates.join(', ')}`).toEqual([]);
  });

  it('does not treat the surviving parts of components/climb-card as deleted', () => {
    // The activity feed imports climb-icons on four surfaces. That module stays,
    // so the delete set must not swallow the whole climb-card directory.
    for (const survivor of ['climb-icons', 'climb-title', 'climb-thumbnail', 'climb-card-cover', 'marquee-text']) {
      expect(
        deleteSetLabel(`app/components/climb-card/${survivor}.tsx`),
        `components/climb-card/${survivor} must survive the teardown`,
      ).toBeNull();
    }
    expect(deleteSetLabel('app/components/climb-card/climb-list-item.tsx')).not.toBeNull();
    expect(deleteSetLabel('app/components/climb-card/climb-list-item.module.css')).not.toBeNull();
  });

  it('resolves the edge kinds a grep would miss', () => {
    // Both kinds are exercised against a scratch fixture rather than against
    // real modules. The obvious live examples — `board-page/climbs-list.tsx`
    // for the dynamic import, `library/library.module.css` for the stylesheet —
    // are both in the delete set, so pinning them here would turn this test
    // into an ENOENT crash the day the teardown lands. What is under test is
    // the resolver, and the resolver outlives every file it walks.
    const fixtureDir = mkdtempSync(join(tmpdir(), 'import-graph-edge-kinds-'));
    try {
      const importer = join(fixtureDir, 'importer.tsx');
      writeFileSync(
        importer,
        [
          `import dynamic from 'next/dynamic';`,
          `import './styles.module.css';`,
          `const Drawer = dynamic(() => import('./drawer'), { ssr: false });`,
          `export default function Importer() {`,
          `  return <Drawer />;`,
          `}`,
        ].join('\n'),
      );
      writeFileSync(join(fixtureDir, 'drawer.tsx'), `export default function Drawer() {\n  return null;\n}\n`);
      writeFileSync(join(fixtureDir, 'styles.module.css'), `.root {\n  color: red;\n}\n`);

      const targets = extractImports(importer)
        .map((edge) => resolveSpecifier(edge.specifier, importer))
        .filter((target): target is string => target !== null);

      // `dynamic(() => import('…'))` — invisible to a plain import grep.
      expect(targets).toContain(join(fixtureDir, 'drawer.tsx'));
      // `.module.css` — an asset edge with no outgoing edges of its own.
      expect(targets).toContain(join(fixtureDir, 'styles.module.css'));
      // A bare package specifier resolves to null rather than a bogus path.
      expect(resolveSpecifier('next/dynamic', importer)).toBeNull();
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
