import { describe, expect, it, vi } from 'vitest';
import { markScopeDownloadComplete, runMigrations } from '@boardsesh/offline-sync';
import { createTestDatabase } from '@boardsesh/offline-sync/testing';
import { getClimbPlaysLocal } from '../get-climb-plays-local';

describe('downloaded playlist Plays', () => {
  it('returns exact safe counts within completed, readable scopes using bounded SQLite reads', async () => {
    const db = createTestDatabase();
    await runMigrations(db);
    await db.execAsync(`
      INSERT INTO board_climbs (board_type, uuid, layout_id, name, frames, compatible_size_ids, is_listed, is_draft, user_id)
      VALUES ('kilter', 'current', 1, 'current', 'p1r12', '[10]', 1, 0, NULL),
             ('kilter', 'older-download', 1, 'old', 'p1r12', '[10]', 1, 0, NULL),
             ('kilter', 'delisted-alias', 1, 'alias', 'p1r12', '[10]', 0, 0, NULL),
             ('kilter', 'unlisted-own-stats', 1, 'saved', 'p1r12', '[10]', 0, 0, NULL),
             ('kilter', 'own-draft', 1, 'draft', 'p1r12', '[10]', 0, 1, 'viewer'),
             ('kilter', 'other-draft', 1, 'draft', 'p1r12', '[10]', 0, 1, 'other'),
             ('kilter', 'not-covered-size', 1, 'big', 'p1r12', '[12]', 1, 0, NULL),
             ('kilter', 'wrong-layout', 2, 'layout', 'p1r12', '[10]', 1, 0, NULL),
             ('tension', 'tension-only', 1, 'other board', 'p1r12', '[10]', 1, 0, NULL),
             ('spray', 'orphan', 44, 'orphan', 'p1r12', '[0]', 0, 0, NULL);
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, play_count)
      VALUES ('kilter', 'current', 30, 27),
             ('kilter', 'current', 40, 0),
             ('kilter', 'current', 45, 9223372036854775807),
             ('kilter', 'older-download', 40, NULL),
             ('kilter', 'unlisted-own-stats', 40, 2),
             ('kilter', 'own-draft', 40, 12),
             ('kilter', 'other-draft', 40, 3),
             ('kilter', 'not-covered-size', 40, 4),
             ('kilter', 'wrong-layout', 40, 5),
             ('tension', 'current', 40, 99),
             ('spray', 'orphan', 0, 14);
    `);
    await markScopeDownloadComplete(db, 'kilter:1:10');
    await markScopeDownloadComplete(db, 'spray:44:0');

    const coverageReads = vi.spyOn(db, 'getFirstAsync');
    const statsReads = vi.spyOn(db, 'getAllAsync');
    const targets = [
      { climbUuid: 'current', angle: 30 },
      { climbUuid: 'current', angle: 45 },
      ...[
        'current',
        'older-download',
        'delisted-alias',
        'unlisted-own-stats',
        'own-draft',
        'other-draft',
        'not-covered-size',
        'wrong-layout',
      ].map((climbUuid) => ({ climbUuid, angle: 40 })),
      ...Array.from({ length: 205 }, (_, index) => ({ climbUuid: `missing-${index}`, angle: 40 })),
    ];
    const rows = await getClimbPlaysLocal(
      db,
      { boardName: 'kilter', layoutId: 1 },
      targets,
      ['kilter:1:10', 'kilter:1:12', 'tension:1:10'],
      'viewer',
    );
    expect(rows).toEqual(
      expect.arrayContaining([
        { climbUuid: 'current', angle: 30, playCount: 27 },
        { climbUuid: 'current', angle: 40, playCount: 0 },
        { climbUuid: 'current', angle: 45, playCount: null },
        { climbUuid: 'older-download', angle: 40, playCount: null },
        { climbUuid: 'unlisted-own-stats', angle: 40, playCount: 2 },
        { climbUuid: 'own-draft', angle: 40, playCount: 12 },
      ]),
    );
    expect(rows).toHaveLength(6);
    expect(coverageReads).toHaveBeenCalledTimes(2);
    expect(statsReads).toHaveBeenCalledTimes(2);
    expect(
      await getClimbPlaysLocal(
        db,
        { boardName: 'spray', layoutId: 44 },
        [{ climbUuid: 'orphan', angle: 0 }],
        ['spray:44:0'],
        'viewer',
      ),
    ).toEqual([]);
  });
});
