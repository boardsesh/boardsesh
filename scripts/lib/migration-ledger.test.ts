import { describe, expect, it } from 'vitest';

import {
  findUnappliedMigrations,
  formatBaselinedGapWarning,
  formatEditedBaselineNote,
  formatMigrationGapError,
  isMigrationJournalGateArmed,
  partitionMissingMigrations,
  planLedgerTimestampRepairs,
  VERIFY_MIGRATION_JOURNAL_ENV,
  type ExpectedMigration,
  type ExpectedMigrationWithWhen,
  type LedgerTimestampRow,
} from './migration-ledger';

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

describe('planLedgerTimestampRepairs', () => {
  // The dev-db image's shape: every row stamped with one build-time value,
  // ~13 orders of magnitude of wall clock above every journal `when`.
  const BUILD_CLOCK = 1_800_000_000_000;

  function journal(...entries: [tag: string, when: number][]): ExpectedMigrationWithWhen[] {
    return entries.map(([tag, when]) => ({ tag, hash: `hash-of-${tag}`, when }));
  }

  function ledgerRows(...rows: [tag: string, createdAt: number][]): LedgerTimestampRow[] {
    return rows.map(([tag, createdAt], index) => ({ id: index + 1, hash: `hash-of-${tag}`, createdAt }));
  }

  it('plans nothing when every row already carries its journal `when`', () => {
    // The no-op case is the important one: this runs on every `vp run db:up`
    // and on a drizzle-managed database there is nothing to write.
    const expected = journal(['0000_a', 1000], ['0001_b', 2000]);
    expect(planLedgerTimestampRepairs(expected, ledgerRows(['0000_a', 1000], ['0001_b', 2000]))).toEqual([]);
  });

  it('rewrites a uniformly build-stamped ledger to the journal when of each entry', () => {
    const expected = journal(['0000_a', 1000], ['0001_b', 2000], ['0002_c', 3000]);
    const rows = ledgerRows(['0000_a', BUILD_CLOCK], ['0001_b', BUILD_CLOCK], ['0002_c', BUILD_CLOCK]);
    expect(planLedgerTimestampRepairs(expected, rows)).toEqual([
      { id: 1, tag: '0000_a', from: BUILD_CLOCK, to: 1000 },
      { id: 2, tag: '0001_b', from: BUILD_CLOCK, to: 2000 },
      { id: 3, tag: '0002_c', from: BUILD_CLOCK, to: 3000 },
    ]);
  });

  it('gives byte-identical migrations distinct `when`s, in id order', () => {
    // A Map<hash, when> would stamp both rows with the first entry's `when`,
    // leaving the second migration's row wrong and the high-water mark short.
    const duplicateHash = 'identical-sql-body';
    const expected: ExpectedMigrationWithWhen[] = [
      { tag: '0000_original', hash: duplicateHash, when: 1000 },
      { tag: '0001_copy', hash: duplicateHash, when: 2000 },
    ];
    const rows: LedgerTimestampRow[] = [
      { id: 7, hash: duplicateHash, createdAt: BUILD_CLOCK },
      { id: 3, hash: duplicateHash, createdAt: BUILD_CLOCK },
    ];
    // Sorted by id, so the row inserted first (id 3) pairs with the first entry.
    expect(planLedgerTimestampRepairs(expected, rows)).toEqual([
      { id: 3, tag: '0000_original', from: BUILD_CLOCK, to: 1000 },
      { id: 7, tag: '0001_copy', from: BUILD_CLOCK, to: 2000 },
    ]);
  });

  it('leaves a ledger row whose hash is in no journal entry alone', () => {
    // Renumber residue. Inventing a timestamp for it would be a guess.
    const expected = journal(['0000_a', 1000]);
    const rows: LedgerTimestampRow[] = [
      { id: 1, hash: 'hash-of-0000_a', createdAt: BUILD_CLOCK },
      { id: 2, hash: 'hash-of-a-renumbered-away-migration', createdAt: BUILD_CLOCK },
    ];
    expect(planLedgerTimestampRepairs(expected, rows)).toEqual([{ id: 1, tag: '0000_a', from: BUILD_CLOCK, to: 1000 }]);
  });

  it('repairs only the rows a short ledger actually has', () => {
    // The normal state right after a new migration lands: the image predates it,
    // so it has no row yet — and must not gain a bogus one from this repair.
    const expected = journal(['0000_a', 1000], ['0001_b', 2000], ['0002_new', 3000]);
    const rows = ledgerRows(['0000_a', BUILD_CLOCK], ['0001_b', BUILD_CLOCK]);
    expect(planLedgerTimestampRepairs(expected, rows).map((repair) => repair.tag)).toEqual(['0000_a', '0001_b']);
  });

  it('repairs a duplicate-hash row only as far as the journal has entries for it', () => {
    // Three rows, two entries: the third is residue of a copy that was removed.
    const duplicateHash = 'identical-sql-body';
    const expected: ExpectedMigrationWithWhen[] = [
      { tag: '0000_original', hash: duplicateHash, when: 1000 },
      { tag: '0001_copy', hash: duplicateHash, when: 2000 },
    ];
    const rows: LedgerTimestampRow[] = [1, 2, 3].map((id) => ({ id, hash: duplicateHash, createdAt: BUILD_CLOCK }));
    expect(planLedgerTimestampRepairs(expected, rows).map((repair) => repair.id)).toEqual([1, 2]);
  });
});

