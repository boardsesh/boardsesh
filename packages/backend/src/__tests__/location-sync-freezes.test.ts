import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  socialLocationSyncFreezeMutations,
  socialLocationSyncFreezeQueries,
} from '../graphql/resolvers/social/location-sync-freezes';
import { resetAllRateLimits } from '../utils/rate-limiter';

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const GLOBAL_ADMIN = 'lsf-global-admin';
const SCOPED_ADMIN = 'lsf-scoped-admin';
const PLAIN_USER = 'lsf-plain-user';
const ENTITY_OWNER = 'lsf-entity-owner';

const authCtx = (userId: string): ConnectionContext =>
  ({ connectionId: `conn-${userId}`, isAuthenticated: true, userId }) as ConnectionContext;
const anonCtx = (): ConnectionContext => ({ connectionId: 'conn-anon', isAuthenticated: false }) as ConnectionContext;

function timestampIso(timestamp: Date | string): string {
  return new Date(timestamp).toISOString();
}

async function insertUser(id: string): Promise<void> {
  await db.execute(sql`
    INSERT INTO users (id, email, name, created_at, updated_at)
    VALUES (${id}, ${id + '@test.com'}, ${'User ' + id}, now(), now())
    ON CONFLICT (id) DO NOTHING
  `);
}

async function insertGym(
  options: {
    ownerId?: string;
    name?: string;
    syncFrozenAt?: string | null;
    deletedAt?: string | null;
    updatedAt?: string;
  } = {},
): Promise<{ id: number; uuid: string; syncFrozenAt: string | null }> {
  const uuid = uuidv4();
  const ownerId = options.ownerId ?? SYSTEM_OWNER;
  const name = options.name ?? 'Frozen Gym';
  const syncFrozenAt = options.syncFrozenAt === undefined ? '2026-08-01T01:02:03.000Z' : options.syncFrozenAt;
  const deletedAt = options.deletedAt ?? null;
  const updatedAt = options.updatedAt ?? '2026-07-31T00:00:00.000Z';
  const result = await db.execute(sql`
    INSERT INTO gyms
      (uuid, slug, owner_id, name, is_public, created_at, updated_at, deleted_at, sync_frozen_at)
    VALUES
      (${uuid}, ${uuid}, ${ownerId}, ${name}, true, now(), ${updatedAt}, ${deletedAt}, ${syncFrozenAt})
    RETURNING id
  `);
  const row = Array.from(result as Iterable<{ id: number }>)[0];
  return { id: Number(row.id), uuid, syncFrozenAt };
}

async function insertBoard(
  options: {
    ownerId?: string;
    name?: string;
    syncFrozenAt?: string | null;
    deletedAt?: string | null;
  } = {},
): Promise<{ id: number; uuid: string; syncFrozenAt: string | null }> {
  const uuid = uuidv4();
  const ownerId = options.ownerId ?? SYSTEM_OWNER;
  const name = options.name ?? 'Frozen Board';
  const syncFrozenAt = options.syncFrozenAt === undefined ? '2026-08-01T02:03:04.000Z' : options.syncFrozenAt;
  const deletedAt = options.deletedAt ?? null;
  const result = await db.execute(sql`
    INSERT INTO user_boards
      (uuid, slug, owner_id, board_type, layout_id, size_id, set_ids, name,
       is_public, created_at, updated_at, deleted_at, sync_frozen_at)
    VALUES
      (${uuid}, ${uuid}, ${ownerId}, 'kilter', 1, 10, '1,2', ${name},
       true, now(), now(), ${deletedAt}, ${syncFrozenAt})
    RETURNING id
  `);
  const row = Array.from(result as Iterable<{ id: number }>)[0];
  return { id: Number(row.id), uuid, syncFrozenAt };
}

async function auditRows(): Promise<
  Array<{
    entity_type: string;
    entity_uuid: string;
    previous_sync_frozen_at: Date;
    previous_deleted_at: Date | null;
    previous_owner_id: string;
    reason: string;
    performed_by: string;
  }>
