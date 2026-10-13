// A draft is fetchable only by the account that owns it (owner's rule,
// 2026-10-13). Two side channels used to hand other people's drafts out:
//
//   1. the board sync behind an offline download (`syncClimbs`, plus the stats
//      and grades streams keyed to each climb) mirrored every climb row on the
//      board, drafts included, to whoever downloaded it;
//   2. the public nightly snapshot export published every ownerless climb, so a
//      draft imported from someone's Kilter or Tension account (no Boardsesh
//      owner) landed in the public dataset.
//
// Published and unlisted climbs are unchanged on both. Real Postgres throughout.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectionContext, SyncResult } from '@boardsesh/shared-schema';
import { createPool, rowsFromResult } from '@boardsesh/db/client';
import { climbDraftVisibilityCondition } from '@boardsesh/db/queries';
import { db } from '../db/client';
import { climbMutations } from '../graphql/resolvers/climbs/mutations';
import { syncQueries } from '../graphql/resolvers/sync/queries';
import { discoverLayoutPairs, exportLayoutSnapshot } from '../scripts/export-board-snapshots';

vi.mock('../utils/redis-rate-limiter', () => ({
  checkRateLimitRedis: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../events', () => ({
  publishSocialEvent: vi.fn().mockResolvedValue(undefined),
}));

const OWNER_ID = 'drafts-owner-only-owner';
const STRANGER_ID = 'drafts-owner-only-stranger';
const BOARD_TYPE = 'kilter';
const LAYOUT_ID = 1;
const DRAFT_ONLY_LAYOUT_ID = 7;
const SIZE_ID = 5;
const UPDATED_AT = '2026-05-01T00:00:00Z';

type SeededClimb = { uuid: string; userId: string | null; isDraft: boolean | null; isListed: boolean };

const CLIMBS: SeededClimb[] = [
  { uuid: 'published-owned', userId: OWNER_ID, isDraft: false, isListed: true },
  { uuid: 'unlisted-owned', userId: OWNER_ID, isDraft: false, isListed: false },
  { uuid: 'draft-owned', userId: OWNER_ID, isDraft: true, isListed: false },
  // An Aurora import: the setter is only a setter_id/setter_username, no Boardsesh owner.
  { uuid: 'draft-ownerless', userId: null, isDraft: true, isListed: false },
  { uuid: 'published-ownerless', userId: null, isDraft: false, isListed: true },
  { uuid: 'unlisted-ownerless', userId: null, isDraft: false, isListed: false },
  // `is_draft` is nullable and NULL is not a draft.
  { uuid: 'null-flag-ownerless', userId: null, isDraft: null, isListed: true },
];

/** Every climb any signed-in viewer is handed, before drafts. */
const EVERYONE_SEES = [
  'null-flag-ownerless',
  'published-owned',
  'published-ownerless',
  'unlisted-owned',
  'unlisted-ownerless',
];
/** What the public snapshot carries: ownerless and not a draft. */
const SNAPSHOT_HOLDS = ['null-flag-ownerless', 'published-ownerless', 'unlisted-ownerless'];

function ctx(userId: string): ConnectionContext {
  return {
    connectionId: `drafts-owner-only-${userId}`,
    isAuthenticated: true,
    userId,
    sessionId: null,
    controllerId: null,
    controllerApiKey: null,
  } as unknown as ConnectionContext;
}

const scope = { boardType: BOARD_TYPE, layoutId: LAYOUT_ID, sizeId: SIZE_ID, cursor: null, limit: 500 };

function documentField(page: SyncResult, field: string): string[] {
  return (page.documents as Array<Record<string, unknown>>).map((document) => String(document[field])).sort();
}

async function syncedClimbUuids(viewerId: string): Promise<string[]> {
  return documentField(await syncQueries.syncClimbs(undefined, scope, ctx(viewerId)), 'uuid');
}

async function syncedStatClimbUuids(viewerId: string): Promise<string[]> {
  return documentField(await syncQueries.syncClimbStats(undefined, scope, ctx(viewerId)), 'climb_uuid');
}

async function syncedGradeClimbUuids(viewerId: string): Promise<string[]> {
  return documentField(await syncQueries.syncClimbGrades(undefined, scope, ctx(viewerId)), 'climb_uuid');
}

