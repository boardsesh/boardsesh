/// <reference types="node" />

/**
 * Prints the journal migrations a dev database still needs, one
 * `tag|when|hash` line each, in journal order.
 *
 * `scripts/dev-db-up.sh` pipes `SELECT hash FROM drizzle."__drizzle_migrations"`
 * into this on stdin and reads the lines back with `IFS='|' read`. It replaced an
 * inline `bun --eval` block that selected on `when > max(created_at)` — a single
 * high-water mark that only ever moves up, so any migration landing at or below
 * it was skipped on that run and every run after (#3979). The selection is a
 * per-entry hash diff now; see `scripts/lib/dev-db-pending-migrations.ts` for why
 * that is the only question worth asking.
 *
 * It is a pure read: file reads plus stdin. Nothing here connects to a database,
 * which is what keeps the shell script the only place that decides *which*
 * database is being repaired.
 *
 * Usage:
 *   psql -t -A -c 'SELECT hash FROM drizzle."__drizzle_migrations"' |
 *     DRIZZLE_DIR=packages/db/drizzle bun scripts/dev-db-pending-migrations.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatPendingMigrations,
  parseLedgerHashes,
  readJournalMigrations,
  selectPendingMigrations,
} from './lib/dev-db-pending-migrations.js';
import { DRIZZLE_DIR } from './lib/drizzle-migrations.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function main(): void {
  const drizzleDir = process.env.DRIZZLE_DIR ?? path.join(repoRoot, DRIZZLE_DIR);
  // fd 0 rather than a stream: the caller always pipes, the payload is a few
  // hundred short lines, and a synchronous read keeps this a single expression
  // the shell can capture in a `$(...)`.
  const ledgerHashes = parseLedgerHashes(readFileSync(0, 'utf8'));
  const pending = selectPendingMigrations(readJournalMigrations(drizzleDir), ledgerHashes);
  if (pending.length === 0) return;
  process.stdout.write(`${formatPendingMigrations(pending)}\n`);
}

main();
