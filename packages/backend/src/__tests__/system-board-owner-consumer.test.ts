import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import {
  authEmailProjection,
  authEmailReservationMembers,
  authEmailReservations,
  authSecurityMutationEvents,
  authSubjectCutoffs,
  userBoards,
  users,
} from '@boardsesh/db/schema';
import { SYSTEM_BOARD_OWNER_EMAIL, SYSTEM_BOARD_OWNER_ID } from '@boardsesh/db/queries/constants';
import { db } from '../db/client';
import { prepareProjectionUnderUsersTableLock } from '../auth/current-store/email-reservations';
import { boardPresenceMutations } from '../graphql/resolvers/board-presence/mutations';
import { resolveSharedBoardForConfig } from '../graphql/resolvers/board-presence/shared';
import { pubsub } from '../pubsub';
import { logger } from '../utils/logger';
import { seedAuroraCatalogFixtures } from './helpers/board-catalog-fixture';

const config = { boardType: 'kilter', layoutId: 2_100_412_701, sizeId: 2_100_412_702, setIds: '2100412703' };
const requester = 'system-owner-fixture-requester';
const stampMembership = vi.fn<typeof pubsub.stampBoardMembership>();
let cleanupCatalog: () => Promise<void> = async () => {};
let projectionId: string;
function context(userId?: string): ConnectionContext {
  return {
    connectionId: randomUUID(),
    isAuthenticated: Boolean(userId),
    ...(userId ? { userId } : {}),
  } as ConnectionContext;
}
function resolve(userId?: string, submittedConfig = config) {
  return boardPresenceMutations.resolveBoardForConfig(undefined, submittedConfig, context(userId));
}
async function prepare() {
  projectionId = randomUUID();
  await db.transaction(async (transaction) => {
    await prepareProjectionUnderUsersTableLock(transaction, { projectionId });
    await transaction
      .update(authEmailProjection)
      .set({ phase: 'enforced' })
      .where(eq(authEmailProjection.projectionId, projectionId));
  });
  vi.stubEnv('CURRENT_STORE_AUTH_PROJECTION_ID', projectionId);
  vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '1');
}
async function ownerState() {
  return {
    users: await db.select().from(users).where(eq(users.id, SYSTEM_BOARD_OWNER_ID)),
    reservations: await db
      .select()
      .from(authEmailReservations)
      .where(eq(authEmailReservations.normalizedEmail, SYSTEM_BOARD_OWNER_EMAIL)),
    members: await db
      .select()
      .from(authEmailReservationMembers)
      .where(eq(authEmailReservationMembers.normalizedEmail, SYSTEM_BOARD_OWNER_EMAIL)),
    boards: await db.select().from(userBoards),
  };
}

