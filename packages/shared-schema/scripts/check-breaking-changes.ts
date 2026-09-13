/// <reference types="node" />

/**
 * Fails when a PR makes a GraphQL schema change that breaks a query an
 * installed app build may still send (#5370).
 *
 * Mobile bundles live on phones for weeks. A field removed from the schema is
 * still asked for by every build that shipped before the removal, and each of
 * those requests fails validation with GRAPHQL_VALIDATION_FAILED. graphql-js
 * already knows which changes do that (`findBreakingChanges`); this script
 * compares the base branch's generated SDL with the PR's.
 *
 *   node --import tsx packages/shared-schema/scripts/check-breaking-changes.ts --base-ref origin/main
 *
 * A deliberate removal (after the builds that query it are gone) is allowed by
 * the `schema-breaking-ok` PR label, which CI checks before running this.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { BreakingChangeType, buildSchema, findBreakingChanges } from 'graphql';

export const SCHEMA_SDL_PATH = 'packages/shared-schema/src/generated/schema.graphql';

// Every change that makes a previously valid client document invalid or
// uncoercible. Directive-only changes (DIRECTIVE_REMOVED and friends) are left
// out: our client documents use no schema-defined directives.
export const BLOCKING_CHANGE_TYPES: ReadonlySet<string> = new Set<string>([
  BreakingChangeType.TYPE_REMOVED,
  BreakingChangeType.TYPE_CHANGED_KIND,
  BreakingChangeType.TYPE_REMOVED_FROM_UNION,
  BreakingChangeType.VALUE_REMOVED_FROM_ENUM,
  BreakingChangeType.REQUIRED_INPUT_FIELD_ADDED,
  BreakingChangeType.IMPLEMENTED_INTERFACE_REMOVED,
  BreakingChangeType.FIELD_REMOVED,
  BreakingChangeType.FIELD_CHANGED_KIND,
  BreakingChangeType.REQUIRED_ARG_ADDED,
  BreakingChangeType.ARG_REMOVED,
  BreakingChangeType.ARG_CHANGED_KIND,
]);

export type BlockingSchemaChange = { type: string; description: string };

/** Pure: the client-breaking changes going from `baseSdl` to `headSdl`. */
export function findBlockingSchemaChanges(baseSdl: string, headSdl: string): BlockingSchemaChange[] {
  return findBreakingChanges(buildSchema(baseSdl), buildSchema(headSdl))
    .filter((change) => BLOCKING_CHANGE_TYPES.has(change.type))
    .map((change) => ({ type: change.type, description: change.description }));
}

function readBaseSdl(baseRef: string): string {
  return execFileSync('git', ['show', `${baseRef}:${SCHEMA_SDL_PATH}`], { encoding: 'utf8' });
}

/** Wire git + fs + stdout; returns the process exit code. */
export function main(argv: string[]): number {
  const baseRefIndex = argv.indexOf('--base-ref');
  const baseRef = baseRefIndex >= 0 ? argv[baseRefIndex + 1] : undefined;
  if (!baseRef) {
    console.error('[schema-breaking] usage: check-breaking-changes.ts --base-ref <git-ref>');
    return 2;
  }

  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const headSdl = readFileSync(join(repoRoot, SCHEMA_SDL_PATH), 'utf8');
  const changes = findBlockingSchemaChanges(readBaseSdl(baseRef), headSdl);

  if (changes.length === 0) {
    console.log(`[schema-breaking] No client-breaking schema changes against ${baseRef}.`);
    return 0;
  }

  for (const change of changes) {
    console.error(`::error::${change.type}: ${change.description}`);
  }
  console.error(
    `\n[schema-breaking] ${changes.length} change(s) would break queries that installed app builds still send.` +
      '\nKeep the old field (mark it @deprecated) until those builds are gone.' +
      '\nIf the removal is deliberate and safe, add the `schema-breaking-ok` label and re-run CI.',
  );
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
