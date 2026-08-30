/// <reference types="node" />

/**
 * Moves a branch's Drizzle migration onto the current `main` and renumbers it.
 *
 * Migration numbers are handed out first-come-first-served, so whichever PR merges
 * first takes the number and every other open migration PR goes red. Unblocking one
 * has been a hand ritual — rebase, resolve `_journal.json`, rebuild `packages/db`,
 * re-run `drizzle-kit generate`, paste the hand-tuned SQL back — performed 26 times
 * in this repo's history and documented nowhere. This script is that ritual, with the
 * parts that go wrong turned into assertions.
 *
 * Usage:
 *   vp run db:renumber                     # rebase onto origin/main and renumber
 *   vp run db:renumber -- --strategy merge # merge instead (no force-push needed)
 *   vp run db:renumber -- --dry-run        # do the work, skip the commit
 *
 * Exit codes: 0 = renumbered or nothing to do, 1 = blocked (a human must look).
 *
 * ─── Why it is shaped this way ────────────────────────────────────────────────
 *
 * **The contributor's SQL always survives.** A regenerated body is only ever used
 * as a diff to show a reviewer. Hand-tuning is real and load-bearing here (batched
 * backfills, explicit sequences, lock avoidance), and the body is what a human
 * reviewed — silently substituting drizzle's output would change reviewed SQL under
 * the author.
 *
 * **`drizzle-kit generate`'s exit code cannot be trusted.** `prepareAndMigratePg`
 * ends in `catch (e) { console.error(e); }` with no rethrow, and the folder reader
 * calls a bare `process.exit(0)` on a malformed snapshot or a snapshot-parent
 * collision. Every failure mode exits 0, so success is decided by diffing the
 * directory listing, never by the status code.
 *
 * **`meta/` is reset to main's exact bytes before generating.** After a rebase,
 * main's newest snapshot and the branch's both name the pre-fork snapshot as their
 * parent. drizzle-kit treats that as a collision and responds with a silent
 * `process.exit(0)`, so the reset is a correctness requirement, not tidiness.
 *
 * **No `--custom`.** It writes a snapshot that is a byte-copy of its predecessor.
 * A migration with no schema delta gets a hand-written journal entry and no
 * snapshot at all, which leaves main's tail snapshot as the newest — correct, and
 * consistent with the 43 snapshot-less migrations already on main.
 *
 * **Tag references are never rewritten inside a migration body.** Seven migrations
 * write an idempotency guard row into `_bs_migration_guards`, and that key is not
 * the filename (`0163_merge_moonboard_duplicates.sql` guards on
 * `0162_merge_moonboard_duplicates`). Rewriting it would make an already-applied
 * migration run again on every machine that had the old number.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DRIZZLE_DIR,
  JOURNAL_PATH,
  addedMigrations,
  collides,
  findOrphans,
  isCustomMigration,
  journalEntryFor,
  maxWhen,
  nextFreeIndex,
  nextWhen,
  padIndex,
  parseJournal,
  planRenumber,
  rewriteTagReferences,
  serializeJournal,
  type MigrationFile,
  type RenumberMove,
} from './lib/drizzle-migrations';

/** drizzle-kit can sit on an interactive resolver prompt; never let that hang CI. */
const GENERATE_TIMEOUT_MS = 300_000;

export type Status = 'no-op' | 'renumbered' | 'blocked';
export type Strategy = 'rebase' | 'merge';

export interface SqlDivergence {
  tag: string;
  original: string;
  generated: string;
}

export interface RenumberResult {
  status: Status;
  /** Set when status is `blocked` — the single reason a human needs to act. */
  reason: string | null;
  strategy: Strategy;
  moves: RenumberMove[];
  /** Migrations whose regenerated body differs from what the author wrote. */
  diverged: SqlDivergence[];
  /** Files outside the migration folder whose tag references were updated. */
  rewritten: string[];
  /** Warnings worth surfacing on the PR but not worth blocking over. */
  notes: string[];
}

export const STICKY_MARKER = '<!-- db-renumber -->';

// ─── PURE ───────────────────────────────────────────────────────────────────

