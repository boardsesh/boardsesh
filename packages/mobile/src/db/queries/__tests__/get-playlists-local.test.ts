import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  markScopeDownloadComplete,
  markUserDataComplete,
  runMigrations,
  stampLocalUserId,
} from '@boardsesh/offline-sync';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import type { GetPlaylistClimbsInput } from '@boardsesh/graphql/operations/playlists';
import {
  canServePlaylistClimbsLocal,
  getAllUserPlaylistsLocal,
  getUserPlaylistsLocal,
  getPlaylistLocal,
  getPlaylistsForClimbLocal,
  getPlaylistsForClimbsLocal,
  getPlaylistClimbsLocal,
  getPlaylistReadUnavailableReason,
  getPlaylistSettersLocal,
} from '../get-playlists-local';

const settings = vi.hoisted(() => ({ boards: [] as string[] }));
vi.mock('../../../settings/hooks', () => ({ getSetting: () => settings.boards }));
vi.mock('../../../lib/local-user-id', () => ({ readLocalUserId: async () => 'owner' }));

let db: TestSqliteDb;

async function playlist(
  uuid = 'playlist',
  overrides: { boardType?: string; layoutId?: number | null; updatedAt?: string; lastAccessedAt?: string | null } = {},
) {
  await db.runAsync(
    `INSERT INTO playlists (uuid, board_type, layout_id, name, description, is_public, color, icon, created_at, updated_at, last_accessed_at)
    VALUES (?, ?, ?, ?, 'Notes', 1, 'blue', 'star', '2026-01-01T00:00:00Z', ?, ?)`,
    [
      uuid,
      overrides.boardType ?? 'kilter',
      overrides.layoutId === undefined ? 1 : overrides.layoutId,
      `List ${uuid}`,
      overrides.updatedAt ?? '2026-10-01T00:00:00Z',
      overrides.lastAccessedAt ?? null,
    ],
  );
}

async function member(
  climbUuid: string,
  position = 0,
  options: { playlistId?: string; angle?: number | null; addedAt?: string } = {},
) {
  await db.runAsync(
    'INSERT INTO playlist_climbs (playlist_uuid, climb_uuid, angle, position, added_at) VALUES (?, ?, ?, ?, ?)',
    [
      options.playlistId ?? 'playlist',
      climbUuid,
      options.angle === undefined ? 40 : options.angle,
      position,
      options.addedAt ?? '2026-10-01T10:00:00Z',
    ],
  );
}

type ClimbFixture = {
  uuid: string;
  name?: string;
  boardType?: string;
  layoutId?: number;
  sizes?: number[];
  requiredSets?: number[] | null;
  setter?: string;
  isDraft?: number;
  userId?: string;
  frames?: string;
  framesCount?: number;
  isHidden?: number;
  retired?: number;
  isListed?: number;
  angle?: number;
};
async function climb(fixture: ClimbFixture) {
  await db.runAsync(
    `INSERT INTO board_climbs (uuid, board_type, layout_id, name, setter_username, user_id, is_draft, is_listed, is_hidden, retired_by_reset,
    frames, frames_count, compatible_size_ids, required_set_ids, angle, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Description')`,
    [
      fixture.uuid,
      fixture.boardType ?? 'kilter',
      fixture.layoutId ?? 1,
      fixture.name ?? fixture.uuid,
      fixture.setter ?? 'setter',
      fixture.userId ?? 'owner',
      fixture.isDraft ?? 0,
      fixture.isListed ?? 1,
      fixture.isHidden ?? 0,
      fixture.retired ?? 0,
      fixture.frames ?? 'p1r12p2r13',
      fixture.framesCount ?? 1,
      JSON.stringify(fixture.sizes ?? [5]),
      fixture.requiredSets === undefined || fixture.requiredSets === null ? null : JSON.stringify(fixture.requiredSets),
      fixture.angle ?? null,
    ],
  );
}

