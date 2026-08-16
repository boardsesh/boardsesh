import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import { db } from '../db/client';
import {
  GYM_REASSIGN_CODES,
  socialGymOwnerReassignMutations,
  socialGymOwnerReassignQueries,
} from '../graphql/resolvers/social/gym-owner-reassign';
import { resetAllRateLimits } from '../utils/rate-limiter';

const SYSTEM_OWNER = '00000000-0000-0000-0000-000000000000';
const GLOBAL_ADMIN = 'gor-global-admin';
const SCOPED_ADMIN = 'gor-scoped-admin';
const PLAIN_USER = 'gor-plain-user';
const OUTGOING_OWNER = 'gor-outgoing-owner';
const INCOMING_OWNER = 'gor-incoming-owner';

const REASON = 'The club handed the wall over to a new committee chair.';

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
  options: { ownerId?: string; name?: string; syncFrozenAt?: string | null; deletedAt?: string | null } = {},
): Promise<{ id: number; uuid: string; slug: string; syncFrozenAt: string | null }> {
  const uuid = uuidv4();
  const ownerId = options.ownerId ?? OUTGOING_OWNER;
  const name = options.name ?? 'Handover Gym';
  const syncFrozenAt = options.syncFrozenAt === undefined ? '2026-08-01T01:02:03.000Z' : options.syncFrozenAt;
  const result = await db.execute(sql`
    INSERT INTO gyms
      (uuid, slug, owner_id, name, is_public, created_at, updated_at, deleted_at, sync_frozen_at)
    VALUES
      (${uuid}, ${uuid}, ${ownerId}, ${name}, true, now(), now(), ${options.deletedAt ?? null}, ${syncFrozenAt})
    RETURNING id
  `);
  const row = Array.from(result as Iterable<{ id: number }>)[0];
  return { id: Number(row.id), uuid, slug: uuid, syncFrozenAt };
}

type AuditRow = {
  gym_uuid: string;
  previous_owner_id: string;
  new_owner_id: string;
  sync_frozen_at_before: Date | string | null;
  sync_frozen_at_after: Date | string | null;
  reason: string;
  performed_by: string;
};

async function auditRows(): Promise<AuditRow[]> {
  const result = await db.execute(sql`
    SELECT gym_uuid, previous_owner_id, new_owner_id, sync_frozen_at_before,
           sync_frozen_at_after, reason, performed_by
      FROM gym_owner_reassignments
     ORDER BY id
  `);
  return Array.from(result as Iterable<AuditRow>);
}

async function gymRow(uuid: string): Promise<{ owner_id: string; sync_frozen_at: Date | string | null }> {
  const result = await db.execute(sql`SELECT owner_id, sync_frozen_at FROM gyms WHERE uuid = ${uuid}`);
  return Array.from(result as Iterable<{ owner_id: string; sync_frozen_at: Date | string | null }>)[0];
}

async function memberRoles(gymId: number): Promise<Array<{ user_id: string; role: string }>> {
  const result = await db.execute(sql`
    SELECT user_id, role FROM gym_members WHERE gym_id = ${gymId} ORDER BY user_id
  `);
  return Array.from(result as Iterable<{ user_id: string; role: string }>);
}

beforeEach(async () => {
  resetAllRateLimits();
  await db.execute(sql`
    TRUNCATE TABLE
      gym_owner_reassignments, gym_members, gym_claims, community_roles, gyms
    RESTART IDENTITY CASCADE
  `);
  await Promise.all(
    [SYSTEM_OWNER, GLOBAL_ADMIN, SCOPED_ADMIN, PLAIN_USER, OUTGOING_OWNER, INCOMING_OWNER].map(insertUser),
  );
  await db.execute(sql`
    INSERT INTO community_roles (user_id, role, board_type, created_at)
    VALUES
      (${GLOBAL_ADMIN}, 'admin', NULL, now()),
      (${SCOPED_ADMIN}, 'admin', 'kilter', now())
  `);
});

