import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ensureMutationQueueTable,
  markScopeDownloadComplete,
  runMigrations,
  stampLocalUserId,
  getLatestClimbMutationKey,
  peekPending,
} from '@boardsesh/offline-sync';
import type { SaveClimbInput as ClimbInput } from '@boardsesh/shared-schema';
import { createTestDatabase, type TestSqliteDb } from '@boardsesh/offline-sync/testing';
import { saveClimbLocal, updateClimbLocal } from '../write-climb-local';
import { searchClimbsLocal, countClimbsLocal } from '../../db/queries/search-climbs-local';
import { getClimbLocal } from '../../db/queries/get-climb-local';
import { canEditClimb } from '@boardsesh/create-climb-react';

let serial = 0;
vi.mock('expo-crypto', () => ({ randomUUID: () => String(++serial).padStart(32, '0') }));
vi.mock('../../lib/auth-store', () => ({
  captureAuthCredentialGeneration: () => 1,
  isAuthCredentialGenerationCurrent: () => true,
}));
vi.mock('../../lib/local-user-id', () => ({ readLocalUserId: async () => 'climber' }));
vi.mock('../../lib/spray/spray-wall-registry', () => ({
  getSprayWall: () => ({ wallUuid: 'wall', angle: 40 }),
  sprayWallArchiveState: () => null,
}));
vi.mock('../../settings', () => ({ isOfflineBoardEnabled: () => true }));
vi.mock('../outbox-store', () => ({ notifyOutboxChanged: vi.fn() }));

