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
  it('selects an appended migration whose when is below the newest applied entry (#3979)', () => {
    // The safe form of the bug: the new entry is journaled after the applied
    // prefix even though its `when` is older than the prefix's high-water mark.
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000), entry('0002_stale_when', 2000)];
    const pending = selectPendingMigrations(journal, ['hash-of-0000_a', 'hash-of-0001_b']);
    expect(pending.map((migration) => migration.tag)).toEqual(['0002_stale_when']);
  });

  it('selects nothing when every journal hash has a ledger row', () => {
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000)];
    expect(selectPendingMigrations(journal, ['hash-of-0000_a', 'hash-of-0001_b'])).toEqual([]);
  });

  it('refuses an empty existing ledger instead of replaying historical SQL', () => {
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000)];
    expect(() => selectPendingMigrations(journal, [])).toThrow(/empty migration ledger.*No migration SQL was executed/);
  });

  it('refuses an ambiguous boundary between byte-identical applied and pending migrations', () => {
    // A hash-only ledger cannot prove which copy was applied if it is missing one
    // of two byte-identical entries. Replaying the pending copy could run already-
    // applied SQL, so this boundary needs owner reconciliation.
    const shared = 'sha-of-identical-bodies';
    const journal = [entry('0000_a', 1000, shared), entry('0001_b', 2000, shared)];
    expect(() => selectPendingMigrations(journal, [shared])).toThrow(/position in history cannot be verified/);
    expect(selectPendingMigrations(journal, [shared, shared])).toEqual([]);
  });

  it('refuses unknown ledger hashes instead of guessing at migration history', () => {
    const journal = [entry('0000_a', 1000), entry('0001_b', 2000)];
    const ledger = ['hash-of-0000_a', 'hash-of-a-renumbered-away-migration'];
    expect(() => selectPendingMigrations(journal, ledger)).toThrow(/unknown hash.*No migration SQL was executed/);
  });

  it('refuses a missing historical entry when later journal rows are already applied', () => {
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000), entry('0002_c', 2000)];
    const ledger = ['hash-of-0000_a', 'hash-of-0002_c'];
    expect(() => selectPendingMigrations(journal, ledger)).toThrow(
      /historical gap before 0001_b.*later journal entry 0002_c.*No migration SQL was executed/,
    );
  });

  it('refuses excess duplicate rows even when the hash is known', () => {
    const journal = [entry('0000_a', 1000), entry('0001_b', 2000)];
    expect(() => selectPendingMigrations(journal, ['hash-of-0000_a', 'hash-of-0001_b', 'hash-of-0001_b'])).toThrow(
      /excess hash.*No migration SQL was executed/,
    );
  });

  it('returns the safe suffix in journal order with each when and hash', () => {
    const journal = [entry('0000_a', 1000), entry('0001_b', 3000), entry('0002_c', 2000)];
    expect(selectPendingMigrations(journal, ['hash-of-0000_a', 'hash-of-0001_b'])).toEqual([entry('0002_c', 2000)]);
  });
});

describe('parseLedgerHashes', () => {
  it('reads the one-hash-per-line output psql -t -A writes', () => {
    expect(parseLedgerHashes('aaa\nbbb\nccc\n')).toEqual(['aaa', 'bbb', 'ccc']);
  });

  it('reads an empty ledger as no hashes rather than one blank hash', () => {
    // `printf '%s\n' "$ledger_hashes"` emits a single blank line for an empty
    // ledger. The selector rejects this state unless history has been reconciled.
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
