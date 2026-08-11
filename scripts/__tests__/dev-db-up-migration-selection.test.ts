/// <reference types="node" />

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

  it('explains a residue database instead of leaving the raw psql error', () => {
    // #3978's shape: the volume carries a superseded branch version of a
    // migration's objects but not its ledger row, so the apply dies on
    // "already exists". Nothing can repair that in place, so the failure has to
    // hand over the reset command rather than a bare SQL error.
    expect(applyFunction).toContain('docker compose down -v && vp run db:up');
    expect(applyFunction).toContain('exit 1');
  });
});
