import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { applyClimbOwnerAssignments, selectClimbOwnerAssignments } from '@boardsesh/db/queries';
import type { BoardPresenceStats, ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { climbFieldResolvers } from '../graphql/resolvers/climbs/field-resolvers';
import { climbQueries } from '../graphql/resolvers/climbs/queries';
import { favoriteClimbsQuery } from '../graphql/resolvers/favorites/favorite-climbs-query';
import { playlistQueries } from '../graphql/resolvers/playlists/queries';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { analyzeGradeOutlier } from '../graphql/resolvers/social/proposals/grade-analysis';
import {
  canReadClimbContent,
  redactBoardClimbs,
  redactBoardStats,
  redactQueueClimb,
} from '../services/board-session-privacy';
import { resetAllRateLimits } from '../utils/rate-limiter';

// ---------------------------------------------------------------------------
// The draft rule on the read paths outside the board sync (real Postgres).
//
// A draft climb, and anything read from it, is returned to its owner and to
// nobody else; a draft with no owner to no one. The account and item audience
// alone does not say that: it shows a public account's draft to everyone, and a
// draft nobody owns to everyone. Each path below reads a climb by a reference
// the caller supplies or persisted (a uuid, a playlist, a favourite), which is
// how a draft used to come back to someone who is not its owner.
//
// Three drafts on one layout, and a published climb beside them that every
// viewer keeps reading, so each test also shows the rule moved nothing else.
// ---------------------------------------------------------------------------

const describeWithDatabase = process.env.SKIP_TEST_INFRA === '1' ? describe.skip : describe;

const BOARD = 'kilter';
const LAYOUT_ID = 99_782;
const ANGLE = 40;
const STATS_ANGLES = [ANGLE, ANGLE + 5, ANGLE + 10];

/** A public account: its published climbs are everyone's to read. */
const DRAFT_OWNER = 'draft-read-owner';
const STRANGER = 'draft-read-stranger';
/**
 * Linked, with a credential, to the manufacturer account that set the ownerless
 * draft. Not its owner: it has none until the owner backfill runs.
 */
const LINKED_SETTER_ACCOUNT = 'draft-read-linked-setter';
const USERS = [DRAFT_OWNER, STRANGER, LINKED_SETTER_ACCOUNT];
const SETTER_ID = 660_001;

const PUBLISHED = 'draft-read-published';
const OWNED_DRAFT = 'draft-read-owned';
const OWNERLESS_DRAFT = 'draft-read-ownerless';
const DELETED_ACCOUNT_DRAFT = 'draft-read-deleted-account';
const DRAFTS = [OWNED_DRAFT, OWNERLESS_DRAFT, DELETED_ACCOUNT_DRAFT];
/** Published and listed, with a draft flag that was never set. NULL is not a draft. */
const NULL_DRAFT_FLAG = 'draft-read-null-flag';
const ALL_CLIMBS = [PUBLISHED, ...DRAFTS];

const PLAYLIST_UUID = 'draft-read-playlist';
/**
 * The board a presence read is for. No fixture send names a climber, so no
 * identity is looked up on it; the climb rule is what these cases read.
 */
const PRESENCE_BOARD_ID = 99_782;

const ctxFor = (userId: string): ConnectionContext =>
  ({ userId, isAuthenticated: true, connectionId: `draft-read-${userId}` }) as ConnectionContext;
const anonymous = { isAuthenticated: false, userId: undefined, connectionId: 'draft-read-anon' } as ConnectionContext;

const VIEWERS: Array<[string, ConnectionContext, string | null]> = [
  ['the owner', ctxFor(DRAFT_OWNER), DRAFT_OWNER],
  ['a stranger', ctxFor(STRANGER), STRANGER],
  ['the account linked to the ownerless draft’s setter', ctxFor(LINKED_SETTER_ACCOUNT), LINKED_SETTER_ACCOUNT],
  ['an anonymous caller', anonymous, null],
];

/** The climbs of the fixture this viewer may be handed: everything published, and their own draft. */
const readableBy = (viewerId: string | null) => (viewerId === DRAFT_OWNER ? [PUBLISHED, OWNED_DRAFT] : [PUBLISHED]);

const boardInput = { boardName: BOARD, layoutId: LAYOUT_ID, sizeId: 1, setIds: '1', angle: ANGLE };

async function removeFixtures(): Promise<void> {
  await db.execute(sql`DELETE FROM playlists WHERE uuid = ${PLAYLIST_UUID}`);
  await db.execute(sql`DELETE FROM user_favorites WHERE climb_uuid LIKE 'draft-read-%'`);
  await db.execute(sql`DELETE FROM board_climb_grades WHERE climb_uuid LIKE 'draft-read-%'`);
  await db.execute(sql`DELETE FROM board_climb_stats WHERE climb_uuid LIKE 'draft-read-%'`);
  await db.execute(sql`DELETE FROM board_climbs WHERE uuid LIKE 'draft-read-%'`);
  await db.execute(sql`DELETE FROM users WHERE id IN (${sql.join(USERS, sql`, `)})`);
}

describeWithDatabase('draft climbs on the read paths outside sync (real DB)', () => {
  beforeAll(async () => {
    await removeFixtures();
    for (const userId of USERS) {
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${userId}, ${userId}, ${`${userId}@example.test`})`,
      );
    }
    await db.execute(sql`
      INSERT INTO user_board_mappings (user_id, board_type, board_user_id)
      VALUES (${LINKED_SETTER_ACCOUNT}, ${BOARD}, ${SETTER_ID})
    `);
    // The credential is what proves the account signed in to that setter, and
    // what the owner backfill accepts by default.
    await db.execute(sql`
      INSERT INTO aurora_credentials (user_id, board_type, aurora_user_id)
      VALUES (${LINKED_SETTER_ACCOUNT}, ${BOARD}, ${SETTER_ID})
    `);

    const climbs: Array<{ uuid: string; userId: string | null; isDraft: boolean; authored?: boolean }> = [
      { uuid: PUBLISHED, userId: DRAFT_OWNER, isDraft: false },
      { uuid: OWNED_DRAFT, userId: DRAFT_OWNER, isDraft: true },
      { uuid: OWNERLESS_DRAFT, userId: null, isDraft: true },
      { uuid: DELETED_ACCOUNT_DRAFT, userId: null, isDraft: true, authored: true },
    ];
    for (const climb of climbs) {
      await db.execute(sql`
        INSERT INTO board_climbs
          (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed, user_id, setter_id,
           is_boardsesh_authored, compatible_size_ids, required_set_ids)
        VALUES
          (${climb.uuid}, ${BOARD}, ${LAYOUT_ID}, ${`Name of ${climb.uuid}`}, 'p1r12p2r13', 1, ${climb.isDraft},
           ${!climb.isDraft}, ${climb.userId}, ${climb.uuid === OWNERLESS_DRAFT ? SETTER_ID : null},
           ${climb.authored ?? false}, '{1}'::int[], '{1}'::int[])
      `);
      // Three angles, graded apart at the browsed one: the outlier analysis
      // needs two neighbours with enough ascents, and then has a finding.
      for (const angle of STATS_ANGLES) {
        await db.execute(sql`
          INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, ascensionist_count, fa_username)
          VALUES (${BOARD}, ${climb.uuid}, ${angle}, ${angle === ANGLE ? 26 : 20}, 12, 'First ascensionist')
        `);
      }
      await db.execute(sql`
        INSERT INTO board_climb_grades
          (board_type, climb_uuid, angle, local_grade, universal_grade, grade_low, grade_high, confidence,
           ascensionist_count, model_version, coeff_version)
        VALUES (${BOARD}, ${climb.uuid}, ${ANGLE}, 20, 21, 19, 23, 'confirmed', 12, 'draft-read', 'draft-read')
      `);
    }

    // Outside ALL_CLIMBS on purpose: the list and playlist cases above are
    // written against four climbs, and this one is only read in a live session.
    await db.execute(sql`
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, frames, frames_count, is_draft, is_listed, compatible_size_ids,
         required_set_ids)
      VALUES
        (${NULL_DRAFT_FLAG}, ${BOARD}, ${LAYOUT_ID}, ${`Name of ${NULL_DRAFT_FLAG}`}, 'p1r12p2r13', 1, NULL, true,
         '{1}'::int[], '{1}'::int[])
    `);

    // A public playlist that names every climb, drafts included: anyone can put
    // a uuid they hold on a playlist of their own.
    await db.execute(sql`
      INSERT INTO playlists (uuid, board_type, layout_id, name, is_public)
      VALUES (${PLAYLIST_UUID}, ${BOARD}, ${LAYOUT_ID}, 'Draft read playlist', true)
    `);
    await db.execute(sql`
      INSERT INTO playlist_ownership (playlist_id, user_id, role)
      SELECT id, ${STRANGER}, 'owner' FROM playlists WHERE uuid = ${PLAYLIST_UUID}
    `);
    for (const [position, uuid] of ALL_CLIMBS.entries()) {
      await db.execute(sql`
        INSERT INTO playlist_climbs (playlist_id, climb_uuid, angle, position)
        SELECT id, ${uuid}, ${ANGLE}, ${position} FROM playlists WHERE uuid = ${PLAYLIST_UUID}
      `);
    }
    // And every account has favourited every one of them.
    for (const userId of USERS) {
      for (const uuid of ALL_CLIMBS) {
        await db.execute(sql`
          INSERT INTO user_favorites (user_id, board_name, climb_uuid, angle) VALUES (${userId}, ${BOARD}, ${uuid}, ${ANGLE})
        `);
      }
    }
  });
  afterAll(removeFixtures);
  beforeEach(() => resetAllRateLimits());

  describe.each(VIEWERS)('for %s', (_label, ctx, viewerId) => {
    const readable = readableBy(viewerId);

    it('opens a climb by uuid only when it is published or the caller’s own draft', async () => {
      for (const climbUuid of ALL_CLIMBS) {
        const climb = await climbQueries.climb({}, { ...boardInput, climbUuid }, ctx);
        expect(climb?.uuid ?? null).toBe(readable.includes(climbUuid) ? climbUuid : null);
      }
    });

    it('reads per-angle stats by uuid only for those climbs', async () => {
      for (const climbUuid of ALL_CLIMBS) {
        const expectedAngles = readable.includes(climbUuid) ? STATS_ANGLES : [];
        const forAngles = await climbQueries.climbStatsForAngles(undefined, { boardName: BOARD, climbUuid }, ctx);
        expect(forAngles.map((row) => row.angle)).toEqual(expectedAngles);
        const history = await climbQueries.climbStatsHistory(undefined, { boardName: BOARD, climbUuid }, ctx);
        expect(history.map((row) => row.angle)).toEqual(expectedAngles);
      }
    });

    it('reads Boardsesh grades by uuid only for those climbs', async () => {
      for (const climbUuid of ALL_CLIMBS) {
        const grades = await climbQueries.boardseshGradesForAngles(undefined, { boardName: BOARD, climbUuid }, ctx);
        expect(grades.length > 0).toBe(readable.includes(climbUuid));
      }
    });

    it('reports a grade outlier only for those climbs', async () => {
      for (const climbUuid of ALL_CLIMBS) {
        const analysis = await analyzeGradeOutlier(climbUuid, BOARD, ANGLE, viewerId);
        // The finding carries the climb's grade at the angle and at its neighbours.
        expect(analysis).toEqual(
          readable.includes(climbUuid)
            ? { isOutlier: true, currentGrade: 26, neighborAverage: 20, neighborCount: 2, gradeDifference: 6 }
            : null,
        );
      }
    });

    it('lists a public playlist without anyone else’s draft, and counts it the same way', async () => {
      const page = await playlistQueries.playlistClimbs(
        null,
        { input: { playlistId: PLAYLIST_UUID, boardName: BOARD, layoutId: LAYOUT_ID, sizeId: 1, angle: ANGLE } },
        ctx,
      );
      expect(page.climbs.map((climb) => climb.uuid).sort()).toEqual([...readable].sort());
      expect(page.totalCount).toBe(readable.length);

      // The all-boards form of the same playlist takes the other query path.
      const allBoards = await playlistQueries.playlistClimbs(null, { input: { playlistId: PLAYLIST_UUID } }, ctx);
      expect(allBoards.climbs.map((climb) => climb.uuid).sort()).toEqual([...readable].sort());
      expect(allBoards.totalCount).toBe(readable.length);
    });
  });

  describe.each(VIEWERS.filter(([, , viewerId]) => viewerId !== null))('for %s, signed in', (_label, ctx, viewerId) => {
    const readable = readableBy(viewerId);

    it('reads back a favourite only when it is published or the caller’s own draft', async () => {
      const page = await favoriteClimbsQuery.userFavoriteClimbs(undefined, { input: boardInput }, ctx);
      expect(page.climbs.map((climb) => climb.uuid).sort()).toEqual([...readable].sort());
      expect(page.totalCount).toBe(readable.length);
    });

    it('reads stats for a batch of uuids only for those climbs', async () => {
      const rows = await climbQueries.climbStatsForClimbs(undefined, { boardName: BOARD, climbUuids: ALL_CLIMBS }, ctx);
      expect([...new Set(rows.map((row) => row.climbUuid))].sort()).toEqual([...readable].sort());
    });

    it('lists only the caller’s own drafts, by the owner on the row and not by a linked setter', async () => {
      const search = await climbQueries.searchClimbs(null, { input: { ...boardInput, onlyDrafts: true } }, ctx);
      const drafts = await climbFieldResolvers.climbs(search as Parameters<typeof climbFieldResolvers.climbs>[0]);
      // The linked account's manufacturer id is the ownerless draft's setter id.
      // That is not ownership: the draft has no owner, so it is listed to no one.
      expect(drafts.map((climb) => climb.uuid)).toEqual(viewerId === DRAFT_OWNER ? [OWNED_DRAFT] : []);
    });
  });

  it('never returns a draft from the published search, to its owner either', async () => {
    for (const [, ctx] of VIEWERS) {
      const search = await climbQueries.searchClimbs(null, { input: boardInput }, ctx);
      const climbs = await climbFieldResolvers.climbs(search as Parameters<typeof climbFieldResolvers.climbs>[0]);
      expect(climbs.map((climb) => climb.uuid)).toEqual([PUBLISHED]);
    }
  });

  describe('the hardest send on a board', () => {
    const statsWithHardest = (climbUuid: string, climbOwnerId: string | null): BoardPresenceStats => ({
      climbsSentCount: 3,
      distinctClimbersCount: 2,
      hardestGrade: 'V8',
      hardestSend: { climbUuid, grade: 'V8', climbOwnerId, sentByUserId: null, sentAt: '2026-05-01T00:00:00.000Z' },
    });

    it('is not named when it is a draft the viewer does not own, and every aggregate stays', async () => {
      for (const [, , viewerId] of VIEWERS) {
        for (const [climbUuid, climbOwnerId] of [
          [PUBLISHED, DRAFT_OWNER],
          [OWNED_DRAFT, DRAFT_OWNER],
          [OWNERLESS_DRAFT, null],
          [DELETED_ACCOUNT_DRAFT, null],
        ] as const) {
          const stats = statsWithHardest(climbUuid, climbOwnerId);
          const redacted = await redactBoardStats(stats, viewerId, PRESENCE_BOARD_ID);
          expect(redacted.hardestSend?.climbUuid ?? null).toBe(
            readableBy(viewerId).includes(climbUuid) ? climbUuid : null,
          );
          expect(redacted).toMatchObject({ climbsSentCount: 3, distinctClimbersCount: 2, hardestGrade: 'V8' });
        }
      }
    });
  });

  // The live-session reads use the publication test the board sync uses. A
  // climb every device holds must not come back blank in a queue, and that
  // includes a published climb whose draft flag is NULL: `is_draft = false`
  // reads NULL as a draft, `IS NOT TRUE` does not.
  describe('a climb in a live session', () => {
    const queueClimb = (uuid: string) => ({
      uuid,
      name: `Name of ${uuid}`,
      setter_username: 'setter',
      frames: 'p1r12p2r13',
      angle: ANGLE,
      ascensionist_count: 12,
      difficulty: 'V5',
      quality_average: '3',
      stars: 3,
      difficulty_error: '0',
      benchmark_difficulty: null,
    });

    it('is readable by everyone when it is published, a NULL draft flag included, and a draft only by its owner', async () => {
      for (const [, , viewerId] of VIEWERS) {
        const readable = [...readableBy(viewerId), NULL_DRAFT_FLAG];
        for (const uuid of [...ALL_CLIMBS, NULL_DRAFT_FLAG]) {
          expect(await canReadClimbContent(uuid, viewerId), `${uuid} for ${String(viewerId)}`).toBe(
            readable.includes(uuid),
          );
        }
      }
    });

    it('keeps the details of a published climb with a NULL draft flag in the queue, and blanks a draft', async () => {
      for (const [, , viewerId] of VIEWERS) {
        expect((await redactQueueClimb(queueClimb(NULL_DRAFT_FLAG), viewerId)).name).toBe(`Name of ${NULL_DRAFT_FLAG}`);
        expect((await redactQueueClimb(queueClimb(OWNERLESS_DRAFT), viewerId)).name).toBe('');
      }
    });

    it('keeps it named in the board’s history too', async () => {
      const history = [NULL_DRAFT_FLAG, PUBLISHED, OWNERLESS_DRAFT].map((climbUuid, index) => ({
        climbUuid,
        name: `Name of ${climbUuid}`,
        frames: 'p1r12p2r13',
        sentByUserId: null,
        sentAt: '2026-05-01T00:00:00.000Z',
        seq: index + 1,
      }));
      // These rows contain no sender identity: this check covers climb details.
      const redacted = await redactBoardClimbs(history, STRANGER, PRESENCE_BOARD_ID);
      expect(redacted.map((climb) => climb.name)).toEqual([`Name of ${NULL_DRAFT_FLAG}`, `Name of ${PUBLISHED}`, null]);
    });
  });

  // The cases above are the state between this release's deploy and the owner
  // backfill: an imported draft that never got an owner is read by no one, its
  // setter's linked account included. The release runbook runs the backfill
  // before that deploy (it needs nothing from this release), so a setter never
  // sees that state. This is what the backfill gives back, on the three paths a
  // setter reads their own drafts through: the drafts list, the climb by link,
  // and the board sync's pull with no audience, which every shipped app sends.
  describe('after the owner backfill', () => {
    const syncedClimbUuids = async (ctx: ConnectionContext) => {
      const page = await syncQueries.syncClimbs(
        undefined,
        { boardType: BOARD, layoutId: LAYOUT_ID, cursor: null, limit: 50 },
        ctx,
      );
      return page.documents.map((document) => String((document as { uuid: unknown }).uuid)).sort();
    };
    const listedDrafts = async (ctx: ConnectionContext) => {
      const search = await climbQueries.searchClimbs(null, { input: { ...boardInput, onlyDrafts: true } }, ctx);
      const drafts = await climbFieldResolvers.climbs(search as Parameters<typeof climbFieldResolvers.climbs>[0]);
      return drafts.map((climb) => climb.uuid);
    };

    it('returns the linked setter their imported draft everywhere they read it, and nobody else', async () => {
      // Before: nobody, the linked setter included.
      expect(await listedDrafts(ctxFor(LINKED_SETTER_ACCOUNT))).toEqual([]);
      expect(await syncedClimbUuids(ctxFor(LINKED_SETTER_ACCOUNT))).not.toContain(OWNERLESS_DRAFT);

      // The backfill's own match and write, kept to this fixture's climb so no
      // other file's rows are touched. The match is what decides: exactly one
      // account links the draft's setter on this board.
      const assignments = (
        await selectClimbOwnerAssignments(db, { afterUuid: null, limit: 500, boardType: BOARD, kinds: ['drafts'] })
      ).filter((assignment) => ALL_CLIMBS.includes(assignment.uuid));
      expect(assignments).toEqual([{ uuid: OWNERLESS_DRAFT, userId: LINKED_SETTER_ACCOUNT }]);
      try {
        expect(await applyClimbOwnerAssignments(db, assignments)).toBe(1);

        expect(await listedDrafts(ctxFor(LINKED_SETTER_ACCOUNT))).toEqual([OWNERLESS_DRAFT]);
        const opened = await climbQueries.climb(
          {},
          { ...boardInput, climbUuid: OWNERLESS_DRAFT },
          ctxFor(LINKED_SETTER_ACCOUNT),
        );
        expect(opened?.uuid).toBe(OWNERLESS_DRAFT);
        expect(await syncedClimbUuids(ctxFor(LINKED_SETTER_ACCOUNT))).toContain(OWNERLESS_DRAFT);

        for (const viewerId of [DRAFT_OWNER, STRANGER]) {
          expect(await listedDrafts(ctxFor(viewerId))).not.toContain(OWNERLESS_DRAFT);
          expect(
            await climbQueries.climb({}, { ...boardInput, climbUuid: OWNERLESS_DRAFT }, ctxFor(viewerId)),
          ).toBeNull();
          expect(await syncedClimbUuids(ctxFor(viewerId))).not.toContain(OWNERLESS_DRAFT);
        }
      } finally {
        await db.execute(sql`UPDATE board_climbs SET user_id = NULL WHERE uuid = ${OWNERLESS_DRAFT}`);
      }
    });
  });
});
