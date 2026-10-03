/// <reference types="node" />

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * File-text guard for #3979.
 *
 * `scripts/dev-db-up.sh` is POSIX `sh` and root `scripts/` is not typechecked,
 * so the invariants that keep its pending-migration selection correct have no
 * other home. Running the script for real needs Docker, the pre-built image, and
 * a few minutes; these assertions cost a file read and catch the two ways the
 * fix could be undone — reintroducing the high-water mark, or dropping the
 * per-hash selector back into an inline `bun --eval`.
 */
const DEV_DB_UP_PATH = 'scripts/dev-db-up.sh';
const devDbUpSource = readFileSync(DEV_DB_UP_PATH, 'utf8');

/** Non-comment lines only — none of these bans may be satisfied by prose in a comment. */
const executableLines = devDbUpSource
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n');

const applyFunction = devDbUpSource.slice(devDbUpSource.indexOf('run_pending_drizzle_sql_migrations() {'));
const ownerAdviceStart = devDbUpSource.indexOf('explain_container_reset_owner() {');
const ownerAdviceEnd = devDbUpSource.indexOf('\n}\n', ownerAdviceStart) + 3;
const ownerAdviceFunction = devDbUpSource.slice(ownerAdviceStart, ownerAdviceEnd);

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
    const selectorPosition = applyFunction.indexOf('pending_migrations=$(');
    const migrationLoopPosition = applyFunction.indexOf("while IFS='|' read -r tag created_at hash; do");
    expect(executableLines).toMatch(/^set -e$/m);
    expect(selectorPosition).toBeGreaterThanOrEqual(0);
    expect(migrationLoopPosition).toBeGreaterThan(selectorPosition);
  });

  it('still records created_at as the journal when, the value drizzle writes', () => {
    // Anything else re-creates #4211: a ledger row whose timestamp is not the
    // journal's `when` gives drizzle's own applier a mark nobody predicted, and
    // gives the normaliser above a repair to make on every subsequent run.
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
