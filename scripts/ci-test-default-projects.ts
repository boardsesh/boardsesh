/// <reference types="node" />

// Emit the positive `--project=` flag list for the CI `test-default` job: every
// Vitest project declared in root `vite.config.ts` EXCEPT those that run in
// their own jobs because they need infra (`backend`: postgres + redis;
// `location-sync`: migrated PostGIS; `moonboard-ocr`: canvas system libs).
//
// Why a positive list instead of `--project '!backend'`? Vitest's `--changed`
// selects test files from the diff, and that spec set drives project init /
// globalSetup BEFORE the `--project` negation is applied. So a diff that touches
// anything `backend` imports (its own `packages/backend/**` — even
// `package.json` — or a `packages/shared/*` it depends on) pulls backend tests,
// and their Postgres-connecting globalSetup, into `test-default`, which has no
// services, and they fail (ECONNREFUSED :5433). A project absent from a positive
// list is never loaded, so this can't happen.
//
// The list is DERIVED from `vite.config.ts` (the single source of truth for
// `test.projects`) so a newly-added package is picked up automatically and can't
// be silently skipped. Adding another infra-bearing project is a conscious edit
// to INFRA_PROJECTS below.
//
// Structured like scripts/mobile-native-deps-check.ts: a pure, dependency-
// injected core (`selectTestDefaultProjects`) the unit test drives with
// fixtures, plus a thin `main()` that wires real fs + stdout. Run in CI:
// `node --import tsx scripts/ci-test-default-projects.ts`.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Projects with dedicated CI jobs because they need services/libs `test-default` lacks. */
export const INFRA_PROJECTS: ReadonlySet<string> = new Set([
  'backend',
  'backend-serial',
  'location-sync',
  'moonboard-ocr',
]);

/** Reads a project's `vite.config.ts` source, given its path relative to the repo root. */
export type ConfigReader = (relativePath: string) => string;

/**
 * Derive the positive list of Vitest project names `test-default` should run:
 * every project in root `vite.config.ts`'s `test.projects`, minus `infraProjects`,
 * in declared order. Pure + dependency-injected so it is unit-testable against
 * fixtures. Throws (rather than exiting) on any malformed input so callers/tests
 * surface the failure instead of silently dropping a project.
 */
export function selectTestDefaultProjects(
  rootConfigSource: string,
  readProjectConfig: ConfigReader,
  infraProjects: ReadonlySet<string> = INFRA_PROJECTS,
): string[] {
  const projectPaths = [...rootConfigSource.matchAll(/['"](\.\/[^'"]+\/vite\.config\.ts)['"]/g)].map(
    (match) => match[1],
  );
  if (projectPaths.length === 0) {
    throw new Error('no test.projects entries found in vite.config.ts');
  }

  const names = projectPaths.map((relativePath) => {
    const source = readProjectConfig(relativePath);
    // Read the `name:` that belongs to the `test:` block. We slice from the first
    // `test:` so a plugin `name:` ABOVE the test config can't be mistaken for the
    // project name. ASSUMPTION: no project config adds a plugin (or other) `name:`
    // field AFTER its `test:` block — none does today (verified across all
    // configs); if one ever does, scope this match to the test block more tightly.
    const testBlockStart = source.indexOf('test:');
    const haystack = testBlockStart >= 0 ? source.slice(testBlockStart) : source;
    const nameMatch = haystack.match(/name:\s*['"]([^'"]+)['"]/);
    if (!nameMatch) {
      throw new Error(`could not extract a test "name" from ${relativePath}`);
    }
    return nameMatch[1];
  });

  const selected = names.filter((name) => !infraProjects.has(name));
  if (selected.length === 0) {
    throw new Error('positive project list is empty — refusing to run zero projects');
  }
  return selected;
}

/** Wire real fs + stdout; returns the process exit code. */
export function main(): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const rootConfigSource = readFileSync(resolve(repoRoot, 'vite.config.ts'), 'utf8');
    const names = selectTestDefaultProjects(rootConfigSource, (relativePath) =>
      readFileSync(resolve(repoRoot, relativePath), 'utf8'),
    );
    process.stdout.write(`${names.map((name) => `--project=${name}`).join(' ')}\n`);
    return 0;
  } catch (error) {
    console.error(`[ci-test-default-projects] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
