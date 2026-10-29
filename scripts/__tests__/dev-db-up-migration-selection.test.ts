/// <reference types="node" />

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

/**
 * File-text guard for #3979.
 *
 * `scripts/dev-db-up.sh` is POSIX `sh` and root `scripts/` is not typechecked,
 * so the invariants that keep its pending-migration selection correct have no
 * other home. Running the script for real needs Docker, the pre-built image, and
 * a few minutes; these assertions cost a file read and catch the two ways the
 * fix could be undone — reintroducing the high-water mark, or dropping the
 * per-hash selector back into an inline `node -e`.
 */
const DEV_DB_UP_PATH = 'scripts/dev-db-up.sh';
const devDbUpSource = readFileSync(DEV_DB_UP_PATH, 'utf8');

/** Non-comment lines only — none of these bans may be satisfied by prose in a comment. */
const executableLines = devDbUpSource
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

const applyFunction = devDbUpSource.slice(devDbUpSource.indexOf('run_pending_drizzle_sql_migrations() {'));

/** One `name() { ... }` block, up to its closing brace at column zero. */
function shellFunction(name: string): string {
  const start = devDbUpSource.indexOf(`${name}() {`);
  const end = devDbUpSource.indexOf('\n}\n', start) + 3;
  return devDbUpSource.slice(start, end);
}

const ownerAdviceFunction = shellFunction('explain_container_reset_owner');

function runOwnerAdvice(labels: string, repoRoot: string): string {
  const isolatedShell = [
    'docker() { printf "%s" "$MOCK_DOCKER_LABELS"; }',
    ownerAdviceFunction,
    'explain_container_reset_owner 2>&1',
  ].join('\n');
  return execFileSync('sh', ['-c', isolatedShell], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MOCK_DOCKER_LABELS: labels,
      PG_CONTAINER: 'owned-fixture-container',
      REPO_ROOT: repoRoot,
    },
  });
}

/**
 * Runs the real apply function with `docker` and `vp` stubbed: the selector
 * refuses (exit 1, nothing on stdout), and the caller invokes the function
 * under `||`, which turns `set -e` off inside it. Only an explicit exit stops it.
 */
