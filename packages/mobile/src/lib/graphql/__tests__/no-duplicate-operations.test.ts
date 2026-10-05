/**
 * One document per GraphQL operation.
 *
 * Mobile used to keep its own copies of documents that also live in the shared
 * packages. The copies drifted: #6076 pointed a hook at the shared `GetBoard`,
 * which lacked `timerName`, and a healed board lost its paired timer. So a
 * mobile file may only define an operation whose NAME no shared package
 * already defines. Import the shared document instead; if it lacks a field the
 * app needs, change the shared document.
 *
 * Read from source text rather than by importing: the shared operations are
 * spread over modules the package index does not re-export, and a text scan
 * sees a document wherever it is written, including one inlined in a hook.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const MOBILE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const REPO_ROOT = join(MOBILE_ROOT, '..', '..');
const SHARED_PACKAGES_ROOT = join(REPO_ROOT, 'packages', 'shared');
const MOBILE_SCAN_ROOTS = [join(MOBILE_ROOT, 'src'), join(MOBILE_ROOT, 'app')];

/**
 * Operations deliberately still defined on both sides, as `name -> why`.
 *
 * Keep this short. An entry is a known duplicate with a written reason and a
 * way out, never a way to silence the check for a new one.
 */
const KNOWN_DUPLICATES: Readonly<Record<string, string>> = {
  // Mobile's text is the one the app sends and the one the screenshot replay
  // set recorded. The shared `QUEUE_UPDATES` selects the same fields in another
  // order and is sent only by the backend test harness
  // (packages/backend/src/__tests__/helpers/headless-queue-client.ts).
  // Merging them means moving SUBSCRIPTION_CLIMB_FIELDS and
  // SUBSCRIPTION_QUEUE_ITEM_FIELDS into the shared queue-session module beside
  // its own CLIMB_FIELDS (recorded `JoinSession` pins that order, so both lists
  // would stay), and rewriting the two backend tests that read these constants
  // out of mobile's operations.ts by path: queue-climb-field-contract.test.ts
  // and operations-schema-validation.test.ts. Those tests are what stops queue
  // fields flapping between peers (#3927, #3995), so that is its own PR.
  QueueUpdates: 'recorded with mobile text; shared copy is test-harness only and guarded by backend contract tests',
  // Same shape as QueueUpdates, and here the selections really differ: the
  // shared one also selects `SessionStatsUpdated.ticks`, which mobile leaves
  // out on purpose (its live view shows aggregates only), and lacks
  // `SessionNameChanged`. Mobile's text is recorded, so the shared copy has to
  // become mobile's text; if the backend harness turns out to need `ticks`, it
  // gets its own named operation.
  SessionUpdates: 'recorded with mobile text; shared copy selects ticks and lacks SessionNameChanged',
};

const OPERATION_DEFINITION_PATTERN = /\b(?:query|mutation|subscription)\s+([A-Za-z_]\w*)\s*[({]/g;

/**
 * The names of the GraphQL operations written out in `sourceText`.
 *
 * Comments are dropped first, so prose such as "the mutation SaveTick (see
 * above)" is not a definition. Pure, so it can be exercised with inline samples.
 */
export function operationNamesDefinedIn(sourceText: string): Set<string> {
  const withoutComments = sourceText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const names = new Set<string>();
  for (const match of withoutComments.matchAll(OPERATION_DEFINITION_PATTERN)) names.add(match[1]);
  return names;
}

function listProductSourceFiles(directory: string, files: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      // Tests mock documents inline, and codegen output repeats every shared
      // document as a string key.
      if (entry.name === '__tests__' || entry.name === 'generated' || entry.name === 'node_modules') continue;
      listProductSourceFiles(full, files);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      files.push(full);
    }
  }
  return files;
}

