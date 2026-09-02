import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL, SQLWrapper } from 'drizzle-orm';
import { countGymsWithActivity, rebuildGymActivityStats, type GymActivityStatsDb } from '../activity-stats';

const dialect = new PgDialect();

/**
 * Records the statements a call issues and renders each to real SQL, so the
 * assertions below read the predicate the database would actually run rather
 * than a marker string someone remembered to keep in sync.
 */
function recordingDb(rowsPerStatement: Record<string, unknown>[][] = []) {
  const statements: string[] = [];
  let call = 0;
  const db: GymActivityStatsDb = {
    execute(query: SQLWrapper | string) {
      statements.push(typeof query === 'string' ? query : dialect.sqlToQuery(query as SQL).sql);
      return Promise.resolve(rowsPerStatement[call++] ?? []);
    },
  };
  return { db, statements };
}

// Collapse whitespace so assertions are about the predicate, not the formatting.
const flat = (statement: string) => statement.replace(/\s+/g, ' ');

void describe('rebuildGymActivityStats', () => {
  // THE privacy rule. These numbers feed an admin BD list and, later, a public
  // ranking, so a private or unlisted wall must never contribute to them —
  // unlike the owner-gated `gymStats` resolver, which counts every board linked
  // to the gym because its caller is already allowed to see them.
  void it('counts only public, listed, live boards', async () => {
    const { db, statements } = recordingDb();

    await rebuildGymActivityStats(db);

    const insert = flat(statements[1] ?? '');
    assert.match(insert, /ub\.is_public/, 'private boards must be excluded');
    assert.match(insert, /NOT ub\.is_unlisted/, 'unlisted boards must be excluded');
    assert.match(insert, /ub\.deleted_at IS NULL/, 'soft-deleted boards must be excluded');
    assert.match(insert, /ub\.gym_id IS NOT NULL/);
  });

  // A merged twin must stop reporting numbers the surviving row also reports.
  void it('excludes soft-deleted gyms', async () => {
    const { db, statements } = recordingDb();

    await rebuildGymActivityStats(db);

    assert.match(flat(statements[1] ?? ''), /g\.deleted_at IS NULL/);
  });

  // Wholesale rebuild, not an upsert: a gym that goes quiet has to lose its
  // numbers, and an ON CONFLICT keyed on the rows the scan FOUND leaves the
  // ones it did not find frozen at their last busy value forever.
  void it('deletes every row before inserting, in that order', async () => {
    const { db, statements } = recordingDb();

    await rebuildGymActivityStats(db);

    assert.equal(statements.length, 2);
    assert.match(flat(statements[0] ?? ''), /^DELETE FROM gym_activity_stats$/);
    assert.match(flat(statements[1] ?? ''), /INSERT INTO gym_activity_stats/);
  });

  void it('reports how many rows it wrote', async () => {
    const { db } = recordingDb([[], [{ gym_id: 1 }, { gym_id: 2 }, { gym_id: 3 }]]);

    assert.equal(await rebuildGymActivityStats(db), 3);
  });

  // `is_claimed` distinguishes a gym the venue took ownership of from one the
  // location sync imported and parked on the system owner — the single most
  // load-bearing field on a BD list.
  void it('derives is_claimed from the system owner id', async () => {
    const { db, statements } = recordingDb();

    await rebuildGymActivityStats(db);

    assert.match(flat(statements[1] ?? ''), /g\.owner_id <> '00000000-0000-0000-0000-000000000000'/);
  });
});

void describe('countGymsWithActivity', () => {
  // The shrink guard compares this against the stored count, so it has to apply
  // the SAME board predicate the rebuild does — a looser count here would let a
  // regressed rebuild past the guard that exists to catch it.
  void it('applies the same board predicate as the rebuild', async () => {
    const counter = recordingDb([[{ gym_count: 710 }]]);
    const rebuilder = recordingDb();

    await countGymsWithActivity(counter.db);
    await rebuildGymActivityStats(rebuilder.db);

    for (const clause of [/ub\.is_public/, /NOT ub\.is_unlisted/, /ub\.deleted_at IS NULL/]) {
      assert.match(flat(counter.statements[0] ?? ''), clause);
      assert.match(flat(rebuilder.statements[1] ?? ''), clause);
    }
  });

  void it('writes nothing', async () => {
    const { db, statements } = recordingDb([[{ gym_count: 710 }]]);

    await countGymsWithActivity(db);

    assert.equal(statements.length, 1);
    assert.doesNotMatch(flat(statements[0] ?? ''), /INSERT|UPDATE|DELETE/);
  });

  void it('returns the counted gyms', async () => {
    const { db } = recordingDb([[{ gym_count: 710 }]]);

    assert.equal(await countGymsWithActivity(db), 710);
  });

  void it('reads zero when the scan finds nothing', async () => {
    const { db } = recordingDb([[]]);

    assert.equal(await countGymsWithActivity(db), 0);
  });
});
