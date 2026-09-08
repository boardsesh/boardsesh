/**
 * The screenshot fixture set, checked against the operations the app actually
 * sends today.
 *
 * A recorded fixture is a frozen copy of what the backend answered months ago.
 * Nothing in the repo makes it rot loudly: a document that grew a field misses
 * its fixture only when a capture runs (on a macOS runner, on demand), and a
 * fixture whose body quietly lost a field never misses at all — the screen just
 * renders a blank. This test moves both failures onto every PR, and it also
 * validates the whole mobile operation set against the schema, which nothing
 * else did.
 *
 * The three checks:
 *   (a) every document mobile sends parses and validates against the schema;
 *   (b) every manifest entry still names a document the app has, at the hash it
 *       was recorded at, and each fixture's own hashes recompute from its bytes;
 *   (c) every field the current document selects is present in the recorded
 *       response.
 *
 * Only (a) runs before a fixture set exists; the rest skip themselves.
 *
 * `scripts/lib/screenshot-fixtures.ts` is imported by relative path on purpose —
 * it is a pure module with no `node:` imports, kept that way so this
 * React Native test project can share the exact keying the backend records with.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { buildSchema, parse, validate, type DocumentNode, type GraphQLSchema } from 'graphql';
import { typeDefs } from '@boardsesh/shared-schema';
import { listSyncPullDocuments } from '@boardsesh/offline-sync';

import * as mobileOperations from '../operations';
import * as sharedOperations from '@boardsesh/graphql/operations';
import * as sharedAccount from '@boardsesh/graphql/operations/account';
import * as sharedActivityFeed from '@boardsesh/graphql/operations/activity-feed';
import * as sharedBetaLinks from '@boardsesh/graphql/operations/beta-links';
import * as sharedBoardPresence from '@boardsesh/graphql/operations/board-presence';
import * as sharedBoards from '@boardsesh/graphql/operations/boards';
import * as sharedFavorites from '@boardsesh/graphql/operations/favorites';
import * as sharedGyms from '@boardsesh/graphql/operations/gyms';
import * as sharedIntegrations from '@boardsesh/graphql/operations/integrations';
import * as sharedNewClimbFeed from '@boardsesh/graphql/operations/new-climb-feed';
import * as sharedPlaylists from '@boardsesh/graphql/operations/playlists';
import * as sharedProposals from '@boardsesh/graphql/operations/proposals';
import * as sharedQa from '@boardsesh/graphql/operations/qa';
import * as sharedQueueSession from '@boardsesh/graphql/operations/queue-session';

import {
  RE_RECORD_COMMAND,
  canonicalJson,
  normalizeDocument,
  resolveOperationName,
  stripIgnoredVariablePaths,
  validateScreenshotFixtureManifest,
  type GraphqlFixtureFile,
  type ScreenshotFixtureManifest,
} from '../../../../../../scripts/lib/screenshot-fixtures';
import { checkSelectionCoverage } from './fixture-selection-coverage';

const MOBILE_OPERATIONS_PATH = 'packages/mobile/src/lib/graphql/operations.ts';
const MOBILE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REPO_ROOT = join(MOBILE_ROOT, '..', '..');
const MOBILE_OPERATIONS_ABSOLUTE_PATH = join(MOBILE_ROOT, 'src', 'lib', 'graphql', 'operations.ts');
const FIXTURES_DIR = join(MOBILE_ROOT, 'screenshot-fixtures');
const MANIFEST_PATH = join(FIXTURES_DIR, 'manifest.json');

/**
 * Every `packages/shared/*-react` package mobile depends on, resolved to its
 * `src` directory.
 *
 * A shared `*-react` package (`@boardsesh/board-react`, `@boardsesh/playlists-react`,
 * …) sends GraphQL documents from its own hooks — `use-logbook.ts` sends
 * `GetTicks`, `use-discover-playlists.ts` sends `DiscoverPlaylists` — so the
 * import scanner has to read its source too, not just `packages/mobile/src`
 * and `packages/mobile/app`. Derived from `packages/mobile/package.json`
 * rather than hand-listed so a newly added `*-react` dependency is picked up
 * automatically; each resolved directory is asserted to exist so a renamed
 * package fails loudly here instead of silently shrinking the registry.
 */
