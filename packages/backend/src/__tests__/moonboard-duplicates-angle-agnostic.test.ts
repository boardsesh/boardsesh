import { beforeAll, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import type { MoonBoardHoldsInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  buildMoonBoardClimbHoldRows,
  encodeMoonBoardHoldsToFrames,
  findMoonBoardDuplicateMatches,
} from '../graphql/resolvers/climbs/moonboard-duplicates';

// The catalog importer writes ONE angle-agnostic climb row per MoonBoard
// problem (board_climbs.angle IS NULL) plus one stats row per graded angle, so
// the duplicate gate has to treat those rows as candidates at every angle.
// These run against the real test database rather than a query stub: the whole
// bug was in the WHERE clause, which a stubbed db.execute can't disprove.

const LAYOUT_ID = 2;

const CATALOG_HOLDS: MoonBoardHoldsInput = { start: ['A1'], hand: ['B2'], finish: ['C3'] };
const PER_ANGLE_HOLDS: MoonBoardHoldsInput = { start: ['A2'], hand: ['B3'], finish: ['C4'] };
const LEGACY_FRAMES_HOLDS: MoonBoardHoldsInput = { start: ['A3'], hand: ['B4'], finish: ['C5'] };
const UNSET_HOLDS: MoonBoardHoldsInput = { start: ['D1'], hand: ['E2'], finish: ['F3'] };

const CATALOG_UUID = 'moonboard-angle-agnostic-catalog';
const PER_ANGLE_UUID = 'moonboard-angle-agnostic-legacy-40';
const LEGACY_FRAMES_UUID = 'moonboard-angle-agnostic-frames-only';

async function insertClimb(args: { uuid: string; angle: number | null; name: string; holds: MoonBoardHoldsInput }) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, name, angle, frames, is_listed, is_draft, created_at)
    VALUES (
      ${args.uuid}, 'moonboard', ${LAYOUT_ID}, ${args.name}, ${args.angle},
      ${encodeMoonBoardHoldsToFrames(args.holds)}, true, false, '2026-01-01'
    )
  `);
}

async function insertHoldRows(uuid: string, holds: MoonBoardHoldsInput) {
  for (const row of buildMoonBoardClimbHoldRows(uuid, holds)) {
    await db.execute(sql`
      INSERT INTO board_climb_holds (board_type, climb_uuid, hold_id, frame_number, hold_state)
      VALUES ('moonboard', ${row.climbUuid}, ${row.holdId}, ${row.frameNumber}, ${row.holdState})
    `);
  }
}

async function insertStats(uuid: string, angle: number, ascensionistCount: number) {
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count)
    VALUES ('moonboard', ${uuid}, ${angle}, 20, ${ascensionistCount})
  `);
}

async function matchFor(angle: number, holds: MoonBoardHoldsInput) {
  const [match] = await findMoonBoardDuplicateMatches(LAYOUT_ID, angle, [{ clientKey: 'candidate', holds }]);
  return match;
}

describe('MoonBoard duplicate gate with angle-agnostic catalog climbs', () => {
  beforeAll(async () => {
    // Catalog shape: angle-agnostic climb row, hold rows, one stats row per
    // graded angle.
    await insertClimb({ uuid: CATALOG_UUID, angle: null, name: 'Catalog Problem', holds: CATALOG_HOLDS });
    await insertHoldRows(CATALOG_UUID, CATALOG_HOLDS);
    await insertStats(CATALOG_UUID, 25, 3);
    await insertStats(CATALOG_UUID, 40, 12);

    // Pre-rewrite shape: one row per angle, still angle-scoped.
    await insertClimb({ uuid: PER_ANGLE_UUID, angle: 40, name: 'Per Angle Problem', holds: PER_ANGLE_HOLDS });
    await insertHoldRows(PER_ANGLE_UUID, PER_ANGLE_HOLDS);
    await insertStats(PER_ANGLE_UUID, 40, 7);

    // Angle-agnostic row that predates board_climb_holds — matched off frames.
    await insertClimb({
      uuid: LEGACY_FRAMES_UUID,
      angle: null,
      name: 'Frames Only Problem',
      holds: LEGACY_FRAMES_HOLDS,
    });
  });

  it.each([25, 40])('matches an angle-agnostic catalog climb at %i°', async (angle) => {
    expect(await matchFor(angle, CATALOG_HOLDS)).toMatchObject({
      exists: true,
      existingClimbUuid: CATALOG_UUID,
      existingClimbName: 'Catalog Problem',
    });
  });

  it.each([25, 40])('matches an angle-agnostic climb with no hold rows at %i° (frames fallback)', async (angle) => {
    expect(await matchFor(angle, LEGACY_FRAMES_HOLDS)).toMatchObject({
      exists: true,
      existingClimbUuid: LEGACY_FRAMES_UUID,
    });
  });

  it('keeps per-angle rows scoped to their own angle', async () => {
    expect(await matchFor(40, PER_ANGLE_HOLDS)).toMatchObject({ exists: true, existingClimbUuid: PER_ANGLE_UUID });
    expect(await matchFor(25, PER_ANGLE_HOLDS)).toMatchObject({ exists: false, existingClimbUuid: null });
  });

  it('still reports no duplicate for holds nobody has set', async () => {
    expect(await matchFor(40, UNSET_HOLDS)).toMatchObject({ exists: false, existingClimbUuid: null });
  });
});