async function stats(
  uuid: string,
  difficulty = 18,
  options: {
    boardType?: string;
    angle?: number;
    ascents?: number;
    quality?: number;
    benchmark?: number;
    average?: number;
  } = {},
) {
  await db.runAsync(
    `INSERT INTO board_climb_stats (board_type, climb_uuid, angle, display_difficulty, difficulty_average, ascensionist_count, quality_average, benchmark_difficulty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      options.boardType ?? 'kilter',
      uuid,
      options.angle ?? 40,
      difficulty,
      options.average ?? difficulty,
      options.ascents ?? 10,
      options.quality ?? 3,
      options.benchmark ?? 0,
    ],
  );
}

async function downloaded(scope = 'kilter:1:5') {
  settings.boards.push(scope);
  await markScopeDownloadComplete(db, scope);
}

const readPage = (input: Partial<GetPlaylistClimbsInput> = {}) =>
  getPlaylistClimbsLocal(db, { playlistId: 'playlist', ...input }, 'owner');
const pageUuids = async (input: Partial<GetPlaylistClimbsInput> = {}) =>
  (await readPage(input))?.playlistClimbs.climbs.map((entry) => entry.uuid);

beforeEach(async () => {
  db = createTestDatabase();
  await runMigrations(db);
  await stampLocalUserId(db, 'owner');
  await markUserDataComplete(db);
  settings.boards = [];
});
afterEach(() => db.close());

describe('local playlist metadata and memberships', () => {
  it('reads the whole library and metadata without any board download', async () => {
    await playlist();
    await member('not-downloaded');
    expect(await getAllUserPlaylistsLocal(db, {}, 'owner')).toMatchObject({
      allUserPlaylists: {
        totalCount: 1,
        hasMore: false,
        playlists: [
          {
            uuid: 'playlist',
            id: 'playlist',
            climbCount: 1,
            userRole: 'owner',
            followerCount: 0,
            isFollowedByMe: false,
            isPinnedByMe: false,
          },
        ],
      },
    });
    expect(await getPlaylistLocal(db, 'playlist', 'owner')).toMatchObject({
      playlist: { name: 'List playlist', climbCount: 1, layoutId: 1, isPublic: true },
    });
    expect(await getPlaylistLocal(db, 'public-but-not-owned', 'owner')).toBeNull();
  });

  it('returns a valid empty library and empty memberships', async () => {
    expect(await getAllUserPlaylistsLocal(db, {}, 'owner')).toEqual({
      allUserPlaylists: { playlists: [], totalCount: 0, hasMore: false },
    });
    expect(await getPlaylistsForClimbsLocal(db, { boardType: 'kilter', layoutId: 1, climbUuids: [] }, 'owner')).toEqual(
      { playlistsForClimbs: [] },
    );
  });

  it('filters board/layout with NULL layout wildcard, orders recents, and pages the full count', async () => {
    await playlist('old', { updatedAt: '2026-09-01' });
    await playlist('recent', { lastAccessedAt: '2026-10-20' });
    await playlist('wildcard', { layoutId: null, updatedAt: '2026-10-10' });
    await playlist('other-layout', { layoutId: 2, updatedAt: '2026-10-22' });
    await playlist('tension', { boardType: 'tension', updatedAt: '2026-10-23' });
    expect(
      await getAllUserPlaylistsLocal(db, { boardType: 'kilter', layoutId: 1, pageSize: 2 }, 'owner'),
    ).toMatchObject({
      allUserPlaylists: { playlists: [{ uuid: 'recent' }, { uuid: 'wildcard' }], totalCount: 3, hasMore: true },
    });
    expect(
      await getAllUserPlaylistsLocal(db, { boardType: 'kilter', layoutId: 1, pageSize: 2, page: 1 }, 'owner'),
    ).toMatchObject({ allUserPlaylists: { playlists: [{ uuid: 'old' }], totalCount: 3, hasMore: false } });
    expect(
      (await getUserPlaylistsLocal(db, { boardType: 'kilter', layoutId: 1 }, 'owner'))?.userPlaylists.map(
        (entry) => entry.uuid,
      ),
    ).toEqual(['recent', 'wildcard', 'old']);
  });

  it('returns per-climb memberships only in the requested board/layout, including wildcard playlists', async () => {
    await playlist('matching');
    await playlist('wildcard', { layoutId: null });
    await playlist('other-layout', { layoutId: 2 });
    await playlist('other-board', { boardType: 'tension' });
    for (const playlistId of ['matching', 'wildcard', 'other-layout', 'other-board'])
      await member('one', 0, { playlistId });
    await member('two', 1, { playlistId: 'matching' });
    expect(
      await getPlaylistsForClimbsLocal(
        db,
        { boardType: 'kilter', layoutId: 1, climbUuids: ['one', 'two', 'absent', 'one'] },
        'owner',
      ),
    ).toEqual({
      playlistsForClimbs: [
        { climbUuid: 'one', playlistUuids: ['matching', 'wildcard'] },
        { climbUuid: 'two', playlistUuids: ['matching'] },
      ],
    });
    expect(
      await getPlaylistsForClimbLocal(db, { boardType: 'kilter', layoutId: 1, climbUuid: 'one' }, 'owner'),
    ).toEqual({ playlistsForClimb: ['matching', 'wildcard'] });
    expect(
      await getPlaylistsForClimbLocal(db, { boardType: 'kilter', layoutId: 1, climbUuid: 'absent' }, 'owner'),
    ).toEqual({ playlistsForClimb: [] });
  });

  it('chunks large membership requests below SQLite parameter limits', async () => {
    await playlist();
    await member('climb-949');
    const reads = vi.spyOn(db, 'getAllAsync');
    const response = await getPlaylistsForClimbsLocal(
      db,
      {
        boardType: 'kilter',
        layoutId: 1,
        climbUuids: Array.from({ length: 950 }, (_, index) => `climb-${index}`),
      },
      'owner',
    );
    expect(response).toEqual({ playlistsForClimbs: [{ climbUuid: 'climb-949', playlistUuids: ['playlist'] }] });
    expect(reads).toHaveBeenCalledTimes(3);
    expect(reads.mock.calls.map(([, binds]) => (Array.isArray(binds) ? binds.length : 0))).toEqual([402, 402, 152]);
  });

  it.each(['other-owner', 'no-owner', 'incomplete'])('declines every user read when %s', async (gate) => {
    await playlist();
    if (gate === 'other-owner') await stampLocalUserId(db, 'someone-else');
    if (gate === 'no-owner') await db.runAsync("DELETE FROM sync_meta WHERE key = 'local_user_id'");
    if (gate === 'incomplete') await db.runAsync("DELETE FROM sync_meta WHERE key = 'checkpoint:user_data_complete'");
    expect(await getAllUserPlaylistsLocal(db, {}, 'owner')).toBeNull();
    expect(await getPlaylistLocal(db, 'playlist', 'owner')).toBeNull();
    expect(
      await getPlaylistsForClimbLocal(db, { boardType: 'kilter', layoutId: 1, climbUuid: 'one' }, 'owner'),
    ).toBeNull();
    expect(await readPage()).toBeNull();
  });

  it('discards an answer when the owner changes while its SQL yields', async () => {
    await playlist();
    const query = db.getAllAsync.bind(db);
    vi.spyOn(db, 'getAllAsync').mockImplementationOnce(async (...args) => {
      const result = await query(...args);
      await stampLocalUserId(db, 'new-owner');
      return result;
    });
    expect(await getAllUserPlaylistsLocal(db, {}, 'owner')).toBeNull();
  });
});

describe('local playlist climb coverage', () => {
  beforeEach(async () => playlist());

  it('serves a genuinely empty playlist without a download, but declines unknown playlists', async () => {
    expect(await readPage()).toEqual({
      playlistClimbs: { climbs: [], totalCount: 0, unfilteredCount: null, hasMore: false },
    });
    expect(await readPage({ playlistId: 'not-owned' })).toBeNull();
  });

  it('declines missing or partially downloaded members instead of publishing a partial page', async () => {
    await climb({ uuid: 'one' });
    await member('one');
    expect(await getPlaylistReadUnavailableReason(db, { playlistId: 'playlist' }, 'owner')).toBe(
      'board_not_downloaded',
    );
    settings.boards = ['kilter:1:5'];
    expect(await canServePlaylistClimbsLocal(db, { playlistId: 'playlist' }, 'owner')).toBe(false);
    await markScopeDownloadComplete(db, 'kilter:1:5');
    expect(await pageUuids()).toEqual(['one']);
    await member('missing', 1);
    expect(await readPage()).toBeNull();
  });

  it('requires coverage of every board/size represented in a mixed playlist', async () => {
    await climb({ uuid: 'one' });
    await climb({ uuid: 'two', boardType: 'tension' });
    await climb({ uuid: 'large', sizes: [9] });
    await member('one');
    await member('two', 1);
    await member('large', 2);
    await downloaded();
    await downloaded('tension:1:5');
    expect(await readPage()).toBeNull();
    await downloaded('kilter:1:9');
    expect(await pageUuids()).toEqual(['one', 'two', 'large']);
  });

  it('does not require a size match on MoonBoard', async () => {
    await climb({ uuid: 'moon', boardType: 'moonboard', sizes: [] });
    await member('moon');
    await downloaded('moonboard:1:0');
    expect(await pageUuids()).toEqual(['moon']);
  });

  it('checks completion once per scope even for hundreds of members', async () => {
    for (let index = 0; index < 450; index++) {
      await climb({ uuid: `climb-${index}` });
      await member(`climb-${index}`, index);
    }
    await downloaded();
    const firstReads = vi.spyOn(db, 'getFirstAsync');
    const allReads = vi.spyOn(db, 'getAllAsync');
    expect((await readPage({ pageSize: 20 }))?.playlistClimbs).toMatchObject({ totalCount: 450, hasMore: true });
    expect(
      firstReads.mock.calls.filter(([, binds]) => Array.isArray(binds) && binds[0] === 'scope-complete:kilter:1:5'),
    ).toHaveLength(1);
    expect(allReads).toHaveBeenCalledTimes(2);
  });
});

describe('local playlist view parity', () => {
  beforeEach(async () => {
    await playlist();
    await downloaded();
  });

  it('keeps published unlisted/hidden/retired climbs and own drafts, but hides another owner’s drafts', async () => {
    await climb({ uuid: 'unlisted', isListed: 0 });
    await climb({ uuid: 'hidden', isHidden: 1 });
    await climb({ uuid: 'retired', retired: 1 });
    await climb({ uuid: 'own-draft', isDraft: 1 });
    await climb({ uuid: 'other-draft', isDraft: 1, userId: 'other' });
    for (const [index, uuid] of ['unlisted', 'hidden', 'retired', 'own-draft', 'other-draft'].entries())
      await member(uuid, index);
    expect(await pageUuids({ view: { name: '' } })).toEqual(['unlisted', 'hidden', 'retired', 'own-draft']);
  });

  it('pages in playlist order and reports filtered/unfiltered counts only for a filtering first page', async () => {
    for (const [index, name] of ['alpha', 'beta', 'gamma'].entries()) {
      await climb({ uuid: name });
      await member(name, index);
    }
    expect((await readPage({ pageSize: 2 }))?.playlistClimbs).toMatchObject({
      totalCount: 3,
      hasMore: true,
      unfilteredCount: null,
    });
    expect(await pageUuids({ pageSize: 2, page: 1 })).toEqual(['gamma']);
    expect((await readPage({ view: { name: 'ALPHA' } }))?.playlistClimbs).toMatchObject({
      totalCount: 1,
      unfilteredCount: 3,
      climbs: [{ uuid: 'alpha' }],
    });
    expect((await readPage({ page: 1, view: { name: 'alpha' } }))?.playlistClimbs).toMatchObject({
      totalCount: 1,
      unfilteredCount: null,
      climbs: [],
      hasMore: false,
    });
  });

  it('implements position, added, name, ascents, quality and difficulty sorts with stable ties', async () => {
    await climb({ uuid: 'zebra' });
    await member('zebra', 0, { addedAt: '2026-10-01' });
    await stats('zebra', 22, { ascents: 30, quality: 2 });
    await climb({ uuid: 'alpha' });
    await member('alpha', 1, { addedAt: '2026-10-02' });
    await stats('alpha', 18, { ascents: 10, quality: 4 });
    await climb({ uuid: 'beta' });
    await member('beta', 2, { addedAt: '2026-10-03' });
    await stats('beta', 18, { ascents: 20, quality: 3 });
    expect(await pageUuids({ view: { sortBy: 'position', sortOrder: 'desc' } })).toEqual(['beta', 'alpha', 'zebra']);
    expect(await pageUuids({ view: { sortBy: 'added' } })).toEqual(['beta', 'alpha', 'zebra']);
    expect(await pageUuids({ view: { sortBy: 'name' } })).toEqual(['alpha', 'beta', 'zebra']);
    expect(await pageUuids({ view: { sortBy: 'ascents' } })).toEqual(['zebra', 'beta', 'alpha']);
    expect(await pageUuids({ view: { sortBy: 'quality' } })).toEqual(['alpha', 'beta', 'zebra']);
    expect(await pageUuids({ view: { sortBy: 'difficulty' } })).toEqual(['alpha', 'beta', 'zebra']);
  });

  it('keeps a seeded shuffle stable across repeated requests and pages', async () => {
    for (let index = 0; index < 30; index++) {
      await climb({ uuid: `climb-${index}` });
      await member(`climb-${index}`, index);
    }
    const view = { sortBy: 'random' as const, sortSeed: '42' };
    const full = await pageUuids({ pageSize: 100, view });
    expect(await pageUuids({ pageSize: 100, view })).toEqual(full);
    const pages = [];
    for (let page = 0; page < 3; page++) pages.push(...((await pageUuids({ pageSize: 10, page, view })) ?? []));
    expect(pages).toEqual(full);
    expect(new Set(pages).size).toBe(30);
  });

  it('uses selected-angle stats, falls back to most ascents/lower-angle ties, and preserves explicit wall angles', async () => {
    await climb({ uuid: 'one' });
    await member('one', 0, { angle: 25 });
    await stats('one', 18, { angle: 30, ascents: 20 });
    await stats('one', 24, { angle: 40, ascents: 20 });
    expect((await readPage())?.playlistClimbs.climbs[0]).toMatchObject({ angle: 30, ascensionist_count: 20 });
    expect((await readPage({ activeBoardName: 'kilter', activeAngle: 40 }))?.playlistClimbs.climbs[0]).toMatchObject({
      angle: 40,
    });
    expect(
      (await readPage({ boardName: 'kilter', layoutId: 1, sizeId: 5, angle: 50 }))?.playlistClimbs.climbs[0],
    ).toMatchObject({ angle: 50, statsAngle: 30 });
    expect(await pageUuids({ activeBoardName: 'kilter', activeAngle: 25, view: { minGrade: 20 } })).toEqual([]);
    expect(await pageUuids({ activeBoardName: 'kilter', activeAngle: 40, view: { minGrade: 20 } })).toEqual(['one']);
  });

  it('uses a preferred-angle model-only grade in a view, but preserves plain hydration’s stats-angle rule', async () => {
    await climb({ uuid: 'unclimbed' });
    await member('unclimbed');
    await db.runAsync(
      "INSERT INTO board_climb_grades (board_type, climb_uuid, angle, local_grade, confidence) VALUES ('kilter', 'unclimbed', 40, 22, 'medium')",
    );
    expect((await readPage())?.playlistClimbs.climbs[0].boardseshDifficulty).toBeNull();
    expect((await readPage({ view: { name: 'unclimbed' } }))?.playlistClimbs.climbs[0].boardseshDifficulty).toBeNull();
    expect((await readPage({ view: { minGrade: 20 } }))?.playlistClimbs.climbs[0]).toMatchObject({
      uuid: 'unclimbed',
      boardseshDifficulty: 22,
    });
  });

  it('applies all-row filters across boards and active-only filters only on the active board', async () => {
    await climb({ uuid: 'one', setter: 'Alice' });
    await member('one');
    await stats('one', 20, { benchmark: 18, quality: 4 });
    await climb({ uuid: 'two', boardType: 'tension', setter: 'Alice' });
    await member('two', 1);
    await stats('two', 20, { boardType: 'tension', benchmark: 18, quality: 4 });
    await downloaded('tension:1:5');
    expect(
      await pageUuids({
        view: { setter: ['Alice'], onlyBenchmarks: true, minRating: 3, minAscents: 5, gradeAccuracy: '0.5' },
      }),
    ).toEqual(['one', 'two']);
    await db.runAsync(
      "INSERT INTO user_favorites (board_name, climb_uuid, angle, user_id) VALUES ('kilter', 'one', 20, 'owner')",
    );
    expect(
      await pageUuids({
        activeBoardName: 'kilter',
        activeLayoutId: 1,
        activeSizeId: 5,
        activeAngle: 40,
        view: { onlyFavorited: true },
      }),
    ).toEqual(['one']);
    expect(await pageUuids({ view: { onlyFavorited: true } })).toEqual([]);
    expect((await readPage({ view: { onlyFavorited: true } }))?.playlistClimbs.unfilteredCount).toBe(2);
  });

  it('reads owner and legacy progress at the active angle, including earlier holds like the server', async () => {
    for (const uuid of ['mine', 'legacy', 'other', 'old-holds']) {
      await climb({ uuid });
      await member(uuid);
    }
    for (const [uuid, ownerId, revision] of [
      ['mine', 'owner', 1],
      ['legacy', null, 1],
      ['other', 'someone-else', 1],
      ['old-holds', 'owner', 1],
    ] as const) {
      await db.runAsync(
        'INSERT INTO boardsesh_ticks (uuid, climb_uuid, board_type, angle, user_id, status, climbed_at, climb_revision) VALUES (?, ?, ?, 40, ?, ?, ?, ?)',
        [`tick-${uuid}`, uuid, 'kilter', ownerId, 'send', '2026-10-01', revision],
      );
    }
    await db.runAsync("UPDATE board_climbs SET holds_revision_number = 2 WHERE uuid = 'old-holds'");
    expect(
      await pageUuids({
        activeBoardName: 'kilter',
        activeLayoutId: 1,
        activeSizeId: 5,
        activeAngle: 40,
        view: { showOnlyCompleted: true },
      }),
    ).toEqual(['legacy', 'mine', 'old-holds']);
  });

  it.each([
    ['showOnlyCompleted', ['sent']],
    ['hideCompleted', ['attempted', 'unticked']],
    ['showOnlyAttempted', ['attempted']],
    ['hideAttempted', ['sent', 'unticked']],
  ] as const)('matches server %s after the climb holds change', async (filter, expected) => {
    for (const [index, uuid] of ['sent', 'attempted', 'unticked'].entries()) {
      await climb({ uuid });
      await member(uuid, index);
    }
    await db.runAsync('UPDATE board_climbs SET holds_revision_number = 2');
    for (const [uuid, status] of [
      ['sent', 'send'],
      ['attempted', 'attempt'],
    ] as const) {
      await db.runAsync(
        `INSERT INTO boardsesh_ticks (uuid, climb_uuid, board_type, angle, user_id, status, climbed_at, climb_revision)
         VALUES (?, ?, 'kilter', 40, 'owner', ?, '2026-10-01', 1)`,
        [`tick-${uuid}`, uuid, status],
      );
    }
    const board = { activeBoardName: 'kilter', activeLayoutId: 1, activeSizeId: 5, activeAngle: 40 };
    expect(await pageUuids({ ...board, view: { [filter]: true } })).toEqual(expected);
    expect(await pageUuids({ ...board, activeAngle: 30, view: { [filter]: true } })).toEqual(
      filter.startsWith('showOnly') ? [] : ['sent', 'attempted', 'unticked'],
    );
  });

  it('keeps earlier-holds ratings and chooses the latest rating across holds revisions', async () => {
    for (const [index, uuid] of ['old-low', 'rerated-high', 'unrated'].entries()) {
      await climb({ uuid });
      await member(uuid, index);
    }
    await db.runAsync('UPDATE board_climbs SET holds_revision_number = 3');
    for (const [tickUuid, climbUuid, quality, revision, climbedAt] of [
      ['low', 'old-low', 2, 1, '2026-10-01'],
      ['first', 'rerated-high', 2, 1, '2026-10-01'],
      ['latest', 'rerated-high', 5, 2, '2026-10-02'],
    ] as const) {
      await db.runAsync(
        `INSERT INTO boardsesh_ticks (uuid, climb_uuid, board_type, angle, user_id, status, quality, climb_revision, climbed_at)
         VALUES (?, ?, 'kilter', 40, 'owner', 'send', ?, ?, ?)`,
        [tickUuid, climbUuid, quality, revision, climbedAt],
      );
    }
    const board = { activeBoardName: 'kilter', activeLayoutId: 1, activeSizeId: 5, activeAngle: 40 };
    expect(await pageUuids({ ...board, view: { onlyRatedByMe: true } })).toEqual(['old-low', 'rerated-high']);
    expect(await pageUuids({ ...board, view: { minUserRating: 4 } })).toEqual(['rerated-high', 'unrated']);
    expect(await pageUuids({ ...board, view: { onlyRatedByMe: true, minUserRating: 4 } })).toEqual(['rerated-high']);
  });

  it('uses personal grades consistently for filtering, sorting and row projection', async () => {
    await climb({ uuid: 'one' });
    await member('one');
    await stats('one', 18);
    await climb({ uuid: 'two' });
    await member('two', 1);
    await stats('two', 22);
    await db.runAsync(
      "INSERT INTO boardsesh_ticks (uuid, climb_uuid, board_type, angle, user_id, status, difficulty, climbed_at) VALUES ('graded', 'one', 'kilter', 40, 'owner', 'send', 25, '2026-10-01')",
    );
    const board = { activeBoardName: 'kilter', activeLayoutId: 1, activeSizeId: 5, activeAngle: 40 };
    expect(await pageUuids({ ...board, view: { sortBy: 'difficulty', useMyGrades: true } })).toEqual(['two', 'one']);
    expect(
      (await readPage({ ...board, view: { minGrade: 24, useMyGrades: true } }))?.playlistClimbs.climbs[0],
    ).toMatchObject({ uuid: 'one', myDifficulty: 25 });
  });

  it('scopes board fit by type/layout/size/sets, allowing NULL required sets', async () => {
    for (const fixture of [
      { uuid: 'fits' },
      { uuid: 'wrong-size', sizes: [9] },
      { uuid: 'wrong-sets', requiredSets: [99] },
      { uuid: 'other-layout', layoutId: 2 },
    ]) {
      await climb(fixture);
      await member(fixture.uuid);
    }
    await downloaded('kilter:1:9');
    await downloaded('kilter:2:5');
    const specific = { boardName: 'kilter', layoutId: 1, sizeId: 5, setIds: '1,2' };
    expect(await pageUuids(specific)).toEqual(['fits']);
    expect(
      await pageUuids({
        activeBoardName: 'kilter',
        activeLayoutId: 1,
        activeSizeId: 5,
        activeSetIds: '1,2',
        activeAngle: 40,
        view: { onlyActiveBoard: true },
      }),
    ).toEqual(['fits']);
  });

  it('supports route/boulder, projects and present-hold filters without leaking catalogue rules', async () => {
    await climb({ uuid: 'boulder', isListed: 0, frames: 'p1r12' });
    await member('boulder');
    await climb({ uuid: 'route', framesCount: 3, frames: 'p2r12' });
    await member('route', 1);
    await stats('route');
    expect(await pageUuids({ view: { boulders: true, routes: false, projectsOnly: true } })).toEqual(['boulder']);
    expect(
      await pageUuids({
        activeBoardName: 'kilter',
        activeLayoutId: 1,
        activeAngle: 40,
        view: { holdsFilter: { '1': { ANY: 'include' } } },
      }),
    ).toEqual(['boulder']);
  });

  it('requires a complete followed-author snapshot and applies it only on the active board', async () => {
    await climb({ uuid: 'followed', setter: 'Alice' });
    await member('followed');
    await climb({ uuid: 'unfollowed', setter: 'Bob' });
    await member('unfollowed', 1);
    await climb({ uuid: 'off-board', boardType: 'tension', setter: 'Alice' });
    await member('off-board', 2);
    await downloaded('tension:1:5');
    const input = {
      activeBoardName: 'kilter',
      activeLayoutId: 1,
      activeSizeId: 5,
      activeAngle: 40,
      view: { onlyFollowedAuthors: true },
    };
    expect(await readPage(input)).toBeNull();
    await db.runAsync('INSERT INTO followed_author_snapshots (user_id, snapshot) VALUES (?, ?)', [
      'owner',
      JSON.stringify({
        authors: { setterUsernames: ['Alice'], users: [] },
        incompleteUserIds: [],
        complete: true,
      }),
    ]);
    expect(await pageUuids(input)).toEqual(['followed']);
  });

  it('sorts and filters Woods at each row’s displayed stats without catalogue angle restrictions', async () => {
    await climb({ uuid: 'woods', boardType: 'woods', angle: 50 });
    await member('woods', 0, { angle: 25 });
    await stats('woods', 23, { boardType: 'woods', angle: 50 });
    await downloaded('woods:1:5');
    expect(
      await pageUuids({ activeBoardName: 'woods', activeAngle: 30, view: { name: 'woods', minGrade: 22 } }),
    ).toEqual(['woods']);
  });

  it('declines unsupported filter tables instead of serving unfiltered rows', async () => {
    await climb({ uuid: 'one' });
    await member('one');
    const board = { activeBoardName: 'kilter', activeLayoutId: 1, activeSizeId: 5, activeAngle: 40 };
    expect(await readPage({ ...board, view: { onlyWithBetaVideos: true } })).toBeNull();
    expect(await readPage({ ...board, view: { holdsFilter: { '1': { STARTING: 'include' } } } })).toBeNull();
    expect(
      await getPlaylistReadUnavailableReason(
        db,
        { playlistId: 'playlist', ...board, view: { onlyWithBetaVideos: true } },
        'owner',
      ),
    ).toBe('filter_unsupported');
  });

  it('reads playlist setters with scoped counts and escaped prefix search', async () => {
    for (const [index, setter] of ['Alice', 'Alice', 'Adam', 'A_lex'].entries()) {
      const uuid = `one-${index}`;
      await climb({ uuid, setter });
      await member(uuid, index);
    }
    expect(await getPlaylistSettersLocal(db, { playlistId: 'playlist' }, 'owner')).toEqual({
      playlistSetters: [
        { username: 'Alice', climbCount: 2 },
        { username: 'A_lex', climbCount: 1 },
        { username: 'Adam', climbCount: 1 },
      ],
    });
    expect(await getPlaylistSettersLocal(db, { playlistId: 'playlist', search: 'a_' }, 'owner')).toEqual({
      playlistSetters: [{ username: 'A_lex', climbCount: 1 }],
    });
    expect(await getPlaylistSettersLocal(db, { smartType: 'LIKED_CLIMBS' }, 'owner')).toBeNull();
  });
});