function resolveSharedReactPackageRoots(): string[] {
  const mobilePackageJsonPath = join(MOBILE_ROOT, 'package.json');
  const mobilePackageJson = JSON.parse(readFileSync(mobilePackageJsonPath, 'utf8')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencyNames = [
    ...Object.keys(mobilePackageJson.dependencies ?? {}),
    ...Object.keys(mobilePackageJson.devDependencies ?? {}),
  ];
  const reactPackageNames = dependencyNames.filter((name) => /^@boardsesh\/.+-react$/.test(name));
  return reactPackageNames
    .map((name) => {
      const packageDirName = name.slice('@boardsesh/'.length);
      const packageSrcDir = join(REPO_ROOT, 'packages', 'shared', packageDirName, 'src');
      if (!existsSync(packageSrcDir)) {
        throw new Error(
          `packages/mobile/package.json depends on ${name}, which should resolve to ${packageSrcDir}, but that ` +
            `directory does not exist. The package was likely renamed or moved — update resolveSharedReactPackageRoots.`,
        );
      }
      return packageSrcDir;
    })
    .sort();
}

/**
 * Every directory the shared-import scanner (and the F10 unscannable-import
 * guard beside it) reads: mobile's own `src` and `app`, plus every
 * `*-react` package mobile depends on.
 */
const SCAN_ROOTS = [join(MOBILE_ROOT, 'src'), join(MOBILE_ROOT, 'app'), ...resolveSharedReactPackageRoots()];

/**
 * The store flow's spine. If any of these has no fixture, a capture is reading
 * live data for the screen the whole set is built around, and the screenshots
 * are back to moving whenever PROD does.
 *
 * `GetSessionGroupedFeed` is the one that lives in the shared package rather
 * than mobile's own operations.ts — the You tab's session feed.
 */
const REQUIRED_STORE_FLOW_OPERATIONS = [
  'GetProfile',
  'GetMyBoards',
  'SearchClimbs',
  'GetClimb',
  'GetSessionGroupedFeed',
] as const;

/**
 * The floor under the registry. Not a target — just enough that a resolution
 * change which silently emptied one of the three sources fails here instead of
 * turning the checks below into no-ops.
 */
const MINIMUM_REGISTRY_DOCUMENTS = 54;

const SHARED_OPERATION_MODULES: Record<string, Record<string, unknown>> = {
  '@boardsesh/graphql/operations': sharedOperations,
  '@boardsesh/graphql/operations/account': sharedAccount,
  '@boardsesh/graphql/operations/activity-feed': sharedActivityFeed,
  '@boardsesh/graphql/operations/beta-links': sharedBetaLinks,
  '@boardsesh/graphql/operations/board-presence': sharedBoardPresence,
  '@boardsesh/graphql/operations/boards': sharedBoards,
  '@boardsesh/graphql/operations/favorites': sharedFavorites,
  '@boardsesh/graphql/operations/gyms': sharedGyms,
  '@boardsesh/graphql/operations/integrations': sharedIntegrations,
  '@boardsesh/graphql/operations/new-climb-feed': sharedNewClimbFeed,
  '@boardsesh/graphql/operations/playlists': sharedPlaylists,
  '@boardsesh/graphql/operations/proposals': sharedProposals,
  '@boardsesh/graphql/operations/qa': sharedQa,
  '@boardsesh/graphql/operations/queue-session': sharedQueueSession,
};

// Build the schema inside this test's own `graphql` instance. Importing a
// prebuilt schema object crosses two installed copies of graphql-js, which
// `validate()` rejects outright — same reason the backend's
// operations-schema-validation.test.ts builds its own.
let schema: GraphQLSchema;
try {
  schema = buildSchema(typeDefs.join('\n\n'));
} catch (schemaError) {
  throw new Error(`Failed to build the schema from shared-schema typeDefs: ${(schemaError as Error).message}`);
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Whether a namespace export is an operation document mobile can send, as
 * opposed to a bare fragment (`PLAYLIST_FIELDS`), a type, or a helper.
 *
 * Delegates to `resolveOperationName` — the same resolver the backend uses to
 * key a fixture — rather than re-deriving the check: several operations
 * (`GetAllUserPlaylists`, `GetMyPinnedPlaylists`) are built as
 * `` gql`${PLAYLIST_FIELDS} query …` ``, so the exported STRING starts with the
 * interpolated fragment's text, not the `query` keyword. An anchored
 * `/^\s*(query|…)/` check rejects those outright; `resolveOperationName`
 * already searches the whole document for the operation keyword, which is
 * exactly the classification this needs.
 */
function isOperationDocument(value: unknown): value is string {
  return typeof value === 'string' && resolveOperationName({ query: value }) !== null;
}

interface RegisteredDocument {
  operationName: string;
  document: string;
  normalized: string;
  documentHash: string;
  /** Where it came from, for the failure message. */
  source: string;
}

// ---------------------------------------------------------------------------
// What mobile imports from the shared operations package
// ---------------------------------------------------------------------------

const SHARED_IMPORT_PATTERN = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*'(@boardsesh\/graphql\/operations[^']*)'/g;

