import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  formatPendingMigrations,
  hashMigrationFile,
  parseLedgerHashes,
  readJournalMigrations,
  selectPendingMigrations,
} from './dev-db-pending-migrations';
import type { ExpectedMigrationWithWhen } from './migration-ledger';

function entry(tag: string, when: number, hash = `hash-of-${tag}`): ExpectedMigrationWithWhen {
  return { tag, when, hash };
}

/** A throwaway `packages/db/drizzle`-shaped folder: `meta/_journal.json` plus the `.sql` files. */
function writeMigrationsFolder(entries: readonly { tag: string; when: number; body: string }[]): string {
  const folder = mkdtempSync(join(tmpdir(), 'dev-db-pending-'));
  mkdirSync(join(folder, 'meta'), { recursive: true });
  writeFileSync(
    join(folder, 'meta', '_journal.json'),
    JSON.stringify({
      version: '7',
      dialect: 'postgresql',
      entries: entries.map((item, index) => ({
        idx: index,
        version: '7',
        when: item.when,
        tag: item.tag,
        breakpoints: true,
      })),
    }),
  );
  for (const item of entries) {
    writeFileSync(join(folder, `${item.tag}.sql`), item.body);
  }
  return folder;
}

describe('selectPendingMigrations', () => {
  it('selects a migration whose when is below the newest applied entry (#3979)', () => {
    // The whole bug. `0002_stale_when` was renumbered onto a `when` older than
    // the already-applied `0001_b`, so the old `when > max(created_at)` filter
    // skipped it on that run — and, because the mark only moves up, on every run
    // after it. Its hash is absent, so the hash-keyed question gets it right.
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000), entry('0002_stale_when', 2000)];
    const pending = selectPendingMigrations(journal, ['hash-of-0000_a', 'hash-of-0001_b']);
    expect(pending.map((migration) => migration.tag)).toEqual(['0002_stale_when']);
  });

  it('selects nothing when every journal hash has a ledger row', () => {
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000)];
    expect(selectPendingMigrations(journal, ['hash-of-0001_b', 'hash-of-0000_a'])).toEqual([]);
  });

  it('selects the whole journal against an empty ledger', () => {
    // A fresh tracker — the shell script creates the table before this runs, so
    // "no rows" is a normal state and must not read as "nothing to do".
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000)];
    expect(selectPendingMigrations(journal, []).map((migration) => migration.tag)).toEqual(['0000_a', '0001_b']);
  });

  it('needs one ledger row per byte-identical .sql, not one per hash', () => {
    // Duplicate-content migrations have shipped here before (0177_illegal_omega_red).
    // A Set-based diff would call the second one applied and skip it forever.
    const shared = 'sha-of-identical-bodies';
    const journal = [entry('0000_a', 1000, shared), entry('0001_b', 2000, shared)];
    expect(selectPendingMigrations(journal, [shared]).map((migration) => migration.tag)).toEqual(['0001_b']);
    expect(selectPendingMigrations(journal, [shared, shared])).toEqual([]);
  });

  it('ignores ledger hashes that belong to no journal entry', () => {
    // Renumber residue. The shared dev database carries three such rows; failing
    // or re-applying on them would break `vp run db:up` for a non-problem.
    const journal = [entry('0000_a', 1000), entry('0001_b', 2000)];
    const ledger = ['hash-of-0000_a', 'hash-of-a-renumbered-away-migration', 'hash-of-0001_b'];
    expect(selectPendingMigrations(journal, ledger)).toEqual([]);
  });

  it('returns pending entries in journal order, carrying when and hash', () => {
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000), entry('0002_c', 2000)];
    expect(selectPendingMigrations(journal, ['hash-of-0001_b'])).toEqual([
      entry('0000_a', 1000),
      entry('0002_c', 2000),
    ]);
  });
});

describe('parseLedgerHashes', () => {
  it('reads the one-hash-per-line output psql -t -A writes', () => {
    expect(parseLedgerHashes('aaa\nbbb\nccc\n')).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('reads an empty ledger as no hashes rather than one blank hash', () => {
    // `printf '%s\n' "$ledger_hashes"` emits a single blank line for an empty
    // ledger. Keeping it would leave one journal entry paired with '' and skipped.
    expect(parseLedgerHashes('')).toEqual([]);
    expect(parseLedgerHashes('\n')).toEqual([]);
    expect(parseLedgerHashes('  \n')).toEqual([]);
  });
});

describe('readJournalMigrations', () => {
  it('hashes each .sql exactly as drizzle and the image build do', () => {
    const folder = writeMigrationsFolder([
      { tag: '0000_a', when: 1000, body: 'CREATE TABLE a (id int);\n' },
      { tag: '0001_b', when: 2000, body: 'CREATE TABLE b (id int);\n' },
    ]);
    const journal = readJournalMigrations(folder);
    expect(journal.map((migration) => migration.tag)).toEqual(['0000_a', '0001_b']);
    expect(journal.map((migration) => migration.when)).toEqual([1000, 2000]);
    // sha256 over the raw file bytes — what drizzle 0.45's readMigrationFiles
    // computes, and what Dockerfile.dev-db writes with sha256sum. A row this
    // applier inserts must be indistinguishable from one drizzle inserted.
    expect(journal[0].hash).toBe(hashMigrationFile(join(folder, '0000_a.sql')));
    expect(journal[0].hash).toMatch(/^[0-9a-f]{64}$/);
    expect(journal[0].hash).not.toBe(journal[1].hash);
  });

  it('gives byte-identical migrations the same hash', () => {
    const folder = writeMigrationsFolder([
      { tag: '0000_a', when: 1000, body: 'SELECT 1;\n' },
      { tag: '0001_b', when: 2000, body: 'SELECT 1;\n' },
    ]);
    const journal = readJournalMigrations(folder);
    expect(journal[0].hash).toBe(journal[1].hash);
  });

  it('refuses a malformed journal rather than selecting a truncated set', () => {
    const folder = mkdtempSync(join(tmpdir(), 'dev-db-pending-bad-'));
    mkdirSync(join(folder, 'meta'), { recursive: true });
    writeFileSync(join(folder, 'meta', '_journal.json'), JSON.stringify({ entries: [{ idx: 0, tag: '0000_a' }] }));
    expect(() => readJournalMigrations(folder)).toThrow(/malformed/);
  });
});

describe('formatPendingMigrations', () => {
  it('writes the tag|when|hash lines dev-db-up.sh reads back with IFS', () => {
    expect(formatPendingMigrations([entry('0000_a', 1000), entry('0001_b', 2000)])).toBe(
      '0000_a|1000|hash-of-0000_a\n0001_b|2000|hash-of-0001_b',
    );
  });

  it('writes nothing for an empty selection', () => {
    expect(formatPendingMigrations([])).toBe('');
  });
});