describe('offline spray climb writes', () => {
  let db: TestSqliteDb;
  const input = (name: string): ClimbInput => ({
    boardType: 'spray',
    layoutId: 42,
    sizeId: 42,
    name,
    description: '',
    frames: 'p1r12p2r13',
    angle: 40,
    isDraft: true,
  });
  const search = {
    boardName: 'spray',
    layoutId: 42,
    sizeId: 42,
    setIds: '',
    angle: 40,
    onlyDrafts: true,
    draftScope: 'WALL' as const,
    sortBy: 'creation',
  };

  beforeEach(async () => {
    serial = 0;
    db = createTestDatabase();
    await ensureMutationQueueTable(db);
    await runMigrations(db);
    await stampLocalUserId(db, 'climber');
    await markScopeDownloadComplete(db, 'spray:42:42');
    await db.runAsync("INSERT INTO spray_walls (layout_id, board_uuid) VALUES (42, 'wall')");
  });

  it('saves several drafts and reopens them from durable rows without the network', async () => {
    const first = await saveClimbLocal(db, input('Blue'));
    const second = await saveClimbLocal(db, input('Green'));
    expect(first?.uuid).not.toBe(second?.uuid);
    expect(await countClimbsLocal(db, search)).toBe(2);
    expect((await searchClimbsLocal(db, search)).climbs.map((climb) => climb.name).sort()).toEqual(['Blue', 'Green']);
    expect(
      await getClimbLocal(db, {
        boardName: 'spray',
        layoutId: 42,
        angle: 40,
        climbUuid: first!.uuid,
        viewerId: 'climber',
      }),
    ).toMatchObject({ name: 'Blue', is_draft: true });
    expect(await peekPending(db)).toHaveLength(2);
    expect(await db.getFirstAsync('SELECT updated_at FROM board_climbs WHERE uuid = ?', [first!.uuid])).toEqual({
      updated_at: null,
    });
  });

  it('keeps one climb when a retry follows an uncertain local acknowledgement', async () => {
    const original = { ...input('Original'), uuid: 'A'.repeat(32) };
    await saveClimbLocal(db, original);
    const retried = await saveClimbLocal(db, { ...original, name: 'Recovered edits' });
    expect(retried?.uuid).toBe(original.uuid);
    expect(await countClimbsLocal(db, search)).toBe(1);
    expect((await searchClimbsLocal(db, search)).climbs[0]?.name).toBe('Recovered edits');
  });

  it('shares wall drafts but keeps the creator list owned', async () => {
    await saveClimbLocal(db, input('Mine'));
    await saveClimbLocal(db, input('Theirs'));
    await db.runAsync("UPDATE board_climbs SET user_id = 'another' WHERE name = 'Theirs'");
    expect(await countClimbsLocal(db, search)).toBe(2);
    expect(await countClimbsLocal(db, { ...search, draftScope: 'OWN' })).toBe(1);
  });

  it('orders an edit after creation and preserves omitted rule flags', async () => {
    const created = await saveClimbLocal(db, { ...input('Blue'), noMatch: true, anyFeet: true });
    await updateClimbLocal(db, { boardType: 'spray', uuid: created!.uuid, name: 'Better blue', noMatch: false });
    const mutations = await db.getAllAsync<{ operation: string; depends_on_key: string | null }>(
      'SELECT operation, depends_on_key FROM pending_mutations ORDER BY id',
    );
    expect(mutations[1]).toEqual({ operation: 'update', depends_on_key: `climb:create:${created!.uuid}` });
    const climb = await db.getFirstAsync<{ characteristics: string }>(
      'SELECT characteristics FROM board_climbs WHERE uuid = ?',
      [created!.uuid],
    );
    expect(JSON.parse(climb!.characteristics)).toEqual(['any_feet']);
    expect(await getLatestClimbMutationKey(db, 'spray', created!.uuid)).toBeTruthy();
  });

  it('repairs a rejected create under the original key, releasing its dependents', async () => {
    const created = await saveClimbLocal(db, input('Rejected'));
    await db.runAsync("UPDATE pending_mutations SET status = 'dead_letter' WHERE table_name = 'board_climbs'");
    await updateClimbLocal(db, { boardType: 'spray', uuid: created!.uuid, name: 'Fixed', frames: 'p3r12p4r13' });
    const mutations = await peekPending(db);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toMatchObject({ operation: 'create', idempotency_key: `climb:create:${created!.uuid}` });
    expect(JSON.parse(mutations[0]!.payload)).toMatchObject({ name: 'Fixed', layoutId: 42, frames: 'p3r12p4r13' });
    const operations = await db.getAllAsync<{ operation: string; depends_on_key: string | null }>(
      'SELECT operation, depends_on_key FROM pending_mutations ORDER BY id',
    );
    expect(operations[1]).toEqual({ operation: 'update', depends_on_key: `climb:create:${created!.uuid}` });
  });

  it('allows fixing a rejected offline publication back into a draft', async () => {
    const created = await saveClimbLocal(db, { ...input('Rejected'), isDraft: false });
    await db.runAsync("UPDATE pending_mutations SET status = 'dead_letter' WHERE table_name = 'board_climbs'");
    expect(await updateClimbLocal(db, { boardType: 'spray', uuid: created!.uuid, isDraft: true })).toMatchObject({
      isDraft: true,
    });
    expect(
      await db.getFirstAsync('SELECT is_draft, published_at FROM board_climbs WHERE uuid = ?', [created!.uuid]),
    ).toEqual({ is_draft: 1, published_at: null });
    const operations = await db.getAllAsync<{ payload: string }>('SELECT payload FROM pending_mutations');
    expect(operations.every((operation) => JSON.parse(operation.payload).isDraft === true)).toBe(true);
  });

  it('keeps an unacknowledged published climb editable after reopening48hours later', async () => {
    const created = await saveClimbLocal(db, { ...input('Waiting'), isDraft: false });
    const reopened = await getClimbLocal(db, {
      boardName: 'spray',
      layoutId: 42,
      angle: 40,
      climbUuid: created!.uuid,
      viewerId: 'climber',
    });
    expect(reopened?.localWritePending).toBe(true);
    expect(
      canEditClimb({
        climb: reopened,
        boardType: 'spray',
        currentUserId: 'climber',
        now: Date.now() + 48 * 60 * 60 * 1000,
      }),
    ).toBe(true);
  });

  it('shows the offline first-ascent grade after reopening', async () => {
    const created = await saveClimbLocal(db, input('Blue'));
    await db.runAsync(
      "INSERT INTO boardsesh_ticks (uuid, board_type, climb_uuid, user_id, angle, status, difficulty, climbed_at) VALUES ('tick', 'spray', ?, 'climber', 40, 'send', 16, '2026-10-26T10:00:00Z')",
      [created!.uuid],
    );
    const reopened = await getClimbLocal(db, {
      boardName: 'spray',
      layoutId: 42,
      angle: 40,
      climbUuid: created!.uuid,
      viewerId: 'climber',
    });
    expect(reopened?.difficulty).not.toBe('');
    expect(reopened?.userAscents).toBe(1);
  });
});