/**
 * Import forms this file's registry CANNOT see: only a named `import { … }`
 * form (matched by `SHARED_IMPORT_PATTERN` above) is scanned. A namespace
 * import, a default import, or a bare re-export would let an operation ship
 * without ever reaching the registry — silently turning every check below
 * into a no-op for that document — so `findUnscannableSharedOperationImports`
 * fails the file outright instead of quietly missing it.
 *
 * (Deliberately not spelling out an example `from '@boardsesh/graphql/…'`
 * literal in this comment: the scanners below match raw file TEXT, not an AST,
 * so a fake import statement here would be indistinguishable from a real one —
 * see the guard's own tests, which use inline string samples for exactly this
 * reason.)
 */
const UNSCANNABLE_SHARED_IMPORT_PATTERNS: ReadonlyArray<{ pattern: RegExp; describe: string }> = [
  {
    pattern: /import\s+\*\s+as\s+\w+\s+from\s*'(@boardsesh\/graphql\/operations[^']*)'/g,
    describe: 'a namespace import (`import * as … from`)',
  },
  {
    pattern: /import\s+\w+\s*(?:,\s*\{[^}]*\})?\s*from\s*'(@boardsesh\/graphql\/operations[^']*)'/g,
    describe: 'a default import (`import … from`)',
  },
  {
    pattern: /export\s+\{[^}]*\}\s*from\s*'(@boardsesh\/graphql\/operations[^']*)'/g,
    describe: 'a re-export (`export { … } from`)',
  },
];

/**
 * Every import of `@boardsesh/graphql/operations*` in `sourceText` that this
 * test's registry cannot see, described for a failure message. Pure — no `fs`,
 * so it can be exercised with an inline string sample.
 */
export function findUnscannableSharedOperationImports(sourceText: string, sourceLabel: string): string[] {
  const problems: string[] = [];
  for (const { pattern, describe } of UNSCANNABLE_SHARED_IMPORT_PATTERNS) {
    for (const match of sourceText.matchAll(pattern)) {
      problems.push(
        `${sourceLabel} imports ${describe} '${match[1]}' — this test only scans named ` +
          `\`import { … }\` forms; rewrite it as one, or the operations it carries will never be ` +
          `checked against the schema or the fixture set.`,
      );
    }
  }
  return problems;
}

function listSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, files);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
  }
  return files;
}

/**
 * The exact names mobile pulls out of the shared operations package, by
 * module — scanned across `SCAN_ROOTS` (mobile's own `src`/`app` plus every
 * `*-react` package it depends on, since those hooks send documents too).
 *
 * Read from source rather than namespace-importing every module wholesale: the
 * package index alone re-exports ~180 documents, most of them web-only, and a
 * registry padded with operations this app never sends would weaken every check
 * below into "some document somewhere matched".
 */
function collectSharedImports(): Map<string, Set<string>> {
  const byModule = new Map<string, Set<string>>();
  const files = SCAN_ROOTS.flatMap((root) => listSourceFiles(root));
  const unscannable: string[] = [];
  for (const file of files) {
    const sourceText = readFileSync(file, 'utf8');
    // Skip files this guard would only ever false-positive on:
    //   - `__tests__` files are never product code the app can send from — and
    //     this very test file legitimately namespace-imports every shared
    //     operations module up top to build SHARED_OPERATION_MODULES, plus
    //     carries fake import statements as inline string samples for the
    //     guard's own tests below.
    //   - mobile's own operations.ts, which re-exports a few documents from the
    //     shared package (`export { TOGGLE_FAVORITE, … } from
    //     '@boardsesh/graphql/operations/favorites'`) — that file is already
    //     scanned exhaustively via the `mobileOperations` namespace import
    //     above (a re-export shows up on the namespace object like any other
    //     export), so it is never actually invisible to the registry.
    if (!file.includes('/__tests__/') && file !== MOBILE_OPERATIONS_ABSOLUTE_PATH) {
      unscannable.push(...findUnscannableSharedOperationImports(sourceText, file));
    }
    for (const match of sourceText.matchAll(SHARED_IMPORT_PATTERN)) {
      if (match[1]) continue; // `import type { … }` never carries a document
      const names = byModule.get(match[3]) ?? new Set<string>();
      for (const clause of match[2].split(',')) {
        const trimmed = clause.trim();
        if (!trimmed || trimmed.startsWith('type ')) continue;
        names.add(trimmed.split(/\s+as\s+/)[0].trim());
      }
      byModule.set(match[3], names);
    }
  }
  if (unscannable.length > 0) throw new Error(unscannable.join('\n'));
  return byModule;
}