describe('partitionMissingMigrations', () => {
  it('separates the recorded backlog from a new gap', () => {
    const missing = expectedFrom('0000_old_gap', '0187_new_gap');
    const { baselined, unbaselined } = partitionMissingMigrations(missing, expectedFrom('0000_old_gap'));
    expect(baselined.map((migration) => migration.tag)).toEqual(['0000_old_gap']);
    expect(unbaselined.map((migration) => migration.tag)).toEqual(['0187_new_gap']);
  });

  it('keeps the hash on both sides', () => {
    // Baselined tags still print their repair hash — that is how the backlog
    // gets shrunk without re-deriving a sha256 by hand.
    const { baselined } = partitionMissingMigrations(expectedFrom('0000_old_gap'), expectedFrom('0000_old_gap'));
    expect(baselined).toEqual([{ tag: '0000_old_gap', hash: 'hash-of-0000_old_gap' }]);
  });

  it('preserves journal order within each side', () => {
    const missing = expectedFrom('0000_a', '0001_b', '0002_c', '0003_d');
    const { baselined, unbaselined } = partitionMissingMigrations(missing, expectedFrom('0002_c', '0000_a'));
    expect(baselined.map((migration) => migration.tag)).toEqual(['0000_a', '0002_c']);
    expect(unbaselined.map((migration) => migration.tag)).toEqual(['0001_b', '0003_d']);
  });

  it('stops tolerating a baselined migration whose .sql changed', () => {
    // The exemption is (tag, hash). Editing an applied migration gives drizzle a
    // new expected hash while the old `when` keeps it from replaying, so a
    // tag-only exemption would wave through DDL that never ran.
    const missing: ExpectedMigration[] = [{ tag: '0103_thick_puck', hash: 'hash-after-the-edit' }];
    const { baselined, unbaselined, editedSinceBaseline } = partitionMissingMigrations(missing, [
      { tag: '0103_thick_puck', hash: 'hash-when-recorded' },
    ]);
    expect(baselined).toEqual([]);
    expect(unbaselined.map((migration) => migration.tag)).toEqual(['0103_thick_puck']);
    expect(editedSinceBaseline.map((migration) => migration.tag)).toEqual(['0103_thick_puck']);
  });

  it('reports an unbaselined tag as new, not as edited', () => {
    // editedSinceBaseline exists to route the operator to the diff instead of the
    // ledger, so it must not collect gaps the baseline never mentioned.
    const { editedSinceBaseline } = partitionMissingMigrations(
      expectedFrom('0187_new_gap'),
      expectedFrom('0000_old_gap'),
    );
    expect(editedSinceBaseline).toEqual([]);
  });

  it('does not let one tolerated migration excuse another with identical SQL', () => {
    // Byte-identical .sql files share a hash, so a hash-only match would let a new
    // migration inherit a tolerated one's exemption.
    const duplicateHash = 'identical-sql-body';
    const missing: ExpectedMigration[] = [
      { tag: '0000_tolerated', hash: duplicateHash },
      { tag: '0187_new_copy', hash: duplicateHash },
    ];
    const { baselined, unbaselined } = partitionMissingMigrations(missing, [
      { tag: '0000_tolerated', hash: duplicateHash },
    ]);
    expect(baselined.map((migration) => migration.tag)).toEqual(['0000_tolerated']);
    expect(unbaselined.map((migration) => migration.tag)).toEqual(['0187_new_copy']);
  });

  it('leaves everything unbaselined when the baseline is empty', () => {
    const missing = expectedFrom('0000_a', '0001_b');
    const { baselined, unbaselined } = partitionMissingMigrations(missing, []);
    expect(baselined).toEqual([]);
    expect(unbaselined).toEqual(missing);
  });

  it('ignores baseline entries that are not missing', () => {
    // The healthy end state: a repaired entry still listed in the baseline is
    // dead weight, not a failure.
    const { baselined, unbaselined } = partitionMissingMigrations([], expectedFrom('0000_already_repaired'));
    expect(baselined).toEqual([]);
    expect(unbaselined).toEqual([]);
  });
});

