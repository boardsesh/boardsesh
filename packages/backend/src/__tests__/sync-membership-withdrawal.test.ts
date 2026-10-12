import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import type { ConnectionContext, SyncCursorInput } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import { syncQueries } from '../graphql/resolvers/sync/queries';

const VIEWER = 'user-123';
const OTHER = 'withdrawal-other';
const context = { userId: VIEWER, isAuthenticated: true } as ConnectionContext;
const pull = (cursor?: SyncCursorInput, limit = 10) => syncQueries.syncDeletions(undefined, { cursor, limit }, context);

async function climb(
  uuid: string,
  ownerId: string,
  options: { draft?: boolean; boardType?: string; layoutId?: number } = {},
) {
  await db.execute(sql`
    INSERT INTO board_climbs (uuid, board_type, layout_id, user_id, is_draft, is_listed, updated_at)
    VALUES (${uuid}, ${options.boardType ?? 'kilter'}, ${options.layoutId ?? 1}, ${ownerId},
            ${options.draft ?? false}, true, '2026-05-01'::timestamp)
  `);
}

async function marker(uuid: string, membership = true, tableName = 'board_climbs') {
  await db.execute(sql`
    INSERT INTO sync_deletions (table_name, record_id, deleted_at, is_membership_withdrawal)
    VALUES (${tableName}, ${uuid}, '2026-06-01'::timestamp, ${membership})
  `);
}

describe('membership withdrawals retain only rows this viewer can currently sync', () => {
  beforeAll(async () => {
    await db.execute(sql`
      INSERT INTO users (id, name, email) VALUES (${OTHER}, 'Private setter', 'withdrawal-other@example.test')
      ON CONFLICT DO NOTHING
    `);
    await db.execute(sql`
      INSERT INTO user_profiles (user_id, is_private) VALUES (${OTHER}, true)
      ON CONFLICT (user_id) DO UPDATE SET is_private = true
    `);
  });
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE sync_deletions, board_climbs RESTART IDENTITY CASCADE`);
  });

  it('filters an authorized marker before the limit so installed clients reach a later withdrawal', async () => {
    await climb('withdrawal-owned', VIEWER, { draft: true });
    await climb('withdrawal-foreign', OTHER, { draft: true });
    await marker('withdrawal-owned');
    await marker('withdrawal-foreign');
    const first = await pull(undefined, 1);
    expect(first.deletions.map((deletion) => deletion.recordId)).toEqual(['withdrawal-foreign']);
    expect(first.cursor.syncSeq).toBe('2');
    expect(first.hasMore).toBe(true);
    expect((await pull(first.cursor, 1)).deletions).toEqual([]);
  });

  it('keeps an empty owner-only poll compatible and delivers a later hide', async () => {
    await climb('withdrawal-republished', OTHER);
    await marker('withdrawal-republished');
    const retained = await pull(undefined, 1);
    expect(retained.deletions).toEqual([]);
    expect(retained.cursor.syncSeq).toBe('0');
    expect(retained.hasMore).toBe(false);

    await db.execute(sql`UPDATE board_climbs SET is_draft = true WHERE uuid = 'withdrawal-republished'`);
    expect((await pull(retained.cursor)).deletions.map((deletion) => deletion.recordId)).toEqual([
      'withdrawal-republished',
      'withdrawal-republished',
    ]);
  });

  it('preserves an ordinary hard-delete marker even when the UUID has a readable replacement', async () => {
    await climb('withdrawal-recreated', VIEWER, { draft: true });
    await marker('withdrawal-recreated', false);
    expect((await pull()).deletions.map((deletion) => deletion.recordId)).toEqual(['withdrawal-recreated']);
  });

  // The flag ships here with the filter that reads it, and nothing sets it yet:
  // the trigger that flags a withdrawal comes one release later, once every
  // backend serving sync filters flagged markers. Until then a withdrawal is an
  // ordinary marker, stamped one second before the new row
  // (0270_climb_reference_membership),
  // which an older backend delivers safely.
  it('leaves the real membership trigger and a later hard delete both unflagged in this release', async () => {
    await climb('withdrawal-classification', OTHER);
    await db.execute(sql`UPDATE board_climbs SET is_draft = true WHERE uuid = 'withdrawal-classification'`);
    await db.execute(sql`DELETE FROM board_climbs WHERE uuid = 'withdrawal-classification'`);
    const classificationRows = rowsFromResult<{ is_membership_withdrawal: boolean }>(
      await db.execute(sql`
        SELECT is_membership_withdrawal FROM sync_deletions
        WHERE table_name = 'board_climbs' AND record_id = 'withdrawal-classification' ORDER BY id
      `),
    );
    expect(classificationRows.map((row) => row.is_membership_withdrawal)).toEqual([false, false]);
  });

  it('does not classify another table or an unsupported board as a readable climb withdrawal', async () => {
    await climb('withdrawal-other-table', VIEWER);
    await climb('withdrawal-unsupported', VIEWER, { boardType: 'unsupported-test-board' });
    await marker('withdrawal-other-table', true, 'boardsesh_ticks');
    await marker('withdrawal-unsupported');
    expect((await pull()).deletions.map((deletion) => deletion.recordId)).toEqual([
      'withdrawal-other-table',
      'withdrawal-unsupported',
    ]);
  });

  it('retains a private setter’s republished reference climb without an account follow', async () => {
    await climb('withdrawal-public', OTHER);
    await marker('withdrawal-public');
    expect((await pull()).deletions).toEqual([]);
  });

  it('requires current spray wall access even for the climb owner, with no Unlisted capability', async () => {
    const wallUuid = randomUUID();
    const layoutId = 930_001;
    await db.execute(sql`
      INSERT INTO user_boards (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name, is_public, is_unlisted)
      VALUES (${wallUuid}, ${wallUuid}, ${OTHER}, 'spray', ${layoutId}, ${layoutId}, '1', 'Private wall', false, true)
    `);
    await db.execute(sql`INSERT INTO spray_walls (board_uuid, layout_id) VALUES (${wallUuid}, ${layoutId})`);
    await db.execute(sql`
      INSERT INTO resource_privacy (kind, resource_id, owner_id, audience)
      VALUES ('board', ${wallUuid}, ${OTHER}, 'unlisted')
    `);
    await climb('withdrawal-spray', VIEWER, { draft: true, boardType: 'spray', layoutId });
    await marker('withdrawal-spray');
    expect((await pull()).deletions.map((deletion) => deletion.recordId)).toEqual(['withdrawal-spray']);

    await db.execute(sql`
      INSERT INTO resource_grants (kind, resource_id, user_id, status)
      VALUES ('board', ${wallUuid}, ${VIEWER}, 'approved')
    `);
    expect((await pull()).deletions).toEqual([]);
    await db.execute(sql`
      UPDATE resource_grants SET status = 'revoked' WHERE kind = 'board' AND resource_id = ${wallUuid} AND user_id = ${VIEWER}
    `);
    expect((await pull()).deletions.map((deletion) => deletion.recordId)).toEqual(['withdrawal-spray']);
  });
});
