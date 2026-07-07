import { describe, it, expect, beforeEach } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

// Migration 0146's trigger WHEN guards: internal-only and no-op UPDATEs must
// not advance the sync cursors (updated_at / sync_seq), or every kilter-sync
// bookkeeping pass and catalog re-upsert re-ships unchanged rows to every
// offline client. Runs against the real test Postgres with migrations applied.

const USER_ID = 'trigger-guard-user';

type SyncFields = { updated_at: string; sync_seq: number };

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO "users" (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'Test ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

beforeEach(async () => {
  await db.execute(sql`
    TRUNCATE TABLE sync_deletions, boardsesh_ticks, board_climbs, board_climb_stats
    RESTART IDENTITY CASCADE
  `);
  await insertUser(USER_ID);
});

describe('board_climbs sync-field trigger guard', () => {
  const climbUuid = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

  async function syncFields(): Promise<SyncFields> {
    const rows = (await db.execute(sql`
      SELECT updated_at::text AS updated_at, sync_seq FROM board_climbs WHERE uuid = ${climbUuid}
    `)) as unknown as SyncFields[];
    return rows[0];
  }

  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO board_climbs (uuid, board_type, layout_id, name)
      VALUES (${climbUuid}, 'kilter', 1, 'Guard Fixture')
    `);
  });

  it('does not bump the cursor on an internal-only write (synced / sync_error)', async () => {
    const before = await syncFields();

    await db.execute(sql`
      UPDATE board_climbs SET synced = false, sync_error = 'aurora 500' WHERE uuid = ${climbUuid}
    `);

    const after = await syncFields();
    expect(after.updated_at).toBe(before.updated_at);
    expect(Number(after.sync_seq)).toBe(Number(before.sync_seq));
  });

  it('does not bump the cursor on a no-op rewrite of client-visible columns', async () => {
    const before = await syncFields();

    await db.execute(sql`
      UPDATE board_climbs SET name = 'Guard Fixture', layout_id = 1 WHERE uuid = ${climbUuid}
    `);

    const after = await syncFields();
    expect(after.updated_at).toBe(before.updated_at);
    expect(Number(after.sync_seq)).toBe(Number(before.sync_seq));
  });

  it('bumps the cursor when a client-visible column changes', async () => {
    const before = await syncFields();

    await db.execute(sql`
      UPDATE board_climbs SET name = 'Renamed Fixture' WHERE uuid = ${climbUuid}
    `);

    const after = await syncFields();
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(Number(after.sync_seq)).toBeGreaterThan(Number(before.sync_seq));
  });
});

describe('board_climb_stats sync-field trigger guard', () => {
  const climbUuid = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

  async function syncFields(): Promise<SyncFields> {
    const rows = (await db.execute(sql`
      SELECT updated_at::text AS updated_at, sync_seq FROM board_climb_stats
      WHERE board_type = 'kilter' AND climb_uuid = ${climbUuid} AND angle = 40
    `)) as unknown as SyncFields[];
    return rows[0];
  }

  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO board_climb_stats (board_type, climb_uuid, angle, ascensionist_count, quality_average)
      VALUES ('kilter', ${climbUuid}, 40, 5, 3.5)
    `);
  });

  it('does not bump the cursor when the catalog upsert rewrites identical values', async () => {
    const before = await syncFields();

    // Mirrors the kilter catalog sync's whole-table rewrite: same values in the
    // SET list. Without the guard this re-shipped ~the entire stats table.
    await db.execute(sql`
      UPDATE board_climb_stats SET ascensionist_count = 5, quality_average = 3.5
      WHERE board_type = 'kilter' AND climb_uuid = ${climbUuid} AND angle = 40
    `);

    const after = await syncFields();
    expect(after.updated_at).toBe(before.updated_at);
    expect(Number(after.sync_seq)).toBe(Number(before.sync_seq));
  });

  it('bumps the cursor when a stat actually changes', async () => {
    const before = await syncFields();

    await db.execute(sql`
      UPDATE board_climb_stats SET ascensionist_count = 6
      WHERE board_type = 'kilter' AND climb_uuid = ${climbUuid} AND angle = 40
    `);

    const after = await syncFields();
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(Number(after.sync_seq)).toBeGreaterThan(Number(before.sync_seq));
  });
});

describe('boardsesh_ticks updated_at trigger guard', () => {
  const tickUuid = 'cccccccc-3333-4333-8333-cccccccccccc';

  async function updatedAt(): Promise<string> {
    const rows = (await db.execute(sql`
      SELECT updated_at::text AS updated_at FROM boardsesh_ticks WHERE uuid = ${tickUuid}
    `)) as unknown as Array<{ updated_at: string }>;
    return rows[0].updated_at;
  }

  beforeEach(async () => {
    await db.execute(sql`
      INSERT INTO boardsesh_ticks
        (uuid, user_id, board_type, climb_uuid, angle, status, climbed_at, updated_at)
      VALUES
        (${tickUuid}, ${USER_ID}, 'kilter', 'guard-climb', 40, 'send',
         '2026-05-01T10:00:00Z', '2026-05-01T10:00:00Z')
    `);
  });

  it('does not bump updated_at on a bookkeeping-only write (aurora_*/kilter_*)', async () => {
    const before = await updatedAt();

    await db.execute(sql`
      UPDATE boardsesh_ticks
      SET aurora_synced_at = now(), aurora_sync_error = NULL, kilter_id = 12345
      WHERE uuid = ${tickUuid}
    `);

    const after = await updatedAt();
    expect(after).toBe(before);
  });

  it('bumps updated_at when a content column changes and the writer forgets to set it', async () => {
    const before = await updatedAt();

    // No updated_at in the SET list — the safety net the trigger exists for:
    // without it this row's cursor position never moves and clients skip it.
    await db.execute(sql`
      UPDATE boardsesh_ticks SET comment = 'forgot the timestamp' WHERE uuid = ${tickUuid}
    `);

    const after = await updatedAt();
    expect(after).not.toBe(before);
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
});