> {
  const result = await db.execute(sql`
    SELECT entity_type, entity_uuid, previous_sync_frozen_at, previous_deleted_at,
           previous_owner_id, reason, performed_by
      FROM location_sync_unfreeze_audit
     ORDER BY id
  `);
  return Array.from(
    result as Iterable<{
      entity_type: string;
      entity_uuid: string;
      previous_sync_frozen_at: Date;
      previous_deleted_at: Date | null;
      previous_owner_id: string;
      reason: string;
      performed_by: string;
    }>,
  );
}

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      location_sync_unfreeze_audit, location_sync_gym_sources, gym_claims,
      community_roles, user_boards, gyms
    RESTART IDENTITY CASCADE
  `);
  await Promise.all([SYSTEM_OWNER, GLOBAL_ADMIN, SCOPED_ADMIN, PLAIN_USER, ENTITY_OWNER].map(insertUser));
  await db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES
      (${GLOBAL_ADMIN}, 'admin', NULL, now()),
      (${SCOPED_ADMIN}, 'admin', 'kilter', now())
  `);
});

describe('location-sync freeze admin authorization', () => {
  it('denies anonymous, plain, and board-scoped admin callers before target access', async () => {
    const input = {
      entityType: 'GYM' as const,
      entityUuid: uuidv4(),
      expectedSyncFrozenAt: '2026-08-01T01:02:03.000Z',
      reason: 'The catalog should own this metadata again.',
    };

    for (const ctx of [anonCtx(), authCtx(PLAIN_USER), authCtx(SCOPED_ADMIN)]) {
      await expect(
        socialLocationSyncFreezeQueries.frozenLocationSyncEntities(null, { input: { entityType: 'GYM' } }, ctx),
      ).rejects.toThrow();
      await expect(socialLocationSyncFreezeMutations.clearLocationSyncFreeze(null, { input }, ctx)).rejects.toThrow();
    }
  });
});