function runApplyWithRefusingSelector(): { status: number | null; output: string } {
  const isolatedShell = [
    'set -e',
    'docker() {',
    '  case "$*" in',
    '    *inspect*) printf "%s" "fixture|$REPO_ROOT|$REPO_ROOT/docker-compose.yml" ;;',
    '    *"-i -u postgres"*) echo "MIGRATION SQL RAN" ;;',
    '    *) echo "hash-of-0000_a" ;;',
    '  esac',
    '}',
    'vp() { cat > /dev/null; echo "SELECTOR REFUSED" >&2; return 1; }',
    ownerAdviceFunction,
    shellFunction('run_pending_drizzle_sql_migrations'),
    'run_pending_drizzle_sql_migrations || echo "CALLER CONTINUED"',
    'echo "SCRIPT CONTINUED"',
  ].join('\n');
  const result = spawnSync('sh', ['-c', isolatedShell], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DRIZZLE_DIR: '/nonexistent',
      PG_CONTAINER: 'owned-fixture-container',
      // A directory that exists, so the subshell's `cd` succeeds and the
      // refusal comes from the stubbed selector itself.
      REPO_ROOT: tmpdir(),
    },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe('dev-db-up.sh pending-migration selection', () => {
  it('never selects on a created_at high-water mark', () => {
    // The bug itself: one `max(created_at)` snapshot, then `when > mark`. The
    // mark only ever moves up, so anything at or below it is skipped on this run
    // and on every run after it.
    expect(executableLines).not.toContain('LAST_MIGRATION_CREATED_AT');
    expect(executableLines).not.toContain('last_migration_created_at');
    expect(executableLines).not.toContain('ORDER BY created_at DESC');
    expect(executableLines).not.toContain('entry.when <= lastAppliedAt');
  });

  it('feeds the ledger hashes to the per-hash selector', () => {
    expect(executableLines).toContain('SELECT hash FROM drizzle.\\"__drizzle_migrations\\"');
    expect(executableLines).toContain('scripts/dev-db-pending-migrations.ts');
    expect(executableLines).toContain('ORDER BY id');
    expect(executableLines).toContain('vp exec tsx scripts/dev-db-pending-migrations.ts');
    expect(executableLines).not.toContain('bun scripts/dev-db-pending-migrations.ts');
  });

  it('stops on a selector refusal before entering the migration SQL loop', () => {
    const refusalGuard = applyFunction.indexOf('if ! pending_migrations=$(');
    const migrationLoopPosition = applyFunction.indexOf("while IFS='|' read -r tag created_at hash; do");
    expect(refusalGuard).toBeGreaterThanOrEqual(0);
    expect(migrationLoopPosition).toBeGreaterThan(refusalGuard);

    // Behavioural: even with `set -e` switched off by a caller's `||`, a
    // refusal exits 1, names the volume owner, and never reaches the loop or
    // the "No pending migrations." early return.
    const { status, output } = runApplyWithRefusingSelector();
    expect(status).toBe(1);
    expect(output).toContain('SELECTOR REFUSED');
    expect(output).toContain('No migration SQL was run.');
    expect(output).toContain('This checkout owns the volume.');
    expect(output).not.toContain('No pending migrations.');
    expect(output).not.toContain('MIGRATION SQL RAN');
    expect(output).not.toContain('CALLER CONTINUED');
    expect(output).not.toContain('SCRIPT CONTINUED');
  });

  it('still records created_at as the journal when, the value drizzle writes', () => {
    // Anything else re-creates #4211: a ledger row whose timestamp is not the
    // journal's `when` gives drizzle's own applier a mark nobody predicted.
    expect(applyFunction).toContain('INSERT INTO drizzle."__drizzle_migrations" (hash, created_at) VALUES (%s, %s);');
    expect(applyFunction).toContain("while IFS='|' read -r tag created_at hash; do");
  });

  it('keeps every migration in a transaction that aborts on the first error', () => {
    expect(applyFunction).toContain('ON_ERROR_STOP=1');
    expect(applyFunction).toContain("printf 'BEGIN;\\n'");
    expect(applyFunction).toContain("printf 'COMMIT;\\n'");
  });

  it('reports the actual Compose owner and requires its disposable-data confirmation', () => {
    const ownerNotice = runOwnerAdvice(
      'boardsesh-shared|/workspaces/owner-project|/workspaces/owner-project/docker-compose.yml',
      '/workspaces/current-project',
    );
    expect(ownerNotice).toContain("Compose project 'boardsesh-shared'");
    expect(ownerNotice).toContain("Owner working directory: '/workspaces/owner-project'");
    expect(ownerNotice).toContain("This checkout is '/workspaces/current-project'");
    expect(ownerNotice).toContain('confirm its volume is disposable');
    expect(ownerNotice).not.toContain('docker compose down -v');
  });

  it('prints the reset command only when this checkout owns the volume', () => {
    const ownerNotice = runOwnerAdvice(
      'boardsesh-wt|/workspaces/current-project|/workspaces/current-project/docker-compose.yml',
      '/workspaces/current-project',
    );
    expect(ownerNotice).toContain('This checkout owns the volume.');
    expect(ownerNotice).toContain('docker compose down -v && vp run db:up');
    expect(ownerNotice).not.toContain('do not run a volume reset');
  });

  it('directs the operator to the owner when Compose identity labels are missing', () => {
    const ownerNotice = runOwnerAdvice('<no value>|<no value>|<no value>', '/workspaces/current-project');
    expect(ownerNotice).toContain('Could not establish PG_CONTAINER');
    expect(ownerNotice).toContain('Ask the container owner to identify its project');
    expect(ownerNotice).toContain('do not reset it from this checkout');
    expect(ownerNotice).not.toContain('docker compose down -v');
  });

  it('explains an apply failure without printing an unscoped volume reset command', () => {
    expect(applyFunction).toContain('explain_container_reset_owner');
    expect(applyFunction).not.toContain('docker compose down -v && vp run db:up');
    expect(applyFunction).toContain('exit 1');
  });
});