describe('gym owner reassignment authorization', () => {
  it('denies anonymous, plain, and board-scoped admin callers on both the lookup and the handover', async () => {
    const gym = await insertGym();
    const input = {
      gymUuid: gym.uuid,
      expectedCurrentOwnerId: OUTGOING_OWNER,
      newOwnerId: INCOMING_OWNER,
      reason: REASON,
    };

    for (const ctx of [anonCtx(), authCtx(PLAIN_USER), authCtx(SCOPED_ADMIN)]) {
      await expect(
        socialGymOwnerReassignQueries.gymOwnershipLookup(
          null,
          { input: { gymQuery: gym.uuid, newOwnerQuery: INCOMING_OWNER } },
          ctx,
        ),
      ).rejects.toThrow(/(admin role|authentication) required/i);
      await expect(socialGymOwnerReassignMutations.reassignGymOwner(null, { input }, ctx)).rejects.toThrow(
        /(admin role|authentication) required/i,
      );
    }

    // The board-scoped admin holds a real `admin` row — scoped to 'kilter'. It
    // must not reach a gym, and nothing may have moved for any caller.
    expect((await gymRow(gym.uuid)).owner_id).toBe(OUTGOING_OWNER);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('gymOwnershipLookup', () => {
  it('resolves the gym by uuid, slug, or name and the incoming owner by id or email', async () => {
    const gym = await insertGym({ name: 'Committee Wall' });

    const byUuid = await socialGymOwnerReassignQueries.gymOwnershipLookup(
      null,
      { input: { gymQuery: gym.uuid, newOwnerQuery: INCOMING_OWNER } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(byUuid.gym).toMatchObject({
      gymUuid: gym.uuid,
      name: 'Committee Wall',
      currentOwnerId: OUTGOING_OWNER,
      currentOwnerLabel: `User ${OUTGOING_OWNER}`,
      currentOwnerIsSystem: false,
      syncFrozenAt: gym.syncFrozenAt,
      isDeleted: false,
      isMerged: false,
    });
    expect(byUuid.newOwner).toEqual({
      userId: INCOMING_OWNER,
      label: `User ${INCOMING_OWNER}`,
      email: `${INCOMING_OWNER}@test.com`,
    });

    const byName = await socialGymOwnerReassignQueries.gymOwnershipLookup(
      null,
      { input: { gymQuery: 'committee', newOwnerQuery: `${INCOMING_OWNER}@test.com` } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(byName.gym?.gymUuid).toBe(gym.uuid);
    expect(byName.newOwner?.userId).toBe(INCOMING_OWNER);

    const unmatched = await socialGymOwnerReassignQueries.gymOwnershipLookup(
      null,
      { input: { gymQuery: 'no such wall anywhere', newOwnerQuery: 'nobody@example.com' } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(unmatched).toEqual({ gym: null, newOwner: null });
  });

  it('flags a system-owned listing so the confirm step can say the gym is unclaimed', async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER, syncFrozenAt: null });

    const result = await socialGymOwnerReassignQueries.gymOwnershipLookup(
      null,
      { input: { gymQuery: gym.slug, newOwnerQuery: INCOMING_OWNER } },
      authCtx(GLOBAL_ADMIN),
    );
    expect(result.gym).toMatchObject({ currentOwnerIsSystem: true, syncFrozenAt: null });
  });
});

describe('reassignGymOwner', () => {
  it('moves ownership, keeps the exact freeze timestamp, and writes one audit row proving it', async () => {
    const gym = await insertGym();

    const result = await socialGymOwnerReassignMutations.reassignGymOwner(
      null,
      {
        input: {
          gymUuid: gym.uuid,
          expectedCurrentOwnerId: OUTGOING_OWNER,
          newOwnerId: INCOMING_OWNER,
          reason: `  ${REASON}  `,
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    expect(result).toEqual({
      gymUuid: gym.uuid,
      gymName: 'Handover Gym',
      previousOwnerId: OUTGOING_OWNER,
      newOwnerId: INCOMING_OWNER,
      syncFrozenAt: gym.syncFrozenAt,
    });

    const row = await gymRow(gym.uuid);
    expect(row.owner_id).toBe(INCOMING_OWNER);
    // The exact seeded instant, not merely "still frozen": a handover that
    // re-stamped the marker would keep this non-null while silently restarting
    // the curation clock.
    expect(timestampIso(row.sync_frozen_at!)).toBe('2026-08-01T01:02:03.000Z');

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      gym_uuid: gym.uuid,
      previous_owner_id: OUTGOING_OWNER,
      new_owner_id: INCOMING_OWNER,
      reason: REASON,
      performed_by: GLOBAL_ADMIN,
    });
    expect(timestampIso(audit[0].sync_frozen_at_before!)).toBe('2026-08-01T01:02:03.000Z');
    expect(timestampIso(audit[0].sync_frozen_at_after!)).toBe('2026-08-01T01:02:03.000Z');
  });

  it('leaves an unfrozen gym unfrozen — a handover never creates a freeze', async () => {
    const gym = await insertGym({ syncFrozenAt: null });

    const result = await socialGymOwnerReassignMutations.reassignGymOwner(
      null,
      {
        input: {
          gymUuid: gym.uuid,
          expectedCurrentOwnerId: OUTGOING_OWNER,
          newOwnerId: INCOMING_OWNER,
          reason: REASON,
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    expect(result.syncFrozenAt).toBeNull();
    expect((await gymRow(gym.uuid)).sync_frozen_at).toBeNull();
    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0].sync_frozen_at_before).toBeNull();
    expect(audit[0].sync_frozen_at_after).toBeNull();
  });

  it('keeps a real outgoing owner on as a gym admin and drops the incoming owner’s membership row', async () => {
    const gym = await insertGym();
    await db.execute(sql`
      INSERT INTO gym_members (gym_id, user_id, role, created_at)
      VALUES (${gym.id}, ${OUTGOING_OWNER}, 'member', now()), (${gym.id}, ${INCOMING_OWNER}, 'editor', now())
    `);

    await socialGymOwnerReassignMutations.reassignGymOwner(
      null,
      {
        input: {
          gymUuid: gym.uuid,
          expectedCurrentOwnerId: OUTGOING_OWNER,
          newOwnerId: INCOMING_OWNER,
          reason: REASON,
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    // The stale `member` row is upgraded rather than left behind, matching applyGymClaim.
    expect(await memberRoles(gym.id)).toEqual([{ user_id: OUTGOING_OWNER, role: 'admin' }]);
  });

  it('does not hand the system import account a membership row when it is the outgoing owner', async () => {
    const gym = await insertGym({ ownerId: SYSTEM_OWNER });

    await socialGymOwnerReassignMutations.reassignGymOwner(
      null,
      {
        input: {
          gymUuid: gym.uuid,
          expectedCurrentOwnerId: SYSTEM_OWNER,
          newOwnerId: INCOMING_OWNER,
          reason: REASON,
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    expect((await gymRow(gym.uuid)).owner_id).toBe(INCOMING_OWNER);
    expect(await memberRoles(gym.id)).toEqual([]);
  });

  it('rejects a stale expected owner without moving anything or auditing', async () => {
    const gym = await insertGym();
    await db.execute(sql`UPDATE gyms SET owner_id = ${PLAIN_USER} WHERE id = ${gym.id}`);

    await expect(
      socialGymOwnerReassignMutations.reassignGymOwner(
        null,
        {
          input: {
            gymUuid: gym.uuid,
            expectedCurrentOwnerId: OUTGOING_OWNER,
            newOwnerId: INCOMING_OWNER,
            reason: REASON,
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toMatchObject({ extensions: { code: GYM_REASSIGN_CODES.ownerChanged } });

    expect((await gymRow(gym.uuid)).owner_id).toBe(PLAIN_USER);
    expect(await auditRows()).toHaveLength(0);
  });

  it('rejects an unknown target account, an unchanged owner, a soft-deleted gym, and a merged twin', async () => {
    const gym = await insertGym();

    await expect(
      socialGymOwnerReassignMutations.reassignGymOwner(
        null,
        {
          input: {
            gymUuid: gym.uuid,
            expectedCurrentOwnerId: OUTGOING_OWNER,
            newOwnerId: 'gor-ghost-account',
            reason: REASON,
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toMatchObject({ extensions: { code: GYM_REASSIGN_CODES.newOwnerNotFound } });

    await expect(
      socialGymOwnerReassignMutations.reassignGymOwner(
        null,
        {
          input: {
            gymUuid: gym.uuid,
            expectedCurrentOwnerId: OUTGOING_OWNER,
            newOwnerId: OUTGOING_OWNER,
            reason: REASON,
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toMatchObject({ extensions: { code: GYM_REASSIGN_CODES.ownerUnchanged } });

    const deleted = await insertGym({ name: 'Closed Wall', deletedAt: '2026-08-02T00:00:00.000Z' });
    await expect(
      socialGymOwnerReassignMutations.reassignGymOwner(
        null,
        {
          input: {
            gymUuid: deleted.uuid,
            expectedCurrentOwnerId: OUTGOING_OWNER,
            newOwnerId: INCOMING_OWNER,
            reason: REASON,
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toMatchObject({ extensions: { code: GYM_REASSIGN_CODES.notFound } });

    const survivor = await insertGym({ name: 'Survivor Wall' });
    const merged = await insertGym({ name: 'Merged Twin' });
    await db.execute(sql`UPDATE gyms SET merged_into_gym_id = ${survivor.id} WHERE id = ${merged.id}`);
    await expect(
      socialGymOwnerReassignMutations.reassignGymOwner(
        null,
        {
          input: {
            gymUuid: merged.uuid,
            expectedCurrentOwnerId: OUTGOING_OWNER,
            newOwnerId: INCOMING_OWNER,
            reason: REASON,
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toMatchObject({ extensions: { code: GYM_REASSIGN_CODES.merged } });

    await expect(
      socialGymOwnerReassignMutations.reassignGymOwner(
        null,
        {
          input: {
            gymUuid: uuidv4(),
            expectedCurrentOwnerId: OUTGOING_OWNER,
            newOwnerId: INCOMING_OWNER,
            reason: REASON,
          },
        },
        authCtx(GLOBAL_ADMIN),
      ),
    ).rejects.toMatchObject({ extensions: { code: GYM_REASSIGN_CODES.notFound } });

    expect(await auditRows()).toHaveLength(0);
  });

  it('serializes concurrent handovers so only one wins and one audit row lands', async () => {
    const gym = await insertGym();
    const input = {
      gymUuid: gym.uuid,
      expectedCurrentOwnerId: OUTGOING_OWNER,
      newOwnerId: INCOMING_OWNER,
      reason: REASON,
    };

    const outcomes = await Promise.allSettled([
      socialGymOwnerReassignMutations.reassignGymOwner(null, { input }, authCtx(GLOBAL_ADMIN)),
      socialGymOwnerReassignMutations.reassignGymOwner(null, { input }, authCtx(GLOBAL_ADMIN)),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect((await gymRow(gym.uuid)).owner_id).toBe(INCOMING_OWNER);
    expect(await auditRows()).toHaveLength(1);
  });

  it('retains the audit snapshot after both accounts are hard-deleted', async () => {
    const gym = await insertGym();
    await socialGymOwnerReassignMutations.reassignGymOwner(
      null,
      {
        input: {
          gymUuid: gym.uuid,
          expectedCurrentOwnerId: OUTGOING_OWNER,
          newOwnerId: INCOMING_OWNER,
          reason: REASON,
        },
      },
      authCtx(GLOBAL_ADMIN),
    );

    await db.execute(sql`DELETE FROM users WHERE id IN (${OUTGOING_OWNER}, ${INCOMING_OWNER}, ${GLOBAL_ADMIN})`);

    expect(await auditRows()).toEqual([
      expect.objectContaining({
        gym_uuid: gym.uuid,
        previous_owner_id: OUTGOING_OWNER,
        new_owner_id: INCOMING_OWNER,
        performed_by: GLOBAL_ADMIN,
      }),
    ]);
  });
});