/** `operation name -> repo-relative files defining it`, across `roots`. */
function collectDefinitions(roots: string[]): Map<string, string[]> {
  const definitions = new Map<string, string[]>();
  for (const root of roots) {
    for (const file of listProductSourceFiles(root)) {
      for (const name of operationNamesDefinedIn(readFileSync(file, 'utf8'))) {
        const files = definitions.get(name) ?? [];
        files.push(relative(REPO_ROOT, file).split(sep).join('/'));
        definitions.set(name, files);
      }
    }
  }
  return definitions;
}

const sharedSourceRoots = readdirSync(SHARED_PACKAGES_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(SHARED_PACKAGES_ROOT, entry.name, 'src'))
  .filter((sourceRoot) => existsSync(sourceRoot));

const sharedDefinitions = collectDefinitions(sharedSourceRoots);
const mobileDefinitions = collectDefinitions(MOBILE_SCAN_ROOTS);

describe('GraphQL operations defined in mobile', () => {
  it('scans both sides', () => {
    // A path change that emptied either scan would turn the check below into a no-op.
    expect(sharedDefinitions.has('GetBoard')).toBe(true);
    expect(sharedDefinitions.has('JoinSession')).toBe(true);
    expect(sharedDefinitions.has('SyncDeletions')).toBe(true);
    expect(sharedDefinitions.size).toBeGreaterThan(150);
    expect(mobileDefinitions.has('GetProfile')).toBe(true);
    expect(mobileDefinitions.size).toBeGreaterThan(10);
  });

  it('never repeat an operation a shared package already defines', () => {
    const duplicates = [...mobileDefinitions.entries()]
      .filter(([name]) => sharedDefinitions.has(name) && !Object.hasOwn(KNOWN_DUPLICATES, name))
      .map(
        ([name, mobileFiles]) =>
          `${name}: defined in ${mobileFiles.join(', ')} and in ${(sharedDefinitions.get(name) ?? []).join(', ')}`,
      )
      .sort();
    expect(
      duplicates,
      'Mobile defines a GraphQL operation that a shared package already defines. Two documents under one name ' +
        'drift apart, and a caller that switches from one to the other silently loses fields (#6076). Delete the ' +
        'mobile copy and import the shared document. If the shared one lacks a field the app reads, add it there; ' +
        'if that operation is recorded for screenshot replay, read docs/mobile-screenshot-fixtures.md first.',
    ).toEqual([]);
  });

  it('keeps the known-duplicates list to operations that are still duplicated', () => {
    const stale = Object.keys(KNOWN_DUPLICATES).filter(
      (name) => !mobileDefinitions.has(name) || !sharedDefinitions.has(name),
    );
    expect(stale, 'Remove these from KNOWN_DUPLICATES: one side no longer defines them.').toEqual([]);
  });
});

describe('operationNamesDefinedIn', () => {
  it('finds a named query, mutation and subscription', () => {
    const source = [
      'export const A = gql`query GetBoard($boardUuid: ID!) { board(boardUuid: $boardUuid) { uuid } }`;',
      'export const B = gql`\n  mutation SaveTick($input: SaveTickInput!) {\n    saveTick(input: $input) { uuid }\n  }\n`;',
      'export const C = `subscription QueueUpdates($sessionId: ID!) { queueUpdates(sessionId: $sessionId) { __typename } }`;',
      'export const D = gql`query GetProfile { profile { id } }`;',
    ].join('\n');
    expect([...operationNamesDefinedIn(source)].sort()).toEqual(['GetBoard', 'GetProfile', 'QueueUpdates', 'SaveTick']);
  });

  it('ignores a name that only appears in a comment', () => {
    const source = [
      '// the mutation SaveTick (see ticks.ts) is sent by the outbox',
      '/**\n * query GetBoard(\n */',
      'const NOTHING = 1;',
    ].join('\n');
    expect(operationNamesDefinedIn(source).size).toBe(0);
  });

  it('ignores prose that names an operation kind without defining one', () => {
    expect(operationNamesDefinedIn("const label = 'Run the query again';").size).toBe(0);
    expect(operationNamesDefinedIn('const subscription = client.subscribe(document);').size).toBe(0);
  });
});