function buildRegistry(): Map<string, RegisteredDocument[]> {
  const registry = new Map<string, RegisteredDocument[]>();

  const add = (document: string, source: string): void => {
    const operationName = resolveOperationName({ query: document });
    if (!operationName) throw new Error(`An anonymous GraphQL operation is exported from ${source}.`);
    const normalized = normalizeDocument(document);
    const existing = registry.get(operationName) ?? [];
    if (existing.some((candidate) => candidate.normalized === normalized)) return;
    existing.push({ operationName, document, normalized, documentHash: sha256Hex(normalized), source });
    registry.set(operationName, existing);
  };

  for (const document of Object.values(mobileOperations)) {
    if (isOperationDocument(document)) add(document, MOBILE_OPERATIONS_PATH);
  }

  for (const [modulePath, names] of collectSharedImports()) {
    const namespace = SHARED_OPERATION_MODULES[modulePath];
    if (!namespace) {
      throw new Error(
        `Mobile imports from ${modulePath}, which this test does not read. Add it to SHARED_OPERATION_MODULES.`,
      );
    }
    for (const name of names) {
      const exported = namespace[name];
      if (isOperationDocument(exported)) add(exported, modulePath);
    }
  }

  for (const { document } of listSyncPullDocuments()) {
    add(document, '@boardsesh/offline-sync (listSyncPullDocuments)');
  }

  return registry;
}

const registry = buildRegistry();
const registeredDocuments = [...registry.values()].flat();

// ---------------------------------------------------------------------------
// The recorded set, when there is one
// ---------------------------------------------------------------------------

function readManifest(): ScreenshotFixtureManifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  const validation = validateScreenshotFixtureManifest(JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')));
  if (!validation.ok) throw new Error(`${MANIFEST_PATH} is not a valid fixture manifest: ${validation.reason}`);
  return validation.manifest;
}

const manifest = readManifest();

function readFixture(file: string): GraphqlFixtureFile {
  return JSON.parse(readFileSync(join(FIXTURES_DIR, file), 'utf8')) as GraphqlFixtureFile;
}

// ---------------------------------------------------------------------------
// (a) Every document the app sends is a valid operation
// ---------------------------------------------------------------------------