/** PURE: whitespace-insensitive SQL comparison, for "did drizzle produce the same thing". */
export function normalizeSql(sql: string): string {
  return sql
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * PURE: can this set of rebase conflicts be resolved automatically?
 *
 * Only conflicts wholly inside the migration folder are mechanical (both sides
 * appended to the journal tail, or both claimed the same number). A conflict
 * anywhere else is a real semantic overlap and must go back to a human — resolving
 * it by rule would silently pick a side of someone's code.
 */
export function conflictsAreResolvable(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every((path) => path.startsWith(`${DRIZZLE_DIR}/`));
}

/**
 * PURE: classify a `drizzle-kit generate` run from the folder listing around it.
 *
 * The status code is meaningless (see the file header), so a run "worked" only if
 * it left a new migration file behind. `stdout` narrows the message when it didn't.
 */
export function classifyGenerate(
  before: readonly string[],
  after: readonly string[],
  stdout: string,
): { generated: string | null; detail: string } {
  const known = new Set(before);
  const fresh = after.filter((name) => !known.has(name) && name.endsWith('.sql'));
  if (fresh.length === 1) return { generated: fresh[0] ?? null, detail: '' };
  if (fresh.length > 1) {
    return { generated: null, detail: `generate wrote ${fresh.length} migrations (${fresh.join(', ')})` };
  }
  if (stdout.includes('No schema changes')) {
    return { generated: null, detail: 'no schema delta versus main' };
  }
  if (stdout.includes('pointing to a parent snapshot')) {
    return { generated: null, detail: 'snapshot parent collision — meta/ was not reset to main' };
  }
  return { generated: null, detail: `generate produced nothing${stdout.trim() ? `: ${stdout.trim()}` : ''}` };
}

/** PURE: the PR comment body. */
export function renderComment(result: RenumberResult): string {
  const lines: string[] = [STICKY_MARKER, ''];

  if (result.status === 'blocked') {
    lines.push(
      '### 🚧 Couldn’t renumber this migration automatically',
      '',
      result.reason ?? 'Unknown reason.',
      '',
      'Nothing was pushed. Rebase on `main` and run `vp run db:renumber` locally, or fix the',
      'conflict by hand.',
    );
    return lines.join('\n');
  }

  if (result.status === 'no-op') {
    lines.push('### ✅ Migration number is already free', '', 'Nothing to renumber against the current `main`.');
    return lines.join('\n');
  }

  const moved = result.moves.map((move) => `\`${move.from.filename}\` → \`${move.toFilename}\``).join(', ');
  lines.push(
    `### 🔢 Renumbered onto \`main\` (${result.strategy})`,
    '',
    `${moved}. Your SQL is unchanged — only the number, the journal entry and the snapshot moved.`,
    '',
  );

  if (result.diverged.length > 0) {
    lines.push(
      '<details><summary>⚠️ Regenerated SQL differs from yours — <b>yours was kept</b></summary>',
      '',
      'Worth a look: either your SQL is deliberately hand-tuned (fine, ignore this), or `main`',
      'has since changed the same tables and your migration may no longer do what it did.',
      '',
    );
    for (const divergence of result.diverged) {
      lines.push(
        `**\`${divergence.tag}\`** — what \`drizzle-kit generate\` would write now:`,
        '',
        '```sql',
        divergence.generated.trim(),
        '```',
        '',
      );
    }
    lines.push('</details>', '');
  }

  if (result.rewritten.length > 0) {
    lines.push(`Also updated the old tag in ${result.rewritten.map((path) => `\`${path}\``).join(', ')}.`, '');
  }

  for (const note of result.notes) lines.push(`> ℹ️ ${note}`, '');

  return lines.join('\n');
}

// ─── I/O ────────────────────────────────────────────────────────────────────

interface Git {
  (args: readonly string[]): string;
}

function makeGit(repoRoot: string): Git {
  return (args: readonly string[]): string =>
    execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    }).trimEnd();
}

/** Run a git command that is allowed to fail; returns null instead of throwing. */
function tryGit(git: Git, args: readonly string[]): string | null {
  try {
    return git(args);
  } catch {
    return null;
  }
}

function listRefDir(git: Git, ref: string, path: string): string[] {
  const output = tryGit(git, ['ls-tree', '--name-only', `${ref}:${path}`]);
  return output ? output.split('\n').filter(Boolean) : [];
}

/**
 * Read a file's exact bytes out of a ref.
 *
 * Deliberately NOT the trimming `Git` wrapper: that is right for command output
 * like SHAs and path lists, and wrong for file contents. Trimming here would eat a
 * migration's trailing newline and silently rewrite the author's file — the one
 * thing this script promises never to do.
 */
function readBlob(repoRoot: string, ref: string, path: string): string {
  return execFileSync('git', ['show', `${ref}:${path}`], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

class Blocked extends Error {}

function block(reason: string): never {
  throw new Blocked(reason);
}

/**
 * Drive a rebase to completion, resolving migration-folder conflicts by rule.
 *
 * A PR with several commits hits the journal conflict once per commit, so this is a
 * loop rather than a single resolve. `rerere` is disabled explicitly: a cached
 * resolution from an earlier run on a self-hosted runner would be applied blind.
 */
function rebaseOntoBase(git: Git, repoRoot: string, base: string): void {
  tryGit(git, ['-c', 'rerere.enabled=false', '-c', 'core.editor=true', 'rebase', base]);

  for (let guard = 0; guard < 200; guard += 1) {
    if (!rebaseInProgress(repoRoot, git)) return;

    const unmerged = (tryGit(git, ['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);
    if (!conflictsAreResolvable(unmerged)) {
      tryGit(git, ['rebase', '--abort']);
      block(
        unmerged.length === 0
          ? 'The rebase stopped without a resolvable conflict.'
          : `The rebase conflicts outside the migration folder:\n${unmerged.map((path) => `- \`${path}\``).join('\n')}`,
      );
    }

    for (const path of unmerged) {
      if (path.startsWith(`${DRIZZLE_DIR}/meta/`)) {
        // Metadata is always main's. Drop branch-only meta files main doesn't have.
        if (tryGit(git, ['cat-file', '-e', `${base}:${path}`]) !== null) {
          git(['checkout', base, '--', path]);
        } else {
          tryGit(git, ['rm', '-qf', '--', path]);
        }
      } else {
        // An add/add on the same .sql path (both sides used the same --name).
        // Keep the branch's body so later commits in the series still apply; the
        // file is removed and rewritten under its new number after the rebase.
        // `--theirs` during a rebase is the commit being replayed, i.e. the branch.
        if (tryGit(git, ['checkout', '--theirs', '--', path]) === null) {
          git(['checkout', base, '--', path]);
        }
        git(['add', '--', path]);
      }
    }
    git(['add', '-A', '--', DRIZZLE_DIR]);

    // A commit whose only content was the journal entry is now empty; dropping it
    // is correct, and `rebase --continue` refuses to proceed past one.
    const staged = tryGit(git, ['diff', '--cached', '--quiet']);
    if (staged === null) {
      tryGit(git, ['-c', 'core.editor=true', 'rebase', '--continue']);
    } else {
      tryGit(git, ['rebase', '--skip']);
    }
  }
  tryGit(git, ['rebase', '--abort']);
  block('The rebase did not converge after 200 steps.');
}

/** Is a rebase mid-flight? Both state dirs are checked; git picks one by backend. */
function rebaseInProgress(repoRoot: string, git: Git): boolean {
  return ['rebase-merge', 'rebase-apply'].some((stateDir) => {
    const gitPath = tryGit(git, ['rev-parse', '--git-path', stateDir]);
    return gitPath !== null && existsSync(resolve(repoRoot, gitPath));
  });
}

function mergeBaseRef(git: Git, base: string): void {
  const merged = tryGit(git, ['-c', 'core.editor=true', 'merge', '--no-edit', base]);
  if (merged !== null) return;

  const unmerged = (tryGit(git, ['diff', '--name-only', '--diff-filter=U']) ?? '').split('\n').filter(Boolean);
  if (!conflictsAreResolvable(unmerged)) {
    tryGit(git, ['merge', '--abort']);
    block(`The merge conflicts outside the migration folder:\n${unmerged.map((path) => `- \`${path}\``).join('\n')}`);
  }
  for (const path of unmerged) {
    if (path.startsWith(`${DRIZZLE_DIR}/meta/`)) {
      if (tryGit(git, ['cat-file', '-e', `${base}:${path}`]) !== null) {
        git(['checkout', base, '--', path]);
      } else {
        tryGit(git, ['rm', '-qf', '--', path]);
      }
    } else {
      // An add/add on the same .sql path. Resolve to the branch's body BEFORE
      // staging — a bare `git add` here would commit the conflict markers.
      //
      // Note the orientation is the OPPOSITE of the rebase path above. Merging
      // main into the branch makes `--ours` the branch and `--theirs` main; a
      // rebase replays the branch onto main, so there `--ours` is main. Both want
      // the branch's body, so they need different flags.
      if (tryGit(git, ['checkout', '--ours', '--', path]) === null) {
        git(['checkout', base, '--', path]);
      }
      git(['add', '--', path]);
    }
  }
  git(['add', '-A', '--', DRIZZLE_DIR]);
  tryGit(git, ['-c', 'core.editor=true', 'commit', '--no-edit']);
  if (tryGit(git, ['diff', '--name-only', '--diff-filter=U']) !== '') {
    block('The merge left unresolved conflicts in the migration folder.');
  }
}

/**
 * Force `packages/db/drizzle/meta/` to be byte-identical to main.
 *
 * `git checkout <ref> -- <dir>` only writes; it never removes files the ref lacks,
 * so a branch-only snapshot would survive and collide. Removing first is what makes
 * this a reset rather than an overlay.
 */
function resetMetaToBase(git: Git, base: string): void {
  for (const path of (tryGit(git, ['ls-files', '--', `${DRIZZLE_DIR}/meta/`]) ?? '').split('\n').filter(Boolean)) {
    if (tryGit(git, ['cat-file', '-e', `${base}:${path}`]) === null) {
      tryGit(git, ['rm', '-qf', '--', path]);
    }
  }
  git(['checkout', base, '--', `${DRIZZLE_DIR}/meta/`]);
  if (tryGit(git, ['diff', '--quiet', base, '--', `${DRIZZLE_DIR}/meta/`]) === null) {
    block('Could not reset the migration metadata to main — refusing to generate against a mixed snapshot chain.');
  }
}

function runGenerate(repoRoot: string, suffix: string): { generated: string | null; detail: string } {
  const dbDir = resolve(repoRoot, 'packages/db');
  const drizzleDir = resolve(repoRoot, DRIZZLE_DIR);
  const before = readdirSync(drizzleDir);
  let stdout = '';
  try {
    stdout = execFileSync('vp', ['exec', 'drizzle-kit', 'generate', '--name', suffix], {
      cwd: dbDir,
      encoding: 'utf8',
      // No stdin: an interactive resolver prompt EOFs instead of hanging forever.
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GENERATE_TIMEOUT_MS,
    });
  } catch (error) {
    stdout = String(error);
  }
  return classifyGenerate(before, readdirSync(drizzleDir), stdout);
}

/** Write a migration and its journal entry by hand — no snapshot, no drizzle-kit. */
function placeMigration(repoRoot: string, move: RenumberMove, body: string, when: number): void {
  writeFileSync(resolve(repoRoot, DRIZZLE_DIR, move.toFilename), body);
  const journalPath = resolve(repoRoot, JOURNAL_PATH);
  const journal = parseJournal(readFileSync(journalPath, 'utf8'));
  journal.entries.push(journalEntryFor(move.toIndex, move.from.suffix, when));
  writeFileSync(journalPath, serializeJournal(journal));
}

export interface Options {
  strategy: Strategy;
  dryRun: boolean;
  fetch: boolean;
  install: boolean;
  /** The ref to renumber against. Overridable so the flow can be exercised in a test tree. */
  base: string;
  /**
   * The repository to operate on, when it isn't the one this script lives in.
   *
   * Every PR in today's backlog was opened before this tooling existed, so their
   * branches have no `scripts/db-renumber-migration.ts` and no `db:renumber` task
   * to invoke. The workflow therefore runs main's copy of the script against the
   * PR's checkout. The script has no npm dependencies — only Node builtins and its
   * own `lib/` sibling — so it runs fine from outside the tree it is fixing.
   */
  repo: string | null;
}

export function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    base: 'origin/main',
    strategy: 'rebase',
    dryRun: false,
    fetch: true,
    install: false,
    repo: null,
  };
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
      case '--strategy': {
        const value = argv[index + 1];
        if (value !== 'rebase' && value !== 'merge') throw new Error('--strategy must be rebase or merge');
        options.strategy = value;
        index += 1;
        break;
      }
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--no-fetch':
        options.fetch = false;
        break;
      case '--install':
        options.install = true;
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

function emitGithubOutputs(result: RenumberResult): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) return;
  appendFileSync(
    outputPath,
    [
      `status=${result.status}`,
      `renamed_from=${result.moves.map((move) => move.from.filename).join(',')}`,
      `renamed_to=${result.moves.map((move) => move.toFilename).join(',')}`,
      `sql_diverged=${result.diverged.length > 0}`,
      `comment_b64=${Buffer.from(renderComment(result), 'utf8').toString('base64')}`,
      '',
    ].join('\n'),
  );
}

function run(repoRoot: string, options: Options): RenumberResult {
  const git = makeGit(repoRoot);
  const result: RenumberResult = {
    status: 'no-op',
    reason: null,
    strategy: options.strategy,
    moves: [],
    diverged: [],
    rewritten: [],
    notes: [],
  };

  if (tryGit(git, ['diff', '--quiet', 'HEAD']) === null) {
    block('The working tree has uncommitted changes. Commit or stash them first.');
  }
  if (options.fetch && options.base === 'origin/main') git(['fetch', '--no-tags', 'origin', 'main']);

  const originalHead = git(['rev-parse', 'HEAD']);
  const mainFilenames = listRefDir(git, options.base, DRIZZLE_DIR);
  const headFilenames = listRefDir(git, originalHead, DRIZZLE_DIR);
  const added = addedMigrations(mainFilenames, headFilenames);
  if (added.length === 0) {
    console.log('[db-renumber] This branch adds no migrations.');
    return result;
  }

  const mainJournal = parseJournal(readBlob(repoRoot, options.base, JOURNAL_PATH));
  const nextFree = nextFreeIndex(mainJournal, mainFilenames);
  if (!collides(added, nextFree)) {
    console.log(
      `[db-renumber] ${added.map((file) => file.filename).join(', ')} already sits above main (${padIndex(nextFree - 1)}).`,
    );
    return result;
  }

  const moves = planRenumber(added, nextFree);
  result.moves = moves;

  // Capture the author's bytes before any history rewrite can touch them.
  const originals = new Map<string, string>(
    added.map((file: MigrationFile) => [file.tag, readBlob(repoRoot, originalHead, `${DRIZZLE_DIR}/${file.filename}`)]),
  );

  // Everything outside the migration folder that this branch, and only this branch,
  // touched. The rebase must leave every one of these blobs untouched.
  const mergeBase = git(['merge-base', originalHead, options.base]);
  const branchTouched = new Set(
    (tryGit(git, ['diff', '--name-only', mergeBase, originalHead, '--', '.', `:(exclude)${DRIZZLE_DIR}/**`]) ?? '')
      .split('\n')
      .filter(Boolean),
  );
  const mainTouched = new Set(
    (tryGit(git, ['diff', '--name-only', mergeBase, options.base, '--', '.', `:(exclude)${DRIZZLE_DIR}/**`]) ?? '')
      .split('\n')
      .filter(Boolean),
  );
  const branchOnly = [...branchTouched].filter((path) => !mainTouched.has(path));
  const blobsBefore = new Map(branchOnly.map((path) => [path, tryGit(git, ['rev-parse', `${originalHead}:${path}`])]));

  if (options.strategy === 'merge') mergeBaseRef(git, options.base);
  else rebaseOntoBase(git, repoRoot, options.base);

  resetMetaToBase(git, options.base);
  for (const file of added) tryGit(git, ['rm', '-qf', '--', `${DRIZZLE_DIR}/${file.filename}`]);
  // A conflict resolution may have left the old file on disk but unstaged.
  for (const file of added) rmSync(resolve(repoRoot, DRIZZLE_DIR, file.filename), { force: true });

  // Does this branch change the schema at all? A data/backfill migration doesn't,
  // and then no build and no drizzle-kit run is needed.
  const touchesSchema =
    tryGit(git, ['diff', '--quiet', options.base, 'HEAD', '--', 'packages/db/src/schema/']) === null;

  let when = nextWhen(maxWhen(mainJournal), Date.now());

  if (touchesSchema) {
    if (options.install) execFileSync('vp', ['install', '--frozen-lockfile'], { cwd: repoRoot, stdio: 'inherit' });
    // drizzle.config.ts reads ./dist/schema/index.js — a stale build makes generate
    // see phantom column renames and stop on an interactive prompt.
    execFileSync('vp', ['run', 'build:db'], { cwd: repoRoot, stdio: 'inherit' });

    // Everything but the last migration is hand-written; drizzle-kit can only ever
    // emit one migration (its snapshot is always the full current schema), so the
    // single generate lands the tail and its snapshot.
    for (const move of moves.slice(0, -1)) {
      placeMigration(repoRoot, move, originals.get(move.from.tag) ?? '', when);
      when += 1;
    }
    const tail = moves[moves.length - 1];
    if (!tail) block('No migrations to renumber.');

    const outcome = runGenerate(repoRoot, tail.from.suffix);
    if (outcome.generated === null) {
      // A schema migration MUST come with a regenerated snapshot. Placing it by
      // hand would leave main's older snapshot as the newest in the chain, so the
      // next `drizzle-kit generate` anyone runs would diff against a schema state
      // that understates reality and propose the same DDL a second time. Better to
      // stop and say why: the two live causes are "main already made this change"
      // and "drizzle wants to disambiguate a rename", and both need a human.
      block(
        `\`drizzle-kit generate\` produced no migration for \`${tail.from.tag}\` (${outcome.detail}).\n\n` +
          'A schema migration needs a regenerated snapshot, so it cannot be renumbered by hand. ' +
          'Most often this means `main` already landed the same change, or drizzle needs you to say ' +
          'whether a table/column was created or renamed. Rebase locally and run ' +
          '`vp exec drizzle-kit generate` from `packages/db` to see the prompt.',
      );
    } else {
      if (outcome.generated !== tail.toFilename) {
        block(
          `drizzle-kit numbered the migration \`${outcome.generated}\` but \`${tail.toFilename}\` was expected — ` +
            'the journal and the folder disagree about the next number.',
        );
      }
      const generatedPath = resolve(repoRoot, DRIZZLE_DIR, outcome.generated);
      const generatedBody = readFileSync(generatedPath, 'utf8');
      const originalBody = originals.get(tail.from.tag) ?? '';
      if (normalizeSql(generatedBody) !== normalizeSql(originalBody)) {
        result.diverged.push({ tag: tail.toTag, original: originalBody, generated: generatedBody });
      }
      // The author's bytes win; drizzle's version is only ever a review aid.
      writeFileSync(generatedPath, originalBody);

      // drizzle stamps its own Date.now(), which can tie with ours in the same
      // millisecond; force the tail strictly above everything already journalled.
      const journalPath = resolve(repoRoot, JOURNAL_PATH);
      const journal = parseJournal(readFileSync(journalPath, 'utf8'));
      const tailEntry = journal.entries[journal.entries.length - 1];
      if (tailEntry) {
        tailEntry.when = when;
        writeFileSync(journalPath, serializeJournal(journal));
      }
    }
  } else {
    for (const move of moves) {
      const body = originals.get(move.from.tag) ?? '';
      if (isCustomMigration(body)) {
        result.notes.push(`\`${move.toTag}\` is a hand-written migration — its SQL was carried over verbatim.`);
      }
      placeMigration(repoRoot, move, body, when);
      when += 1;
    }
  }

  // Update filename-shaped references to the old tag, but only in files this branch
  // itself touched — those are provably the author's own lookups (the
  // `dedup-replay.ts` pattern). A hit in a file the branch never touched is a
  // pre-existing `_bs_migration_guards` key, which must not move.
  for (const move of moves) {
    const hits = (tryGit(git, ['grep', '-Il', move.from.tag, '--', `:(exclude)${DRIZZLE_DIR}`]) ?? '')
      .split('\n')
      .filter(Boolean);
    const foreign = hits.filter((path) => !branchTouched.has(path));
    if (foreign.length > 0) {
      block(
        `\`${move.from.tag}\` is referenced by files this branch didn't touch:\n` +
          `${foreign.map((path) => `- \`${path}\``).join('\n')}\n\n` +
          'Those are most likely `_bs_migration_guards` keys, which must not be renumbered. Renumber by hand.',
      );
    }
    for (const path of hits) {
      const absolute = resolve(repoRoot, path);
      const before = readFileSync(absolute, 'utf8');
      const after = rewriteTagReferences(before, move.from.tag, move.toTag);
      if (after !== before) {
        writeFileSync(absolute, after);
        result.rewritten.push(path);
      }
    }
  }

  // Nothing may have silently changed outside the migration folder.
  for (const [path, before] of blobsBefore) {
    const after = tryGit(git, ['rev-parse', `HEAD:${path}`]);
    if (before !== after) {
      block(`The rebase altered \`${path}\`, which this branch owns. Refusing to continue.`);
    }
  }

  // Only orphans this run *introduced* are a reason to stop. Main can already carry
  // one — 0177_illegal_omega_red.sql sat there for weeks — and inheriting it must
  // not wedge every renumber. `vp run check:db-migrations` is what reports those.
  const inheritedOrphans = findOrphans(mainJournal, mainFilenames);
  const orphans = findOrphans(
    parseJournal(readFileSync(resolve(repoRoot, JOURNAL_PATH), 'utf8')),
    readdirSync(resolve(repoRoot, DRIZZLE_DIR)),
  );
  const newOrphanFiles = orphans.sqlWithoutEntry.filter(
    (filename) => !inheritedOrphans.sqlWithoutEntry.includes(filename),
  );
  const newOrphanEntries = orphans.entryWithoutSql.filter((tag) => !inheritedOrphans.entryWithoutSql.includes(tag));
  if (newOrphanFiles.length > 0 || newOrphanEntries.length > 0) {
    block(
      'The renumber left the migration folder inconsistent ' +
        `(orphan files: ${newOrphanFiles.join(', ') || 'none'}; ` +
        `orphan entries: ${newOrphanEntries.join(', ') || 'none'}).`,
    );
  }
  if (inheritedOrphans.sqlWithoutEntry.length > 0) {
    result.notes.push(
      `\`main\` carries an orphaned migration (${inheritedOrphans.sqlWithoutEntry.join(', ')}) with no journal ` +
        'entry, so it never runs. Not caused by this PR — worth deleting on main.',
    );
  }

  result.status = 'renumbered';
  if (options.dryRun) {
    console.log('[db-renumber] --dry-run: leaving the changes uncommitted.');
    return result;
  }

  // Stage exactly what we touched, never `git add -A`. This commit lands on someone
  // else's branch, so it must not be able to sweep in a stray build artifact, an
  // untracked scratch file, or the tooling checkout CI places in the workspace.
  git(['add', '--', DRIZZLE_DIR]);
  for (const path of result.rewritten) git(['add', '--', path]);

  const subject =
    moves.length === 1 && moves[0]
      ? `chore(db): renumber ${moves[0].from.suffix} to ${padIndex(moves[0].toIndex)} after main`
      : `chore(db): renumber ${moves.length} migrations to ${padIndex(nextFree)}+ after main`;
  git(['commit', '-m', subject]);
  return result;
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const options = parseArgs(argv);
  const repoRoot = options.repo ? resolve(options.repo) : resolve(dirname(fileURLToPath(import.meta.url)), '..');

  let result: RenumberResult;
  try {
    result = run(repoRoot, options);
  } catch (error) {
    if (!(error instanceof Blocked)) throw error;
    result = {
      status: 'blocked',
      reason: error.message,
      strategy: options.strategy,
      moves: [],
      diverged: [],
      rewritten: [],
      notes: [],
    };
  }

  for (const move of result.moves) {
    console.log(`[db-renumber] ${move.from.filename} → ${move.toFilename}`);
  }
  for (const note of result.notes) console.warn(`::warning::${note}`);
  if (result.status === 'blocked') console.error(`::error::${result.reason}`);
  console.log(`[db-renumber] status: ${result.status}`);

  emitGithubOutputs(result);
  return result.status === 'blocked' ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
