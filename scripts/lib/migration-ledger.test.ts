import { describe, expect, it } from 'vitest';

import { findUnappliedMigrations, formatMigrationGapError, type ExpectedMigration } from './migration-ledger';

function expectedFrom(...tags: string[]): ExpectedMigration[] {
  return tags.map((tag) => ({ tag, hash: `hash-of-${tag}` }));
}

function hashesFor(...tags: string[]): string[] {
  return tags.map((tag) => `hash-of-${tag}`);
}

describe('findUnappliedMigrations', () => {
  it('returns nothing when every journal hash has a ledger row', () => {
    // The false-positive case: a check that fails closed on a healthy database
    // blocks every production deploy, which is worse than the bug it catches.
    const expected = expectedFrom('0000_a', '0001_b', '0002_c');
    expect(findUnappliedMigrations(expected, hashesFor('0000_a', '0001_b', '0002_c'))).toEqual([]);
  });

  it('names the migration whose ledger row is missing from the middle', () => {
    // #2933 itself: 0129_numerous_star_brand applied cleanly in the journal but
    // its `when` sat below the ledger high-water mark, so drizzle skipped it and
    // the latest-only assertion in migrate.ts stayed green.
    const expected = expectedFrom('0000_a', '0001_b', '0002_c');
    expect(findUnappliedMigrations(expected, hashesFor('0000_a', '0002_c'))).toEqual(['0001_b']);
  });

  it('reports missing tags in journal order', () => {
    const expected = expectedFrom('0000_a', '0001_b', '0002_c', '0003_d');
    expect(findUnappliedMigrations(expected, hashesFor('0002_c'))).toEqual(['0000_a', '0001_b', '0003_d']);
  });

  it('ignores ledger rows whose hash matches no journal entry', () => {
    // Renumbering legitimately leaves orphan rows behind — the local dev DB has
    // two. Failing on them would block deploys for benign residue.
    const expected = expectedFrom('0000_a', '0001_b');
    const ledger = [...hashesFor('0000_a', '0001_b'), 'hash-of-a-renumbered-away-migration'];
    expect(findUnappliedMigrations(expected, ledger)).toEqual([]);
  });

  it('requires one ledger row per entry when two migrations share a hash', () => {
    // Byte-identical .sql files hash identically. A Set-based implementation
    // would call the second one applied off the first one's row.
    const duplicateHash = 'identical-sql-body';
    const expected: ExpectedMigration[] = [
      { tag: '0000_original', hash: duplicateHash },
      { tag: '0001_copy', hash: duplicateHash },
    ];
    expect(findUnappliedMigrations(expected, [duplicateHash])).toEqual(['0001_copy']);
    expect(findUnappliedMigrations(expected, [duplicateHash, duplicateHash])).toEqual([]);
  });

  it('returns every tag against an empty ledger', () => {
    const expected = expectedFrom('0000_a', '0001_b');
    expect(findUnappliedMigrations(expected, [])).toEqual(['0000_a', '0001_b']);
  });

  it('returns nothing for an empty journal', () => {
    expect(findUnappliedMigrations([], hashesFor('0000_a'))).toEqual([]);
  });
});

describe('formatMigrationGapError', () => {
  it('names every missing tag and both counts', () => {
    const message = formatMigrationGapError(['0129_numerous_star_brand', '0130_lucky_star'], 131, 125);
    expect(message).toContain('0129_numerous_star_brand');
    expect(message).toContain('0130_lucky_star');
    expect(message).toContain('2 of 131');
    expect(message).toContain('125 rows present');
  });

  it('reads correctly for a single missing migration', () => {
    const message = formatMigrationGapError(['0129_numerous_star_brand'], 131, 130);
    expect(message).toContain('1 of 131 journal migration has no row');
  });
});