describe('actual shared-board resolver with independently staged system owner', () => {
  beforeAll(async () => {
    cleanupCatalog = await seedAuroraCatalogFixtures([
      {
        boardType: config.boardType,
        productId: 2_100_412_700,
        layoutId: config.layoutId,
        sizeId: config.sizeId,
        setIds: [2_100_412_703, 2_100_412_704],
        associationIdBase: 2_100_412_710,
        isListed: false,
      },
    ]);
  });
  beforeEach(async () => {
    await db.delete(userBoards);
    await db.delete(authEmailReservationMembers);
    await db.delete(authEmailReservations);
    await db.delete(authSecurityMutationEvents);
    await db.delete(authSubjectCutoffs);
    await db.delete(authEmailProjection);
    await db.delete(users);
    await db.insert(users).values({ id: requester, email: 'requester@example.invalid' });
    vi.stubEnv('CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE', 'reserved-staging');
    vi.stubEnv('DEBUG_SQL', 'false');
    stampMembership.mockReset().mockResolvedValue(undefined);
    vi.spyOn(pubsub, 'stampBoardMembership').mockImplementation(stampMembership);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  afterAll(async () => {
    await cleanupCatalog();
  });

  it('creates the fixed owner and unchanged private shared-feed shape through the actual resolver', async () => {
    await prepare();
    const result = await resolve(requester);
    const created = await ownerState();
    expect(result).toMatchObject({
      boardType: config.boardType,
      layoutId: config.layoutId,
      sizeId: config.sizeId,
      setIds: config.setIds,
      boardName: 'Kilter Board Shared Feed',
    });
    expect(created.users).toHaveLength(1);
    expect(created.reservations).toHaveLength(1);
    expect(created.members).toHaveLength(1);
    expect(created.boards).toHaveLength(1);
    expect(created.boards[0]).toMatchObject({
      ownerId: SYSTEM_BOARD_OWNER_ID,
      isPublic: false,
      isUnlisted: true,
      hideLocation: true,
      isOwned: false,
    });
    expect(stampMembership).toHaveBeenCalledWith(String(result.boardId), requester);
  });
  it('anonymous first use creates neither a system owner nor a reservation', async () => {
    await prepare();
    const before = await ownerState();
    await expect(resolve()).rejects.toMatchObject({ extensions: { code: 'NOT_FOUND' } });
    expect(await ownerState()).toEqual(before);
    expect(stampMembership).not.toHaveBeenCalled();
  });
  it('catalog validation precedes system-owner writes', async () => {
    await prepare();
    const before = await ownerState();
    await expect(resolve(requester, { ...config, layoutId: 2_100_412_799 })).rejects.toMatchObject({
      extensions: { code: 'UNKNOWN_BOARD_CONFIG' },
    });
    expect(await ownerState()).toEqual(before);
    expect(stampMembership).not.toHaveBeenCalled();
  });
  it('existing feeds remain readable when staging configuration becomes invalid', async () => {
    await prepare();
    const existing = await resolve(requester);
    const before = await ownerState();
    vi.stubEnv('CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE', 'invalid-mode');
    expect(await resolve()).toEqual(existing);
    expect(await resolve(requester)).toEqual(existing);
    expect(await ownerState()).toEqual(before);
  });
  it.each(['missing-manifest', 'stale-epoch', 'bad-mode', 'unsafe-logging'] as const)(
    'fails closed for %s without a legacy write or raw diagnostic',
    async (failure) => {
      await prepare();
      if (failure === 'missing-manifest') {
        await db.delete(authEmailReservationMembers);
        await db.delete(authEmailReservations);
        await db.delete(authEmailProjection);
      }
      if (failure === 'stale-epoch') vi.stubEnv('CURRENT_STORE_AUTH_WRITER_EPOCH', '2');
      if (failure === 'bad-mode') vi.stubEnv('CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE', 'bad');
      if (failure === 'unsafe-logging') vi.stubEnv('DEBUG_SQL', 'true');
      const warning = vi.spyOn(logger, 'warn').mockImplementation(() => logger);
      const before = await ownerState();
      await expect(resolve(requester)).rejects.toMatchObject({
        message: 'Shared board creation is temporarily unavailable.',
        extensions: { code: 'SERVICE_UNAVAILABLE' },
      });
      expect(warning.mock.calls).toEqual([
        ['[board-presence] System board owner unavailable', { category: 'authority-or-database' }],
      ]);
      expect(await ownerState()).toEqual(before);
      expect(stampMembership).not.toHaveBeenCalled();
    },
  );
  it('legacy selector retains the existing mounted behavior without a projection', async () => {
    vi.stubEnv('CURRENT_STORE_SYSTEM_BOARD_OWNER_MODE', 'legacy');
    await resolve(requester);
    const created = await ownerState();
    expect(created.users).toHaveLength(1);
    expect(created.boards).toHaveLength(1);
    expect(created.reservations).toEqual([]);
    expect(created.members).toEqual([]);
  });
  it('simultaneous resolver calls converge on the same feed and fixed owner', async () => {
    await prepare();
    const results = await Promise.all([resolve(requester), resolve(requester)]);
    expect(results[0]).toEqual(results[1]);
    const created = await ownerState();
    expect(created.users).toHaveLength(1);
    expect(created.reservations).toHaveLength(1);
    expect(created.members).toHaveLength(1);
    expect(created.boards).toHaveLength(1);
  });
  it('two distinct valid configs share one owner without changing board fields', async () => {
    await prepare();
    const results = await Promise.all([resolve(requester), resolve(requester, { ...config, setIds: '2100412704' })]);
    expect(results[0].boardId).not.toBe(results[1].boardId);
    const created = await ownerState();
    expect(created.users).toHaveLength(1);
    expect(created.reservations).toHaveLength(1);
    expect(created.members).toHaveLength(1);
    expect(created.boards).toHaveLength(2);
  });
  it('a later caller failure leaves the complete committed fixed identity reusable', async () => {
    await prepare();
    stampMembership.mockRejectedValueOnce(new Error('owned-fixture-late-failure'));
    await expect(resolve(requester)).rejects.toThrow('owned-fixture-late-failure');
    const committed = await ownerState();
    expect(committed.users).toHaveLength(1);
    expect(committed.reservations).toHaveLength(1);
    expect(committed.members).toHaveLength(1);
    expect(committed.boards).toHaveLength(1);
    await expect(
      resolveSharedBoardForConfig(config.boardType, config.layoutId, config.sizeId, config.setIds),
    ).resolves.toMatchObject({ boardId: committed.boards[0].id });
    expect(await ownerState()).toEqual(committed);
  });
});
