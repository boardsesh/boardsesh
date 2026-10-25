import { afterAll, beforeAll, describe, expect, it, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { ConnectionContext } from '@boardsesh/shared-schema';

// The limiter is not under test; keep everything else in helpers real.
vi.mock('../graphql/resolvers/shared/helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../graphql/resolvers/shared/helpers')>();
  return { ...actual, applyRateLimit: vi.fn(async () => {}) };
});

import { db } from '../db/client';
import { climbQueries } from '../graphql/resolvers/climbs/queries';

const ctx = { isAuthenticated: false, connectionId: 'alias-test-conn' } as unknown as ConnectionContext;

// A queue snapshot can still carry a uuid that was merged into a canonical
// climb. Grades and stats are stored under the canonical uuid only, so the
// play-drawer reads must resolve through board_climb_aliases.
describe('play-drawer grade and stats reads resolve climb aliases', () => {
  const PREFIX = 'grade-alias-test-';
  const canonicalUuid = `${PREFIX}canonical`;
  const aliasUuid = `${PREFIX}old-merged-away`;
  const unknownUuid = `${PREFIX}unknown`;

  beforeAll(async () => {
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, setter_username, name, frames, frames_count, is_draft, is_listed, edge_left, edge_right, edge_bottom, edge_top, created_at)
      VALUES (${canonicalUuid}, 'kilter', 1, 's', 'Canonical Climb', 'p1r12p2r13', 1, false, true, 0, 11, 0, 18, '2024-01-01')
      ON CONFLICT DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO board_climb_aliases (board_type, alias_uuid, canonical_uuid, source)
      VALUES ('kilter', ${aliasUuid}, ${canonicalUuid}, 'test-fixture')
      ON CONFLICT DO NOTHING
    `);
    for (const angle of [40, 45]) {
      await db.execute(sql`
        INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, universal_grade, confidence, ascensionist_count, model_version, coeff_version)
        VALUES ('kilter', ${canonicalUuid}, ${angle}, 20, 20, 'confirmed', 5, 'v1', 'v1')
        ON CONFLICT DO NOTHING
      `);
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count)
        VALUES ('kilter', ${canonicalUuid}, ${angle}, 20, 5)
        ON CONFLICT DO NOTHING
      `);
    }
  });

  afterAll(async () => {
    await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid = ${canonicalUuid}`);
    await db.execute(sql`DELETE FROM board_climb_grades WHERE climb_uuid = ${canonicalUuid}`);
    await db.execute(sql`DELETE FROM board_climb_aliases WHERE alias_uuid = ${aliasUuid}`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = ${canonicalUuid}`);
  });

  it('boardseshGrade returns the canonical grade for an alias uuid', async () => {
    const aliased = await climbQueries.boardseshGrade(
      undefined,
      { boardName: 'kilter', climbUuid: aliasUuid, angle: 40 },
      ctx,
    );
    expect(aliased).not.toBeNull();
    expect(aliased?.universalGrade).toBe(20);

    const direct = await climbQueries.boardseshGrade(
      undefined,
      { boardName: 'kilter', climbUuid: canonicalUuid, angle: 40 },
      ctx,
    );
    expect(direct?.universalGrade).toBe(20);
  });

  it('boardseshGrade stays null for a uuid with no alias and no grade', async () => {
    const result = await climbQueries.boardseshGrade(
      undefined,
      { boardName: 'kilter', climbUuid: unknownUuid, angle: 40 },
      ctx,
    );
    expect(result).toBeNull();
  });

  it('boardseshGradesForAngles returns every angle for an alias uuid', async () => {
    const rows = await climbQueries.boardseshGradesForAngles(
      undefined,
      { boardName: 'kilter', climbUuid: aliasUuid },
      ctx,
    );
    expect(rows.map((row: { angle: number }) => row.angle)).toEqual([40, 45]);
  });

  it('boardseshGradesForAngles is empty for an unknown uuid', async () => {
    const rows = await climbQueries.boardseshGradesForAngles(
      undefined,
      { boardName: 'kilter', climbUuid: unknownUuid },
      ctx,
    );
    expect(rows).toEqual([]);
  });

  it('climbStatsHistory returns the canonical stats for an alias uuid', async () => {
    const rows = await climbQueries.climbStatsHistory(undefined, { boardName: 'kilter', climbUuid: aliasUuid }, ctx);
    expect(rows.map((row: { angle: number }) => row.angle)).toEqual([40, 45]);
  });

  it('climbStatsForAngles returns the canonical stats for an alias uuid', async () => {
    const rows = await climbQueries.climbStatsForAngles(undefined, { boardName: 'kilter', climbUuid: aliasUuid }, ctx);
    expect(rows.map((row: { angle: number }) => row.angle)).toEqual([40, 45]);
  });

  it('climbStatsHistory and climbStatsForAngles are empty for an unknown uuid', async () => {
    const history = await climbQueries.climbStatsHistory(
      undefined,
      { boardName: 'kilter', climbUuid: unknownUuid },
      ctx,
    );
    expect(history).toEqual([]);
    const forAngles = await climbQueries.climbStatsForAngles(
      undefined,
      { boardName: 'kilter', climbUuid: unknownUuid },
      ctx,
    );
    expect(forAngles).toEqual([]);
  });

  it('climbStatsForClimbs returns canonical stats under the requested alias uuid', async () => {
    const authedCtx = { ...ctx, isAuthenticated: true, userId: 'alias-test-user' } as unknown as ConnectionContext;
    const rows = await climbQueries.climbStatsForClimbs(
      undefined,
      { boardName: 'kilter', climbUuids: [aliasUuid, unknownUuid] },
      authedCtx,
    );
    expect(rows.map((row: { climbUuid: string; angle: number }) => [row.climbUuid, row.angle])).toEqual([
      [aliasUuid, 40],
      [aliasUuid, 45],
    ]);
  });

  it('climbStatsForClimbs answers both an alias and its canonical in one batch', async () => {
    const authedCtx = { ...ctx, isAuthenticated: true, userId: 'alias-test-user' } as unknown as ConnectionContext;
    const rows = await climbQueries.climbStatsForClimbs(
      undefined,
      { boardName: 'kilter', climbUuids: [aliasUuid, canonicalUuid] },
      authedCtx,
    );
    // Each requested uuid gets the canonical rows once, keyed by itself, so the
    // client's group-by-climbUuid fills both queue items and never doubles one.
    const pairs = rows.map((row: { climbUuid: string; angle: number }) => [row.climbUuid, row.angle]);
    expect(pairs).toHaveLength(4);
    expect(pairs).toEqual(
      expect.arrayContaining([
        [aliasUuid, 40],
        [aliasUuid, 45],
        [canonicalUuid, 40],
        [canonicalUuid, 45],
      ]),
    );
  });
});