async function insertClimb(climb: SeededClimb, layoutId = LAYOUT_ID): Promise<void> {
  await db.execute(sql`
    INSERT INTO board_climbs
      (uuid, board_type, layout_id, name, user_id, is_draft, is_listed, compatible_size_ids, updated_at)
    VALUES
      (${climb.uuid}, ${BOARD_TYPE}, ${layoutId}, ${'Climb ' + climb.uuid}, ${climb.userId}, ${climb.isDraft},
       ${climb.isListed}, ${`{${SIZE_ID}}`}::int[], ${UPDATED_AT}::timestamp)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
    VALUES (${BOARD_TYPE}, ${climb.uuid}, 40, 3, ${UPDATED_AT}::timestamp)
  `);
  await db.execute(sql`
    INSERT INTO board_climb_grades
      (board_type, climb_uuid, angle, local_grade, universal_grade, confidence, ascensionist_count,
       model_version, coeff_version, computed_at)
    VALUES (${BOARD_TYPE}, ${climb.uuid}, 40, 20, 20, 'low', 3, 'test-model', 'test-coeff', ${UPDATED_AT}::timestamp)
  `);
}

function readArtifactColumn(filePath: string, table: string, column: string): string[] {
  const artifact = new DatabaseSync(filePath, { readOnly: true });
  try {
    return (artifact.prepare(`SELECT ${column} AS value FROM ${table}`).all() as { value: string }[])
      .map((row) => String(row.value))
      .sort();
  } finally {
    artifact.close();
  }
}

let workDir: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'drafts-owner-only-'));
  await db.execute(sql`TRUNCATE TABLE board_climbs, board_climb_stats, board_climb_grades RESTART IDENTITY CASCADE`);
  for (const userId of [OWNER_ID, STRANGER_ID]) {
    await db.execute(sql`INSERT INTO users (id, name, email)
      VALUES (${userId}, ${userId}, ${`${userId}@example.test`}) ON CONFLICT DO NOTHING`);
  }
  for (const climb of CLIMBS) await insertClimb(climb);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('board sync for offline downloads: drafts go to their owner only', () => {
  it("leaves another account's draft and an ownerless draft out of a stranger's climbs page", async () => {
    expect(await syncedClimbUuids(STRANGER_ID)).toEqual(EVERYONE_SEES);
  });

  it("hands the owner their own draft, and still nobody's ownerless draft", async () => {
    expect(await syncedClimbUuids(OWNER_ID)).toEqual([...EVERYONE_SEES, 'draft-owned'].sort());
  });

  it("leaves the drafts' stats rows out the same way", async () => {
    expect(await syncedStatClimbUuids(STRANGER_ID)).toEqual(EVERYONE_SEES);
    expect(await syncedStatClimbUuids(OWNER_ID)).toEqual([...EVERYONE_SEES, 'draft-owned'].sort());
  });

  it("leaves the drafts' grades rows out the same way", async () => {
    expect(await syncedGradeClimbUuids(STRANGER_ID)).toEqual(EVERYONE_SEES);
    expect(await syncedGradeClimbUuids(OWNER_ID)).toEqual([...EVERYONE_SEES, 'draft-owned'].sort());
  });

  it('ships the draft to everyone once it is published', async () => {
    // Publishing is an UPDATE, which moves the row's sync cursor
    // (`set_board_climbs_sync_fields`), so a device past the draft's old cursor
    // still pulls it.
    const before = await syncQueries.syncClimbs(undefined, scope, ctx(STRANGER_ID));
    await db.execute(sql`UPDATE board_climbs SET is_draft = false WHERE uuid IN ('draft-owned', 'draft-ownerless')`);
    const after = await syncQueries.syncClimbs(undefined, { ...scope, cursor: before.cursor }, ctx(STRANGER_ID));
    expect(documentField(after, 'uuid')).toEqual(['draft-owned', 'draft-ownerless']);
  });
});

describe("publishing a draft re-sends its stats to other climbers' devices", () => {
  it('re-stamps stats rows a device already walked past while the climb was a draft', async () => {
    // A draft sent to a session and climbed there: its stats rows exist, and
    // their cursor sits before every row other devices have already pulled.
    await db.execute(sql`
      INSERT INTO board_climbs
        (uuid, board_type, layout_id, name, user_id, is_draft, is_listed, angle, frames, frames_count,
         compatible_size_ids, updated_at)
      VALUES
        ('publish-me', ${BOARD_TYPE}, ${LAYOUT_ID}, 'Publish me', ${OWNER_ID}, true, false, 40, 'p1145r12p1146r13', 1,
         ${`{${SIZE_ID}}`}::int[], ${UPDATED_AT}::timestamp)
    `);
    for (const angle of [40, 50]) {
      await db.execute(sql`
        INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, updated_at)
        VALUES (${BOARD_TYPE}, 'publish-me', ${angle}, 2, '2026-04-01T00:00:00Z'::timestamp)
      `);
    }
    const strangerPage = await syncQueries.syncClimbStats(undefined, scope, ctx(STRANGER_ID));
    expect(documentField(strangerPage, 'climb_uuid')).toEqual(EVERYONE_SEES);

    // Migration 0270's membership trigger re-stamps these rows on publish too,
    // but it belongs to #6339's reverted design and a cleanup PR drops it.
    // Switch it off so this proves updateClimb re-sends the stats on its own.
    await db.execute(sql`ALTER TABLE board_climbs DISABLE TRIGGER trg_board_climbs_reference_membership`);
    try {
      await climbMutations.updateClimb(
        null,
        { input: { uuid: 'publish-me', boardType: BOARD_TYPE, isDraft: false } },
        ctx(OWNER_ID),
      );
    } finally {
      await db.execute(sql`ALTER TABLE board_climbs ENABLE TRIGGER trg_board_climbs_reference_membership`);
    }

    const nextPage = await syncQueries.syncClimbStats(
      undefined,
      { ...scope, cursor: strangerPage.cursor },
      ctx(STRANGER_ID),
    );
    const shipped = (nextPage.documents as Array<Record<string, unknown>>)
      .map(
        (document) => `${String(document.climb_uuid)}@${String(document.angle)}:${String(document.ascensionist_count)}`,
      )
      .sort();
    // Both angles, with the counts the sends wrote, not a fresh empty seed.
    expect(shipped).toEqual(['publish-me@40:2', 'publish-me@50:2']);
  });
});