describe('the operations mobile sends', () => {
  it('holds every document the app can send', () => {
    expect(registeredDocuments.length).toBeGreaterThanOrEqual(MINIMUM_REGISTRY_DOCUMENTS);
  });

  it('validates every document against the schema', () => {
    const failures: string[] = [];
    for (const registered of registeredDocuments) {
      let parsed: DocumentNode;
      try {
        parsed = parse(registered.document);
      } catch (parseError) {
        failures.push(
          `Mobile operation ${registered.operationName} (${registered.source}) does not parse: ${(parseError as Error).message}`,
        );
        continue;
      }
      const errors = validate(schema, parsed);
      if (errors.length === 0) continue;
      failures.push(
        `Mobile operation ${registered.operationName} (${registered.source}) has GraphQL validation errors:\n` +
          errors.map((error, index) => `  ${index + 1}. ${error.message}`).join('\n'),
      );
    }
    expect(failures).toEqual([]);
  });

  it('carries every operation the store flow depends on', () => {
    const missing = REQUIRED_STORE_FLOW_OPERATIONS.filter((operationName) => !registry.has(operationName));
    expect(missing).toEqual([]);
  });

  it('registers a document contributed only by a shared *-react package', () => {
    // GetTicks is sent by @boardsesh/board-react's use-logbook.ts and is not
    // imported anywhere under packages/mobile/src or packages/mobile/app — if
    // SCAN_ROOTS ever regresses to just the two mobile roots, this is the
    // first thing to go missing.
    expect(registry.has('GetTicks')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) + (c) + (d) — only once a set has been recorded
// ---------------------------------------------------------------------------

describe.skipIf(!manifest)('the recorded screenshot fixtures', () => {
  const entries = manifest?.graphql ?? [];

  it('names an operation the app still has, at the document it was recorded with', () => {
    const failures: string[] = [];
    for (const entry of entries) {
      const documents = registry.get(entry.operationName);
      if (!documents) {
        failures.push(
          `Fixture ${entry.file} records ${entry.operationName}, which the app no longer sends. ` +
            `Delete it, or re-record: ${RE_RECORD_COMMAND}`,
        );
        continue;
      }
      if (documents.some((candidate) => candidate.documentHash === entry.documentHash)) continue;
      failures.push(
        `Fixture ${entry.file} was recorded from a ${entry.operationName} document the app no longer sends ` +
          `(recorded ${entry.documentHash.slice(0, 12)}, current ${documents
            .map((candidate) => candidate.documentHash.slice(0, 12))
            .join(', ')}). Re-record: ${RE_RECORD_COMMAND}`,
      );
    }
    expect(failures).toEqual([]);
  });

  it('recomputes each fixture file’s own hashes from its bytes', () => {
    const failures: string[] = [];
    for (const entry of entries) {
      const fixture = readFixture(entry.file);
      const documentHash = sha256Hex(normalizeDocument(fixture.query));
      const variablesHash = sha256Hex(
        canonicalJson(stripIgnoredVariablePaths(fixture.operationName, fixture.variables ?? {})),
      );
      if (documentHash !== fixture.documentHash) {
        failures.push(
          `Fixture ${entry.file} carries documentHash ${fixture.documentHash} but its own query hashes to ${documentHash} — ` +
            `the file was edited by hand. Re-record: ${RE_RECORD_COMMAND}`,
        );
      }
      if (variablesHash !== fixture.variablesHash) {
        failures.push(
          `Fixture ${entry.file} carries variablesHash ${fixture.variablesHash} but its own variables hash to ${variablesHash} — ` +
            `the file was edited by hand. Re-record: ${RE_RECORD_COMMAND}`,
        );
      }
      if (documentHash !== entry.documentHash || variablesHash !== entry.variablesHash) {
        failures.push(
          `Fixture ${entry.file} and the manifest entry for it disagree about its hashes. Re-record: ${RE_RECORD_COMMAND}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('still answers every field the current document selects', () => {
    const failures: string[] = [];
    for (const entry of entries) {
      const documents = registry.get(entry.operationName);
      const current = documents?.find((candidate) => candidate.documentHash === entry.documentHash);
      if (!current) continue; // already reported by the document-drift check above
      const fixture = readFixture(entry.file);
      const response = fixture.response as { data?: unknown } | null;
      if (!response || typeof response !== 'object' || response.data === undefined) continue;
      const variables = (fixture.variables ?? {}) as Record<string, unknown>;
      for (const path of checkSelectionCoverage(schema, parse(current.document), response.data, variables)) {
        failures.push(
          `Fixture ${entry.file} is missing "${path}", which the current ${entry.operationName} document selects — ` +
            `the server stopped returning it, or the field was added after recording. Re-record: ${RE_RECORD_COMMAND}`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it('covers every operation the store flow depends on', () => {
    const recorded = new Set(entries.map((entry) => entry.operationName));
    const uncovered = REQUIRED_STORE_FLOW_OPERATIONS.filter((operationName) => !recorded.has(operationName));
    expect(uncovered).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The walker's own tests
// ---------------------------------------------------------------------------

const WALKER_SCHEMA = buildSchema(`
  interface Node { id: ID! }
  type Board implements Node { id: ID!, name: String!, angle: Int }
  type Climb implements Node { id: ID!, name: String!, setter: Setter, boards: [Board!]! }
  type Setter { id: ID!, username: String! }
  type Query { climb: Climb, climbs: [Climb!]! }
`);

function coverage(document: string, data: unknown, variables: Record<string, unknown> = {}): string[] {
  return checkSelectionCoverage(WALKER_SCHEMA, parse(document), data, variables);
}

describe('checkSelectionCoverage', () => {
  it('passes a response that answers the whole selection', () => {
    expect(coverage('query C { climb { id name } }', { climb: { id: '1', name: 'Bunker' } })).toEqual([]);
  });

  it('reports a field the response dropped', () => {
    expect(coverage('query C { climb { id name } }', { climb: { id: '1' } })).toEqual(['climb.name']);
  });

  it('keys on the alias, not the field name', () => {
    expect(coverage('query C { climb { title: name } }', { climb: { name: 'Bunker' } })).toEqual(['climb.title']);
    expect(coverage('query C { climb { title: name } }', { climb: { title: 'Bunker' } })).toEqual([]);
  });

  it('treats a null parent as a complete answer', () => {
    expect(coverage('query C { climb { id name setter { username } } }', { climb: null })).toEqual([]);
    expect(coverage('query C { climb { setter { username } } }', { climb: { setter: null } })).toEqual([]);
  });

  it('walks into every list element and names the index', () => {
    const data = { climbs: [{ id: '1', name: 'Bunker' }, { id: '2' }] };
    expect(coverage('query C { climbs { id name } }', data)).toEqual(['climbs[1].name']);
  });

  it('ignores a selection the fixture’s variables skipped', () => {
    const document = 'query C($hide: Boolean!) { climb { id name @skip(if: $hide) } }';
    expect(coverage(document, { climb: { id: '1' } }, { hide: true })).toEqual([]);
    expect(coverage(document, { climb: { id: '1' } }, { hide: false })).toEqual(['climb.name']);
  });

  it('ignores a selection the fixture’s variables excluded', () => {
    const document = 'query C($withName: Boolean!) { climb { id name @include(if: $withName) } }';
    expect(coverage(document, { climb: { id: '1' } }, { withName: false })).toEqual([]);
    expect(coverage(document, { climb: { id: '1' } }, { withName: true })).toEqual(['climb.name']);
  });

  it('applies an inline fragment when __typename matches, and skips it otherwise', () => {
    const document = 'query C { climb { id ... on Climb { name } } }';
    expect(coverage(document, { climb: { id: '1', __typename: 'Climb' } })).toEqual(['climb.name']);
    expect(coverage(document, { climb: { id: '1', __typename: 'Board' } })).toEqual([]);
    // No __typename in the recorded body: nothing to match on, so the fragment
    // is optional rather than guessed at.
    expect(coverage(document, { climb: { id: '1' } })).toEqual([]);
  });

  it('applies an interface fragment to a concrete implementing type', () => {
    const document = 'query C { climb { ... on Node { id } } }';
    expect(coverage(document, { climb: { __typename: 'Climb' } })).toEqual(['climb.id']);
  });

  it('reports every selected field when a scalar came back where an object was selected', () => {
    expect(coverage('query C { climb { id name } }', { climb: 'oops' })).toEqual(['climb.id', 'climb.name']);
  });
});

// ---------------------------------------------------------------------------
// The import-discovery guard's own tests
// ---------------------------------------------------------------------------

describe('findUnscannableSharedOperationImports', () => {
  it('flags a namespace import', () => {
    const problems = findUnscannableSharedOperationImports(
      `import * as sharedOperations from '@boardsesh/graphql/operations';`,
      'some-file.ts',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('some-file.ts');
    expect(problems[0]).toContain('namespace import');
  });

  it('flags a default import', () => {
    const problems = findUnscannableSharedOperationImports(
      `import sharedOperations from '@boardsesh/graphql/operations/boards';`,
      'some-file.ts',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('default import');
  });

  it('flags a default import combined with a named import', () => {
    const problems = findUnscannableSharedOperationImports(
      `import sharedDefault, { GetProfile } from '@boardsesh/graphql/operations';`,
      'some-file.ts',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('default import');
  });

  it('flags a re-export', () => {
    const problems = findUnscannableSharedOperationImports(
      `export { GetProfile } from '@boardsesh/graphql/operations';`,
      'some-file.ts',
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('re-export');
  });

  it('accepts a named import — the only form the registry scans', () => {
    expect(
      findUnscannableSharedOperationImports(
        `import { GetProfile } from '@boardsesh/graphql/operations';`,
        'some-file.ts',
      ),
    ).toEqual([]);
  });

  it('accepts a type-only namespace or default import — it carries no document', () => {
    const source = [
      `import type * as SharedTypes from '@boardsesh/graphql/operations';`,
      `import type SharedDefault from '@boardsesh/graphql/operations';`,
    ].join('\n');
    expect(findUnscannableSharedOperationImports(source, 'some-file.ts')).toEqual([]);
  });

  it('ignores imports from modules outside the shared operations package', () => {
    expect(findUnscannableSharedOperationImports(`import * as React from 'react';`, 'some-file.ts')).toEqual([]);
  });
});
