/// <reference types="node" />

/**
 * Validates the Drizzle migration folder on every PR that touches `packages/db`.
 *
 * Migration numbering is a global, first-come-first-served resource, and until
 * now nothing checked it. The failures that reach main are all silent — none of
 * them break a build, so none of them get caught in review:
 *
 *  - A `.sql` file with no journal entry never runs. `0177_illegal_omega_red.sql`
 *    lived on main in that state, reviewed as if it would apply, byte-identical to
 *    a migration that had already been renumbered past it.
 *  - A journal entry with no `.sql` file crashes the migrator at deploy time.
 *  - A migration whose `when` is not newer than main's newest is skipped *forever*
 *    by both appliers, because they order by `when` and not by number. That is the
 *    worst outcome in this file: the PR is green, the deploy is green, and the DDL
 *    simply never happens.
 *  - A number that collides with main means the PR cannot merge without a rebase.
 *    Flagging it here turns "discovered at merge time" into "flagged on the PR",
 *    with the exact command to fix it.
 *
 * Runs without a database, a build, or drizzle-kit — it is a few file reads.
 *
 * Usage:
 *   vp run check:db-migrations                  # validate the working tree
 *   vp run check:db-migrations -- --base origin/main   # also compare against a base
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DRIZZLE_DIR,
  JOURNAL_PATH,
  addedMigrations,
  duplicateIndexes,
  findOrphans,
  maxWhen,
  migrationFiles,
  migrationIndex,
  nextFreeIndex,
  padIndex,
  parseJournal,
  type Journal,
  type MigrationFile,
} from './lib/drizzle-migrations';

export interface Problem {
  /** Short machine-readable kind, used by the tests and the summary grouping. */
  kind:
    | 'orphan-sql'
    | 'orphan-entry'
    | 'duplicate-index'
    | 'tag-index-mismatch'
    | 'collision'
    | 'stale-when'
    | 'not-appended';
  message: string;
}

export interface TreeState {
  journal: Journal;
  filenames: string[];
}

/**
 * PURE: everything checkable from the branch alone, with no base to compare to.
 *
 * `tag-index-mismatch` is scoped to entries the branch adds rather than the whole
 * journal on purpose: 30 historical entries on main have a `tag` prefix that
 * differs from their `idx`, and rewriting that history is not this check's job.
 */
export function checkTree(state: TreeState, newTags: ReadonlySet<string> = new Set()): Problem[] {
  const problems: Problem[] = [];
  const { journal, filenames } = state;

  const orphans = findOrphans(journal, filenames);
  for (const filename of orphans.sqlWithoutEntry) {
    problems.push({
      kind: 'orphan-sql',
      message:
        `${DRIZZLE_DIR}/${filename} has no entry in _journal.json, so it will never be applied. ` +
        'Either add it via `vp exec drizzle-kit generate` or delete the file.',
    });
  }
  for (const tag of orphans.entryWithoutSql) {
    problems.push({
      kind: 'orphan-entry',
      message: `_journal.json references "${tag}" but ${DRIZZLE_DIR}/${tag}.sql is missing — the migrator will throw.`,
    });
  }

  // Scoped to migrations the branch adds. Main legitimately carries six duplicate
  // prefixes (0025, 0048-0052) from hand-merges years ago; both sides are journalled
  // and applied in production, so they order fine by `when` and are not fixable now.
  // A branch that adds two migrations at one number is a different matter — that one
  // is ambiguous and still cheap to fix. New-vs-main duplicates are reported as a
  // `collision` instead, which carries the actionable message.
  for (const index of duplicateIndexes(filenames)) {
    const newAtIndex = migrationFiles(filenames).filter((file) => file.index === index && newTags.has(file.tag));
    if (newAtIndex.length < 2) continue;
    problems.push({
      kind: 'duplicate-index',
      message:
        `This branch adds ${newAtIndex.length} migrations numbered ${padIndex(index)} ` +
        `(${newAtIndex.map((file) => file.filename).join(', ')}) — apply order is ambiguous.`,
    });
  }

  for (const entry of journal.entries) {
    if (!newTags.has(entry.tag)) continue;
    if (migrationIndex(entry.tag) !== entry.idx) {
      problems.push({
        kind: 'tag-index-mismatch',
        message: `New journal entry "${entry.tag}" has idx ${entry.idx}; the tag prefix and idx must agree.`,
      });
    }
  }

  return problems;
}

/**
 * PURE: the checks that need main to compare against.
 *
 * `stale-when` is the load-bearing one — see the file header.
 */