describe('frozenLocationSyncEntities', () => {
  it('lists live and deleted gyms, enriches source/owner state, and excludes merged gyms', async () => {
    const sourced = await insertGym({ name: 'Sourced Gym' });
    await db.execute(sql`
      INSERT INTO location_sync_gym_sources (source_key, gym_id, created_at, updated_at)
      VALUES ('tension:two', ${sourced.id}, now(), now()), ('kilter:one', ${sourced.id}, now(), now())
    `);
    const claimed = await insertGym({
      ownerId: ENTITY_OWNER,
      name: 'Claimed Gym',
      deletedAt: '2026-08-01T03:00:00.000Z',
      syncFrozenAt: '2026-08-01T04:00:00.000Z',
    });
    await db.execute(sql`
      INSERT INTO gym_claims (gym_id, claimant_user_id, method, status, created_at, updated_at)
      VALUES (${claimed.id}, ${ENTITY_OWNER}, 'admin', 'approved', now(), now())
    `);
    const survivor = await insertGym({ name: 'Survivor Gym' });
    const merged = await insertGym({ name: 'Merged Gym' });
    await db.execute(sql`UPDATE gyms SET merged_into_gym_id = ${survivor.id} WHERE id = ${merged.id}`);
    await insertGym({ name: 'Not Frozen', syncFrozenAt: null });

    const result = await socialLocationSyncFreezeQueries.frozenLocationSyncEntities(
      null,
      { input: { entityType: 'GYM', limit: 20, offset: 0 } },
      authCtx(GLOBAL_ADMIN),
    );

    expect(result.totalCount).toBe(3);
    expect(result.entities.map((entity) => entity.entityUuid)).not.toContain(merged.uuid);
    const sourcedEntity = result.entities.find((entity) => entity.entityUuid === sourced.uuid)!;
    expect(sourcedEntity).toMatchObject({
      entityType: 'GYM',
      isSystemOwned: true,
      ownerProtected: false,
      isDeleted: false,
      sourceKeys: ['kilter:one', 'tension:two'],
    });
    const claimedEntity = result.entities.find((entity) => entity.entityUuid === claimed.uuid)!;
    expect(claimedEntity).toMatchObject({ isSystemOwned: false, ownerProtected: true, isDeleted: true });
    expect(claimedEntity.deletedAt).toBe('2026-08-01T03:00:00.000Z');

    const searched = await socialLocationSyncFreezeQueries.frozenLocationSyncEntities(
      null,
      { input: { entityType: 'GYM', query: 'claimed', limit: 20, offset: 0 } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(searched.entities.map((entity) => entity.entityUuid)).toEqual([claimed.uuid]);
  });

  it('lists frozen boards with stable pagination and omits unfrozen boards', async () => {
    const older = await insertBoard({ name: 'Older Wall', syncFrozenAt: '2026-08-01T01:00:00.000Z' });
    const newer = await insertBoard({ name: 'Newer Wall', syncFrozenAt: '2026-08-01T02:00:00.000Z' });
    await insertBoard({ name: 'Open Wall', syncFrozenAt: null });

    const firstPage = await socialLocationSyncFreezeQueries.frozenLocationSyncEntities(
      null,
      { input: { entityType: 'BOARD', limit: 1, offset: 0 } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(firstPage.totalCount).toBe(2);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.entities[0]).toMatchObject({
      entityUuid: newer.uuid,
      entityType: 'BOARD',
      boardType: 'kilter',
      ownerProtected: false,
      sourceKeys: [],
    });

    const secondPage = await socialLocationSyncFreezeQueries.frozenLocationSyncEntities(
      null,
      { input: { entityType: 'BOARD', limit: 1, offset: 1 } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(secondPage.entities[0].entityUuid).toBe(older.uuid);
    expect(secondPage.hasMore).toBe(false);
  });
});

describe('clearLocationSyncFreeze', () => {
  it('clears a deleted gym atomically, preserves other state, audits why, and retries idempotently', async () => {
    const updatedAt = '2026-07-31T05:00:00.000Z';
    const deletedAt = '2026-08-01T05:30:00.000Z';
    const gym = await insertGym({ ownerId: ENTITY_OWNER, deletedAt, updatedAt });
    const input = {
      entityType: 'GYM' as const,
      entityUuid: gym.uuid,
      expectedSyncFrozenAt: gym.syncFrozenAt!,
      reason: '  The moderator correction used the wrong source details.  ',
    };

    const first = await socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
      null,
      { input },
      authCtx(GLOBAL_ADMIN),
    );
    expect(first).toEqual({
      status: 'CLEARED',
      entityType: 'GYM',
      entityUuid: gym.uuid,
      previousSyncFrozenAt: gym.syncFrozenAt,
    });

    const gymResult = await db.execute(sql`
      SELECT owner_id, deleted_at, updated_at, sync_frozen_at FROM gyms WHERE uuid = ${gym.uuid}
    `);
    const gymRow = Array.from(
      gymResult as Iterable<{
        owner_id: string;
        deleted_at: Date | string;
        updated_at: Date | string;
        sync_frozen_at: Date | string | null;
      }>,
    )[0];
    expect(gymRow.owner_id).toBe(ENTITY_OWNER);
    expect(timestampIso(gymRow.deleted_at)).toBe(deletedAt);
    expect(timestampIso(gymRow.updated_at)).toBe(updatedAt);
    expect(gymRow.sync_frozen_at).toBeNull();

    expect(await auditRows()).toEqual([
      expect.objectContaining({
        entity_type: 'gym',
        entity_uuid: gym.uuid,
        previous_owner_id: ENTITY_OWNER,
        reason: 'The moderator correction used the wrong source details.',
        performed_by: GLOBAL_ADMIN,
      }),
    ]);

    const retry = await socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
      null,
      { input },
      authCtx(GLOBAL_ADMIN),
    );
    expect(retry).toEqual({
      status: 'ALREADY_UNFROZEN',
      entityType: 'GYM',
      entityUuid: gym.uuid,
      previousSyncFrozenAt: null,
    });
    expect(await auditRows()).toHaveLength(1);

    const refrozenAt = '2026-08-02T01:00:00.000Z';
    await db.execute(sql`UPDATE gyms SET sync_frozen_at = ${refrozenAt} WHERE id = ${gym.id}`);
    const secondClear = await socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
      null,
      { input: { ...input, expectedSyncFrozenAt: refrozenAt, reason: 'A later edit also needs source recovery.' } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(secondClear.status).toBe('CLEARED');
    expect(await auditRows()).toHaveLength(2);
  });

  it('clears a raw microsecond backfill timestamp and writes its audit row', async () => {
    const gym = await insertGym({ syncFrozenAt: null });
    await db.execute(sql`
      UPDATE gyms
         SET sync_frozen_at = TIMESTAMP '2026-08-01 01:02:03.123456'
       WHERE id = ${gym.id}
    `);

    const result = await socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
      null,
      {
        input: {
          entityType: 'GYM',
          entityUuid: gym.uuid,
          // GraphQL/JS can carry milliseconds only; the locked database row
          // deliberately retains another 456 microseconds.
          expectedSyncFrozenAt: '2026-08-01T01:02:03.123Z',
          reason: 'Release a legacy backfill marker with microseconds.',
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    expect(result.status).toBe('CLEARED');
    const markerResult = await db.execute(sql`SELECT sync_frozen_at FROM gyms WHERE id = ${gym.id}`);
    const marker = Array.from(markerResult as Iterable<{ sync_frozen_at: Date | string | null }>)[0];
    expect(marker.sync_frozen_at).toBeNull();

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'gym', entity_uuid: gym.uuid, performed_by: GLOBAL_ADMIN });
    expect(timestampIso(rows[0].previous_sync_frozen_at)).toBe('2026-08-01T01:02:03.123Z');
  });

  it('retains the actor UUID snapshot after the administrator account is hard-deleted', async () => {
    const board = await insertBoard();
    await socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
      null,
      {
        input: {
          entityType: 'BOARD',
          entityUuid: board.uuid,
          expectedSyncFrozenAt: board.syncFrozenAt!,
          reason: 'The actor snapshot must outlive the account.',
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    await db.execute(sql`DELETE FROM users WHERE id = ${GLOBAL_ADMIN}`);

    expect(await auditRows()).toEqual([
      expect.objectContaining({ entity_type: 'board', entity_uuid: board.uuid, performed_by: GLOBAL_ADMIN }),
    ]);
  });

  it('serializes concurrent board retries and writes one audit row', async () => {
    const board = await insertBoard({ deletedAt: '2026-08-01T06:00:00.000Z' });
    const input = {
      entityType: 'BOARD' as const,
      entityUuid: board.uuid,
      expectedSyncFrozenAt: board.syncFrozenAt!,
      reason: 'Let the upstream board listing restore this row.',
    };

    const results = await Promise.all([
      socialLocationSyncFreezeMutations.clearLocationSyncFreeze(null, { input }, authCtx(GLOBAL_ADMIN)),
      socialLocationSyncFreezeMutations.clearLocationSyncFreeze(null, { input }, authCtx(GLOBAL_ADMIN)),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['ALREADY_UNFROZEN', 'CLEARED']);
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entity_type: 'board', entity_uuid: board.uuid });
  });

  it('rejects a stale confirmation and leaves the newer freeze intact', async () => {
    const gym = await insertGym();
    const newerFreeze = '2026-08-02T02:00:00.000Z';
    await db.execute(sql`UPDATE gyms SET sync_frozen_at = ${newerFreeze} WHERE id = ${gym.id}`);

    await expect(
      socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
        null,
        {
          input: {
            entityType: 'GYM',
            entityUuid: gym.uuid,
            expectedSyncFrozenAt: gym.syncFrozenAt,
            reason: 'This stale dialog must not clear a newer edit.',
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/edited again/i);

    const rowResult = await db.execute(sql`SELECT sync_frozen_at FROM gyms WHERE id = ${gym.id}`);
    const row = Array.from(rowResult as Iterable<{ sync_frozen_at: Date | string }>)[0];
    expect(timestampIso(row.sync_frozen_at)).toBe(newerFreeze);
    expect(await auditRows()).toHaveLength(0);
  });

  it('rejects merged gyms and missing targets without audit rows', async () => {
    const survivor = await insertGym({ name: 'Survivor' });
    const merged = await insertGym({ name: 'Merged' });
    await db.execute(sql`UPDATE gyms SET merged_into_gym_id = ${survivor.id} WHERE id = ${merged.id}`);

    await expect(
      socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
        null,
        {
          input: {
            entityType: 'GYM',
            entityUuid: merged.uuid,
            expectedSyncFrozenAt: merged.syncFrozenAt,
            reason: 'A merge cannot be reversed by clearing a freeze.',
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/merged gym/i);

    await expect(
      socialLocationSyncFreezeMutations.clearLocationSyncFreeze(
        null,
        {
          input: {
            entityType: 'BOARD',
            entityUuid: uuidv4(),
            expectedSyncFrozenAt: '2026-08-01T00:00:00.000Z',
            reason: 'This target does not exist in the catalog.',
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toThrow(/not found/i);
    expect(await auditRows()).toHaveLength(0);
  });
});
