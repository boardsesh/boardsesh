/// <reference types="node" />

/**
 * The public API changelog gate (docs/integration-platform.md, "Versioning"):
 * CI fails a PR that changes the published contract without a changelog entry.
 *
 * Usage:
 *   vp run check:public-api-changelog                       # the newest entry names the committed document
 *   PR_BASE_SHA=<sha> vp run check:public-api-changelog     # and no published entry changed
 *
 * The newest entry in `packages/shared/public-api/src/changelog.json` must carry
 * the SHA-256 of the committed `generated/openapi.json`, so a document change
 * without an entry fails on every run, including pushes to main. On a pull
 * request the entries already on the base branch must survive unchanged at the
 * bottom of the list, so an old entry cannot be re-pointed at the new document
 * in place of a new one.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  PublicApiChangelogSchema,
  publicApiChangelogProblems,
  type PublicApiChangelogEntry,
} from '../packages/shared/public-api/src/changelog';

export const OPENAPI_DOCUMENT_FILE = 'packages/shared/public-api/src/generated/openapi.json';
export const CHANGELOG_FILE = 'packages/shared/public-api/src/changelog.json';
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

function readChangelog(text: string, where: string): PublicApiChangelogEntry[] {
  const parsed = PublicApiChangelogSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(`${CHANGELOG_FILE} at ${where} is not a valid changelog: ${parsed.error.message}`);
  return parsed.data.entries;
}

/** The changelog on the base commit, or undefined when the base has none yet. */
function baseChangelog(cwd: string, baseSha: string): PublicApiChangelogEntry[] | undefined {
  if (!COMMIT_SHA.test(baseSha)) throw new Error('PR_BASE_SHA must be a full commit SHA.');
  const exists = spawnSync('git', ['cat-file', '-e', `${baseSha}:${CHANGELOG_FILE}`], { cwd });
  if (exists.error) throw new Error('Cannot read the base changelog: git did not run.');
  if (exists.status !== 0) {
    const commit = spawnSync('git', ['cat-file', '-e', `${baseSha}^{commit}`], { cwd });
    if (commit.status !== 0) throw new Error(`The base commit ${baseSha} is not in this checkout. Fetch it first.`);
    return undefined;
  }
  const shown = spawnSync('git', ['show', `${baseSha}:${CHANGELOG_FILE}`], { cwd, encoding: 'utf8' });
  if (shown.status !== 0) throw new Error('Cannot read the base changelog.');
  return readChangelog(shown.stdout, baseSha);
}

/** Every problem the gate finds, as messages. Empty means the PR passes. */
export function checkPublicApiChangelog({ cwd, baseSha }: { cwd: string; baseSha?: string }): string[] {
  const document = readFileSync(path.join(cwd, OPENAPI_DOCUMENT_FILE), 'utf8');
  const entries = readChangelog(readFileSync(path.join(cwd, CHANGELOG_FILE), 'utf8'), 'the working tree');
  return publicApiChangelogProblems({
    entries,
    documentSha256: createHash('sha256').update(document).digest('hex'),
    baseEntries: baseSha ? baseChangelog(cwd, baseSha) : undefined,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const baseSha = process.env.PR_BASE_SHA?.trim() || undefined;
    const problems = checkPublicApiChangelog({ cwd: path.resolve(import.meta.dirname, '..'), baseSha });
    if (problems.length > 0) {
      for (const problem of problems) console.error(`::error::${problem}`);
      process.exitCode = 1;
    } else {
      console.log(
        `[public-api-changelog] The changelog describes the committed document${baseSha ? ' and keeps every published entry' : ''}.`,
      );
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : 'Cannot check the public API changelog.'}`);
    process.exitCode = 1;
  }
}
