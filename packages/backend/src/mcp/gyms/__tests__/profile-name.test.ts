import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as tables from '@boardsesh/db/schema';
import { SYSTEM_BOARD_OWNER_ID, type ConnectionContext } from '@boardsesh/shared-schema';
import { db, runWithDatabaseTransaction } from '../../../db/client';
import * as runtimeLoader from '../../../auth/partner/load-authority';
import type { PartnerAuthorityRuntime } from '../../../auth/partner/authority';
import { socialGymDuplicateMutations } from '../../../graphql/resolvers/social/gym-duplicates';
import { executeGymMcpTool } from '../dispatch';
import type { GymMcpPrincipal } from '../auth';
import { GYM_MCP_RESOURCE } from '../configuration';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function createPrincipal(userId: string): Promise<GymMcpPrincipal> {
  const principal: GymMcpPrincipal = {
    userId,
    clientId: `https://assistant.example/${randomUUID()}`,
    connectionId: randomUUID(),
    connectionGeneration: 1,
    scopes: ['gyms:read', 'gyms:write'],
    accessTokenHash: randomUUID(),
    connectionLastUsedAt: null,
  };
  await db.insert(tables.oauthClient).values({
    id: randomUUID(),
    clientId: principal.clientId,
    redirectUris: ['https://assistant.example/callback'],
  });
  await db.insert(tables.oauthConnections).values({
    id: principal.connectionId,
    userId,
    clientId: principal.clientId,
    generation: principal.connectionGeneration,
    scopes: principal.scopes,
  });
  const authorizationCodeId = randomUUID();
  await db.insert(tables.oauthGrants).values({
    authorizationCodeId,
    connectionId: principal.connectionId,
    generation: principal.connectionGeneration,
  });
  await db.insert(tables.oauthAccessToken).values({
    id: randomUUID(),
    token: principal.accessTokenHash,
    userId,
    clientId: principal.clientId,
    authorizationCodeId,
    resources: [GYM_MCP_RESOURCE],
    scopes: principal.scopes,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
  });
  vi.stubEnv('PARTNER_OAUTH_MODE', 'open');
  vi.stubEnv('GYM_MCP_MODE', 'on');
  vi.spyOn(runtimeLoader, 'loadPartnerAuthority').mockResolvedValue({
    configuration: { gymMcp: { mode: 'on', pilotUserIds: [] } },
    gymMcpApi: {},
  } as unknown as PartnerAuthorityRuntime);
  return principal;
}

describe('delegated gym name curation by a global admin', () => {
  it.each([
    { originalName: 'Boulder Neoliet Tilburg', approvedName: 'Boulder Neoliet Tilburg' },
    { originalName: 'Imported gym name', approvedName: 'Approved gym name' },
  ])(
    'freezes $originalName as $approvedName without changing its relationships',
    async ({ originalName, approvedName }) => {
      const adminId = randomUUID();
      const memberId = randomUUID();
      await db
        .insert(tables.users)
        .values({ id: SYSTEM_BOARD_OWNER_ID, email: 'system-profile-name@example.test', name: 'System import' })
        .onConflictDoNothing();
      await db.insert(tables.users).values([
        { id: adminId, email: `${adminId}@example.test`, name: 'Global admin' },
        { id: memberId, email: `${memberId}@example.test`, name: 'Gym member' },
      ]);
      await db.insert(tables.communityRoles).values({ userId: adminId, role: 'admin', boardType: null });
      const [gym] = await db
        .insert(tables.gyms)
        .values({
          uuid: randomUUID(),
          slug: `admin-profile-${randomUUID()}`,
          name: originalName,
          ownerId: SYSTEM_BOARD_OWNER_ID,
          address: 'Existing gym address',
          latitude: 51.55,
          longitude: 5.08,
          isPublic: true,
          isListed: true,
        })
        .returning();
      const [duplicate] = await db
        .insert(tables.gyms)
        .values({
          uuid: randomUUID(),
          slug: `admin-profile-duplicate-${randomUUID()}`,
          name: 'Duplicate imported gym',
          ownerId: SYSTEM_BOARD_OWNER_ID,
          latitude: 51.55,
          longitude: 5.08,
          isPublic: true,
        })
        .returning();
      await db.insert(tables.gymMembers).values({ gymId: gym.id, userId: memberId, role: 'member' });
      const [board] = await db
        .insert(tables.userBoards)
        .values({
          uuid: randomUUID(),
          slug: `admin-profile-board-${randomUUID()}`,
          ownerId: SYSTEM_BOARD_OWNER_ID,
          name: 'Imported board',
          boardType: 'kilter',
          layoutId: 1,
          sizeId: 10,
          setIds: '1',
          gymId: duplicate.id,
          isPublic: true,
        })
        .returning();
      const context: ConnectionContext = {
        connectionId: `gym-mcp-${randomUUID()}`,
        transport: 'http',
        userId: adminId,
        isAuthenticated: true,
        authCredentialProvided: true,
        isCronAuthenticated: false,
      };
      expect(gym.syncFrozenAt).toBeNull();
      await runWithDatabaseTransaction(() =>
        socialGymDuplicateMutations.mergeGyms(
          {},
          {
            input: {
              canonicalGymUuid: gym.uuid,
              duplicateGymUuids: [duplicate.uuid],
              allowSystemCanonicalOverride: true,
              reason: 'Verified duplicate imported gym for profile curation.',
            },
          },
          context,
        ),
      );
      const principal = await createPrincipal(adminId);
      const arguments_ = { gymUuid: gym.uuid, idempotencyKey: randomUUID(), changes: { name: approvedName } };
      const result = await executeGymMcpTool(principal, 'update_gym_profile', arguments_);

      expect(result).toMatchObject({ updateGym: { uuid: gym.uuid, name: approvedName, canEdit: true } });
      const [savedGym] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, gym.id));
      expect(savedGym).toMatchObject({
        name: approvedName,
        ownerId: SYSTEM_BOARD_OWNER_ID,
        address: gym.address,
        slug: gym.slug,
        isPublic: true,
        isListed: true,
      });
      expect(savedGym.syncFrozenAt).toBeInstanceOf(Date);
      expect(await db.select().from(tables.gymMembers).where(eq(tables.gymMembers.gymId, gym.id))).toMatchObject([
        { userId: memberId, role: 'member' },
      ]);
      const [savedBoard] = await db.select().from(tables.userBoards).where(eq(tables.userBoards.id, board.id));
      expect(savedBoard).toMatchObject({ ownerId: SYSTEM_BOARD_OWNER_ID, gymId: gym.id });
      const receipts = await db
        .select()
        .from(tables.gymMcpWriteReceipts)
        .where(eq(tables.gymMcpWriteReceipts.idempotencyKey, arguments_.idempotencyKey));
      expect(receipts).toHaveLength(1);
      expect(receipts[0]).toMatchObject({ operationName: 'update_gym_profile', result });
      expect(await executeGymMcpTool(principal, 'update_gym_profile', arguments_)).toEqual(result);
      const [replayedGym] = await db.select().from(tables.gyms).where(eq(tables.gyms.id, gym.id));
      expect(replayedGym.syncFrozenAt).toEqual(savedGym.syncFrozenAt);
    },
  );
});