export function checkAgainstBase(base: TreeState, head: TreeState): Problem[] {
  const problems: Problem[] = [];
  const added = addedMigrations(base.filenames, head.filenames);
  if (added.length === 0) return problems;

  const baseNextFree = nextFreeIndex(base.journal, base.filenames);
  for (const file of added) {
    if (file.index < baseNextFree) {
      problems.push({
        kind: 'collision',
        message:
          `${file.filename} is numbered ${padIndex(file.index)}, but main is already at ` +
          `${padIndex(baseNextFree - 1)}. Run \`vp run db:renumber\` to move it to ${padIndex(baseNextFree)}.`,
      });
    }
  }

  const baseMaxWhen = maxWhen(base.journal);
  const addedTags = new Set(added.map((file) => file.tag));
  for (const entry of head.journal.entries) {
    if (!addedTags.has(entry.tag)) continue;
    if (entry.when <= baseMaxWhen) {
      problems.push({
        kind: 'stale-when',
        message:
          `"${entry.tag}" has when=${entry.when}, which is not newer than main's newest (${baseMaxWhen}). ` +
          'Both appliers order by `when`, so this migration would be skipped permanently. ' +
          'Run `vp run db:renumber` to restamp it.',
      });
    }
  }

  const addedPositions = head.journal.entries
    .map((entry, position) => ({ entry, position }))
    .filter(({ entry }) => addedTags.has(entry.tag))
    .map(({ position }) => position);
  const tailStart = head.journal.entries.length - addedPositions.length;
  if (addedPositions.some((position) => position < tailStart)) {
    problems.push({
      kind: 'not-appended',
      message:
        'New journal entries are interleaved with existing ones rather than appended at the end. ' +
        'Run `vp run db:renumber` to rebuild the tail.',
    });
  }

  return problems;
}

// ─── I/O ────────────────────────────────────────────────────────────────────

function readTree(repoRoot: string): TreeState {
  return {
    journal: parseJournal(readFileSync(resolve(repoRoot, JOURNAL_PATH), 'utf8')),
    filenames: readdirSync(resolve(repoRoot, DRIZZLE_DIR)),
  };
}

/** Read the same two inputs out of a git ref without checking it out. */
function readTreeAtRef(repoRoot: string, ref: string): TreeState | null {
  const git = (args: readonly string[]): string =>
    execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    return {
      journal: parseJournal(git(['show', `${ref}:${JOURNAL_PATH}`])),
      filenames: git(['ls-tree', '--name-only', `${ref}:${DRIZZLE_DIR}`])
        .split('\n')
        .filter(Boolean),
    };
  } catch (error) {
    console.warn(`::warning::Could not read ${DRIZZLE_DIR} at ${ref} (${String(error)}) — skipping base checks.`);
    return null;
  }
}

export interface Options {
  base: string | null;
  /** The repository to validate, when it isn't the one this script lives in. */
  repo: string | null;
}

export function parseArgs(argv: readonly string[]): Options {
  // Defaults to origin/main so a bare local run gets the collision and stale-`when`
  // checks too, not just the tree-only ones. An unreadable ref degrades to a warning.
  const options: Options = { base: 'origin/main', repo: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      // `vp run <task> -- <args>` forwards a literal `--` separator; it carries no meaning here.
      case '--':
        break;
      case '--base': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error('missing value for --base');
        options.base = value;
        index += 1;
        break;
      }
      case '--no-base':
        options.base = null;
        break;
      case '--repo': {
        const value = argv[index + 1];
        if (value === undefined) throw new Error('missing value for --repo');
        options.repo = value;
        index += 1;
        break;
      }
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  return options;
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  const repoRoot = options.repo ? resolve(options.repo) : resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const head = readTree(repoRoot);
  const base = options.base ? readTreeAtRef(repoRoot, options.base) : null;

  const addedTags = new Set<string>(
    base ? addedMigrations(base.filenames, head.filenames).map((file: MigrationFile) => file.tag) : [],
  );

  const problems = [...checkTree(head, addedTags), ...(base ? checkAgainstBase(base, head) : [])];

  if (problems.length === 0) {
    const count = migrationFiles(head.filenames).length;
    console.log(`[check-db-migrations] ${count} migrations, journal consistent.`);
    return 0;
  }

  for (const problem of problems) {
    console.error(`::error title=Migration check (${problem.kind})::${problem.message}`);
  }
  console.error(`[check-db-migrations] ${problems.length} problem(s) found.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