describe('formatEditedBaselineNote', () => {
  it('names the tag and says to write a new migration instead', () => {
    const note = formatEditedBaselineNote(['0103_thick_puck']);
    expect(note).toContain('0103_thick_puck');
    expect(note).toContain('no longer hashes to the recorded value');
    expect(note).toContain('never re-runs');
  });
});

describe('formatBaselinedGapWarning', () => {
  it('names every tolerated tag, the date, and where to shrink the list', () => {
    const message = formatBaselinedGapWarning(['0069_mature_morg', '0103_thick_puck'], '2026-07-30', 188);
    expect(message).toContain('0069_mature_morg');
    expect(message).toContain('0103_thick_puck');
    expect(message).toContain('2 of 188');
    expect(message).toContain('2026-07-30');
    expect(message).toContain('scripts/lib/migration-ledger-baseline.ts');
  });

  it('says the deploy is not blocked, so the line is not read as a failure', () => {
    expect(formatBaselinedGapWarning(['0069_mature_morg'], '2026-07-30', 188)).toContain('not blocked');
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

describe('isMigrationJournalGateArmed', () => {
  it('runs the check when nothing is set (#3978)', () => {
    // The flip. Opt-in left the check off on the one machine where a gap is
    // created — the branch author's — and the dev-db image that forced the
    // opt-in now carries every journal entry's ledger row.
    expect(isMigrationJournalGateArmed({})).toBe(true);
  });

  it('keeps running for the literal 1 the workflows already pass', () => {
    // ci.yml, production-deploy.yml and db-migration-renumber.yml all set '1'.
    // Those must stay armed without an edit, or the flip silently disarms the
    // production deploy gate.
    expect(isMigrationJournalGateArmed({ [VERIFY_MIGRATION_JOURNAL_ENV]: '1' })).toBe(true);
  });

  it('only stands down for the exact escape hatch', () => {
    expect(isMigrationJournalGateArmed({ [VERIFY_MIGRATION_JOURNAL_ENV]: '0' })).toBe(false);
    for (const value of ['', 'false', 'no', 'off', '00', ' 0']) {
      expect(isMigrationJournalGateArmed({ [VERIFY_MIGRATION_JOURNAL_ENV]: value })).toBe(true);
    }
  });
});