describe('public snapshot export: no drafts', () => {
  it('publishes no draft, and none of its stats or grades', async () => {
    const filePath = join(workDir, 'layout.db');
    const gradesFilePath = join(workDir, 'grades.db');
    const result = await exportLayoutSnapshot({
      sqlClient: createPool(),
      boardType: BOARD_TYPE,
      layoutId: LAYOUT_ID,
      filePath,
      gradesFilePath,
      builtAt: '2026-06-01T00:00:00.000Z',
      stabilityWindowSeconds: 0,
    });

    expect(readArtifactColumn(filePath, 'board_climbs', 'uuid')).toEqual(SNAPSHOT_HOLDS);
    expect(readArtifactColumn(filePath, 'board_climb_stats', 'climb_uuid')).toEqual(SNAPSHOT_HOLDS);
    expect(result.grades?.tables.board_climb_grades.rowCount).toBe(SNAPSHOT_HOLDS.length);
    expect(readArtifactColumn(gradesFilePath, 'board_climb_grades', 'climb_uuid')).toEqual(SNAPSHOT_HOLDS);
  });

  it('builds no artifact for a layout whose only ownerless climbs are drafts', async () => {
    await insertClimb(
      { uuid: 'draft-only-layout', userId: null, isDraft: true, isListed: false },
      DRAFT_ONLY_LAYOUT_ID,
    );
    expect(await discoverLayoutPairs(createPool(), { boardType: BOARD_TYPE })).toEqual([
      { boardType: BOARD_TYPE, layoutId: LAYOUT_ID },
    ]);
  });
});

describe('climbDraftVisibilityCondition', () => {
  it('lets only the owner read a draft, everyone read a non-draft, and never yields NULL', async () => {
    const draftRule = (viewerId: string | null | undefined) =>
      climbDraftVisibilityCondition({ isDraft: sql`truth.is_draft`, userId: sql`truth.user_id` }, viewerId);
    const result = await db.execute(sql`
      SELECT truth.label,
        ${draftRule(OWNER_ID)} AS owner_reads,
        ${draftRule(STRANGER_ID)} AS stranger_reads,
        ${draftRule(null)} AS anonymous_reads,
        ${draftRule(undefined)} AS undefined_viewer_reads,
        NOT ${draftRule(STRANGER_ID)} AS negated_for_stranger
      FROM (VALUES
        ('owned draft', true, ${OWNER_ID}::text),
        ('ownerless draft', true, NULL::text),
        ('owned published', false, ${OWNER_ID}::text),
        ('ownerless published', false, NULL::text),
        ('ownerless null flag', NULL::boolean, NULL::text)
      ) AS truth(label, is_draft, user_id)
      ORDER BY truth.label
    `);
    expect(rowsFromResult(result)).toEqual([
      {
        label: 'owned draft',
        owner_reads: true,
        stranger_reads: false,
        anonymous_reads: false,
        undefined_viewer_reads: false,
        negated_for_stranger: true,
      },
      {
        label: 'owned published',
        owner_reads: true,
        stranger_reads: true,
        anonymous_reads: true,
        undefined_viewer_reads: true,
        negated_for_stranger: false,
      },
      {
        label: 'ownerless draft',
        owner_reads: false,
        stranger_reads: false,
        anonymous_reads: false,
        undefined_viewer_reads: false,
        negated_for_stranger: true,
      },
      {
        label: 'ownerless null flag',
        owner_reads: true,
        stranger_reads: true,
        anonymous_reads: true,
        undefined_viewer_reads: true,
        negated_for_stranger: false,
      },
      {
        label: 'ownerless published',
        owner_reads: true,
        stranger_reads: true,
        anonymous_reads: true,
        undefined_viewer_reads: true,
        negated_for_stranger: false,
      },
    ]);
  });
});
