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
const FIXTURES_DIR = join(MOBILE_ROOT, 'screenshot-fixtures');
const MANIFEST_PATH = join(FIXTURES_DIR, 'manifest.json');

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

function isOperationDocument(value: unknown): value is string {
  return typeof value === 'string' && /^\s*(query|mutation|subscription)\s/.test(value);
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

function listSourceFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, files);
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(full);
  }
  return files;
}

/**
 * The exact names mobile pulls out of the shared operations package, by module.
 *
 * Read from source rather than namespace-importing every module wholesale: the
 * package index alone re-exports ~180 documents, most of them web-only, and a
 * registry padded with operations this app never sends would weaken every check
 * below into "some document somewhere matched".
 */
function collectSharedImports(): Map<string, Set<string>> {
  const byModule = new Map<string, Set<string>>();
  const files = [...listSourceFiles(join(MOBILE_ROOT, 'src')), ...listSourceFiles(join(MOBILE_ROOT, 'app'))];
  for (const file of files) {
    for (const match of readFileSync(file, 'utf8').matchAll(SHARED_IMPORT_PATTERN)) {
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
