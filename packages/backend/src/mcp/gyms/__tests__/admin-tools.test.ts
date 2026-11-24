import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLError } from 'graphql';
import { z } from 'zod';
import type { ConnectionContext } from '@boardsesh/shared-schema';
import type { GymMcpPrincipal } from '../auth';

const domain = vi.hoisted(() => ({
  assertGymMcpGlobalAdmin: vi.fn(),
  authorizeAdminMergeReplay: vi.fn(),
  authorizeCanonicalSlugReplay: vi.fn(),
  repairGymCanonicalSlug: vi.fn(),
  correctBoardLocationVisibility: vi.fn(),
  correctBoardSetup: vi.fn(),
  inspectGymDuplicates: vi.fn(),
  mergeAdminGyms: vi.fn(),
  mergeDuplicateBoards: vi.fn(),
}));
const dispatch = vi.hoisted(() => ({ receipt: vi.fn(), insert: vi.fn(), write: vi.fn() }));
vi.mock('../admin-domain', () => domain);
vi.mock('../../../services/merge-duplicate-boards', () => ({ mergeDuplicateBoards: domain.mergeDuplicateBoards }));
vi.mock('../../../db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: dispatch.receipt }) }) }),
    insert: () => ({ values: dispatch.insert }),
  },
}));
vi.mock('../auth', () => ({ withGymMcpWrite: dispatch.write }));
vi.mock('../registry', () => ({
  findGymMcpTool: (name: string) => gymMcpAdminTools.find((entry) => entry.name === name),
}));

import { gymMcpAdminTools } from '../admin-tools';
import { executeGymMcpTool, gymMcpInputHash } from '../dispatch';

const gymUuid = '00000000-0000-4000-8000-000000000001';
const duplicateGymUuid = '00000000-0000-4000-8000-000000000002';
const boardUuid = '00000000-0000-4000-8000-000000000003';
const duplicateBoardUuid = '00000000-0000-4000-8000-000000000004';
const idempotencyKey = '00000000-0000-4000-8000-000000000005';
const stateHash = 'a'.repeat(64);
const reason = 'The gym confirmed one full-set 2019 MoonBoard.';
const context: ConnectionContext = {
  connectionId: 'admin-gym-mcp-test',
  transport: 'http',
  userId: 'global-admin',
  isAuthenticated: true,
};
const identity = { gymUuid, boardUuid, expectedStateHash: stateHash, idempotencyKey, confirm: true, reason };
const gymMerge = {
  canonicalGymUuid: gymUuid,
  duplicateGymUuids: [duplicateGymUuid],
  expectedStates: [gymUuid, duplicateGymUuid].map((gymUuid) => ({ gymUuid, stateHash })),
  idempotencyKey,
  confirm: true,
  reason,
};
const boardMerge = {
  gymUuid,
  canonicalBoardUuid: boardUuid,
  duplicateBoardUuids: [duplicateBoardUuid],
  expectedStates: [boardUuid, duplicateBoardUuid].map((boardUuid) => ({ boardUuid, stateHash })),
  samePhysicalWall: true,
  allowOwnershipChange: true,
  idempotencyKey,
  confirm: true,
  reason,
};
const writeArguments: Record<string, Record<string, unknown>> = {
  repair_gym_canonical_slug: {
    gymUuid,
    aliasGymUuid: duplicateGymUuid,
    slug: 'approved-gym',
    expectedStateHash: stateHash,
    expectedAliasStateHash: stateHash,
    idempotencyKey,
    confirm: true,
    reason,
  },
  correct_gym_board_setup: { ...identity, changes: { layoutId: 5, sizeId: 1, setIds: '17,18,19,20,21,22,23' } },
  correct_gym_board_location_visibility: { ...identity, hideLocation: false },
  merge_duplicate_gyms: gymMerge,
  merge_duplicate_gym_boards: boardMerge,
};

function tool(name: string) {
  const found = gymMcpAdminTools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`Missing admin tool ${name}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  domain.assertGymMcpGlobalAdmin.mockResolvedValue(undefined);
  domain.authorizeAdminMergeReplay.mockResolvedValue(undefined);
  domain.authorizeCanonicalSlugReplay.mockResolvedValue(undefined);
  dispatch.receipt.mockResolvedValue([]);
  dispatch.insert.mockResolvedValue(undefined);
  dispatch.write.mockImplementation((_principal, _scope, work: () => Promise<unknown>) => work());
  for (const handler of [
    domain.correctBoardLocationVisibility,
    domain.correctBoardSetup,
    domain.inspectGymDuplicates,
    domain.mergeAdminGyms,
    domain.mergeDuplicateBoards,
    domain.repairGymCanonicalSlug,
  ])
    handler.mockResolvedValue({ saved: true });
});

describe('gym MCP administrative repair tools', () => {
  it('advertises fixed actions with separate administrative consent scopes', () => {
    expect(gymMcpAdminTools.map((entry) => entry.name)).toEqual([
      'inspect_gym_duplicates',
      'repair_gym_canonical_slug',
      'correct_gym_board_setup',
      'correct_gym_board_location_visibility',
      'merge_duplicate_gyms',
      'merge_duplicate_gym_boards',
    ]);
    expect(tool('inspect_gym_duplicates')).toMatchObject({
      scope: 'gyms:admin:read',
      category: 'admin',
      readOnly: true,
      destructive: false,
    });
    for (const entry of gymMcpAdminTools.filter((entry) => !entry.readOnly))
      expect(entry).toMatchObject({ scope: 'gyms:admin:write', category: 'admin', destructive: true });
  });

  it('publishes JSON-serializable strict schemas without arbitrary queries or actor selection', () => {
    for (const entry of gymMcpAdminTools) {
      const schema = z.toJSONSchema(entry.inputSchema);
      expect(JSON.parse(JSON.stringify(schema))).toMatchObject({ type: 'object', additionalProperties: false });
      expect(entry.inputSchema.shape).not.toHaveProperty('query');
      expect(entry.inputSchema.shape).not.toHaveProperty('document');
      expect(entry.inputSchema.shape).not.toHaveProperty('actorUserId');
      const valid = entry.readOnly ? { gymUuids: [gymUuid] } : writeArguments[entry.name];
      for (const unexpected of [
        { actorUserId: 'another-admin' },
        { query: 'mutation { arbitrary }' },
        { document: 'deleteAll' },
      ])
        expect(entry.inputSchema.safeParse({ ...valid, ...unexpected }).success).toBe(false);
    }
  });

  it('bounds explicit gym inspection without requiring matching names', async () => {
    const inspect = tool('inspect_gym_duplicates');
    expect(inspect.inputSchema.safeParse({ gymUuids: [] }).success).toBe(false);
    expect(inspect.inputSchema.safeParse({ gymUuids: [gymUuid, gymUuid] }).success).toBe(false);
    expect(inspect.inputSchema.safeParse({ gymUuids: Array(11).fill(gymUuid) }).success).toBe(false);
    await expect(inspect.run({ gymUuids: [gymUuid, duplicateGymUuid] }, context)).resolves.toEqual({ saved: true });
    expect(domain.assertGymMcpGlobalAdmin).toHaveBeenCalledWith(context);
    expect(domain.inspectGymDuplicates).toHaveBeenCalledWith([gymUuid, duplicateGymUuid], context);
  });

  it.each(Object.keys(writeArguments))(
    'requires an acknowledgement, reason, retry identity and inspected state for %s',
    (name) => {
      const schema = tool(name).inputSchema;
      for (const missing of [
        'confirm',
        'reason',
        'idempotencyKey',
        name.startsWith('merge_') ? 'expectedStates' : 'expectedStateHash',
      ]) {
        const arguments_ = { ...writeArguments[name] };
        delete arguments_[missing];
        expect(schema.safeParse(arguments_).success).toBe(false);
      }
      for (const invalid of [
        { confirm: false },
        { reason: '   ' },
        { reason: 'short' },
        { reason: 'x'.repeat(1001) },
        { idempotencyKey: 'not-a-uuid' },
      ])
        expect(schema.safeParse({ ...writeArguments[name], ...invalid }).success).toBe(false);
    },
  );

  it('separates configuration correction from publication, ownership and pairing credentials', async () => {
    const setup = tool('correct_gym_board_setup');
    expect(setup.inputSchema.safeParse({ ...identity, changes: {} }).success).toBe(false);
    for (const forbidden of [
      { hideLocation: false },
      { ownerId: 'new-owner' },
      { isPublic: true },
      { serialNumber: '1234' },
    ])
      expect(setup.inputSchema.safeParse({ ...identity, changes: forbidden }).success).toBe(false);
    await setup.run(writeArguments.correct_gym_board_setup, context);
    expect(domain.correctBoardSetup).toHaveBeenCalledWith(writeArguments.correct_gym_board_setup, context);
    expect(domain.correctBoardLocationVisibility).not.toHaveBeenCalled();
  });

  it('accepts explicitly making a location public without changing any other privacy field', async () => {
    const visibility = tool('correct_gym_board_location_visibility');
    for (const hideLocation of [false, true])
      expect(visibility.inputSchema.safeParse({ ...identity, hideLocation }).success).toBe(true);
    expect(visibility.inputSchema.safeParse({ ...identity, hideLocation: false, isPublic: true }).success).toBe(false);
    expect(
      visibility.inputSchema.safeParse({ ...identity, hideLocation: false, expectedStateHash: 'stale' }).success,
    ).toBe(false);
    await visibility.run(writeArguments.correct_gym_board_location_visibility, context);
    expect(domain.correctBoardLocationVisibility).toHaveBeenCalledWith(
      writeArguments.correct_gym_board_location_visibility,
      context,
    );
  });

  it('binds canonical URL repair to the inspected alias and refuses unrelated fields', async () => {
    const repair = tool('repair_gym_canonical_slug');
    const arguments_ = writeArguments.repair_gym_canonical_slug;
    for (const invalid of [
      { expectedAliasStateHash: undefined },
      { expectedAliasStateHash: 'stale' },
      { slug: 'INVALID URL' },
      { ownerId: 'another-owner' },
      { isPublic: false },
    ])
      expect(repair.inputSchema.safeParse({ ...arguments_, ...invalid }).success).toBe(false);
    await repair.run(arguments_, context);
    expect(domain.repairGymCanonicalSlug).toHaveBeenCalledWith(arguments_, context);
  });

  it('replays an identical canonical repair receipt without swapping slugs a second time', async () => {
    const principal: GymMcpPrincipal = {
      userId: context.userId!,
      clientId: 'admin-assistant',
      connectionId: 'admin-oauth-connection',
      connectionGeneration: 1,
      scopes: ['gyms:admin:write'],
      accessTokenHash: 'hash-only',
      connectionLastUsedAt: null,
    };
    const arguments_ = writeArguments.repair_gym_canonical_slug!;
    const result = { gymUuid, slug: 'approved-gym' };
    dispatch.receipt.mockResolvedValue([
      {
        operationName: 'repair_gym_canonical_slug',
        inputHash: gymMcpInputHash(arguments_),
        expiresAt: new Date(Date.now() + 60_000),
        result,
      },
    ]);
    await expect(executeGymMcpTool(principal, 'repair_gym_canonical_slug', arguments_)).resolves.toEqual(result);
    expect(domain.authorizeCanonicalSlugReplay).toHaveBeenCalledWith(
      arguments_,
      expect.objectContaining({ userId: principal.userId }),
    );
    expect(domain.repairGymCanonicalSlug).not.toHaveBeenCalled();
    expect(dispatch.insert).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'merge_duplicate_gyms',
      arguments_: gymMerge,
      duplicateKey: 'duplicateGymUuids',
      canonicalKey: 'canonicalGymUuid',
      stateKey: 'gymUuid',
      canonical: gymUuid,
      duplicate: duplicateGymUuid,
    },
    {
      name: 'merge_duplicate_gym_boards',
      arguments_: boardMerge,
      duplicateKey: 'duplicateBoardUuids',
      canonicalKey: 'canonicalBoardUuid',
      stateKey: 'boardUuid',
      canonical: boardUuid,
      duplicate: duplicateBoardUuid,
    },
  ])(
    'requires distinct records and exactly matching inspected state hashes for $name',
    ({ name, arguments_, duplicateKey, canonicalKey, stateKey, canonical, duplicate }) => {
      const schema = tool(name).inputSchema;
      expect(schema.safeParse(arguments_).success).toBe(true);
      for (const invalid of [
        { [duplicateKey]: [canonical] },
        { [duplicateKey]: [duplicate, duplicate] },
        { [duplicateKey]: [] },
        { [canonicalKey]: 'not-a-uuid' },
        { expectedStates: [{ [stateKey]: canonical, stateHash }] },
        {
          expectedStates: [
            { [stateKey]: canonical, stateHash },
            { [stateKey]: canonical, stateHash },
          ],
        },
        {
          expectedStates: [
            { [stateKey]: canonical, stateHash },
            { [stateKey]: idempotencyKey, stateHash },
          ],
        },
        {
          expectedStates: [
            { [stateKey]: canonical, stateHash },
            { [stateKey]: duplicate, stateHash: 'wrong' },
          ],
        },
      ])
        expect(schema.safeParse({ ...arguments_, ...invalid }).success).toBe(false);
    },
  );

  it('accepts a serial-less explicit board merge only with physical-wall confirmation', async () => {
    const merge = tool('merge_duplicate_gym_boards');
    for (const samePhysicalWall of [undefined, false])
      expect(merge.inputSchema.safeParse({ ...boardMerge, samePhysicalWall }).success).toBe(false);
    await merge.run(boardMerge, context);
    expect(domain.mergeDuplicateBoards).toHaveBeenCalledWith(
      {
        gymUuid,
        canonicalBoardUuid: boardUuid,
        duplicateBoardUuids: [duplicateBoardUuid],
        expectedStates: boardMerge.expectedStates,
        allowOwnershipChange: true,
        reason,
      },
      context,
    );
    expect(domain.mergeDuplicateBoards.mock.calls[0]?.[0]).not.toHaveProperty('serialNumber');
    expect(domain.mergeAdminGyms).not.toHaveBeenCalled();
  });

  it('defaults board ownership changes to refusal and forwards only an explicit acknowledgement', async () => {
    const merge = tool('merge_duplicate_gym_boards');
    await merge.run({ ...boardMerge, allowOwnershipChange: undefined }, context);
    expect(domain.mergeDuplicateBoards).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowOwnershipChange: false }),
      context,
    );
    await merge.run({ ...boardMerge, allowOwnershipChange: true }, context);
    expect(domain.mergeDuplicateBoards).toHaveBeenLastCalledWith(
      expect.objectContaining({ allowOwnershipChange: true }),
      context,
    );
    expect(merge.description).toContain('lose editing ownership');
    expect(merge.description).toContain('owner IDs/display names');
  });

  it('requires an explicit override before keeping system gym ownership', async () => {
    await tool('merge_duplicate_gyms').run(gymMerge, context);
    expect(domain.mergeAdminGyms).toHaveBeenCalledWith({ ...gymMerge, allowSystemCanonicalOverride: false }, context);
    expect(
      tool('merge_duplicate_gyms').inputSchema.safeParse({ ...gymMerge, allowSystemCanonicalOverride: true }).success,
    ).toBe(true);
  });

  it('rechecks live global authority on reads and every new write or receipt replay', async () => {
    const revoked = new GraphQLError('Global admin access revoked', { extensions: { code: 'FORBIDDEN' } });
    domain.assertGymMcpGlobalAdmin.mockRejectedValue(revoked);
    await expect(tool('inspect_gym_duplicates').run({ gymUuids: [gymUuid] }, context)).rejects.toBe(revoked);
    for (const [name, arguments_] of Object.entries(writeArguments)) {
      await expect(tool(name).run(arguments_, context)).rejects.toBe(revoked);
      await expect(tool(name).authorize(arguments_, context, false)).rejects.toBe(revoked);
      await expect(tool(name).authorize(arguments_, context, true)).rejects.toBe(revoked);
    }
    expect(domain.inspectGymDuplicates).not.toHaveBeenCalled();
    expect(domain.correctBoardSetup).not.toHaveBeenCalled();
    expect(domain.correctBoardLocationVisibility).not.toHaveBeenCalled();
    expect(domain.mergeAdminGyms).not.toHaveBeenCalled();
    expect(domain.mergeDuplicateBoards).not.toHaveBeenCalled();
    expect(domain.authorizeAdminMergeReplay).not.toHaveBeenCalled();
  });

  it('reauthorizes merged tombstones on retries instead of requiring active losers', async () => {
    await tool('merge_duplicate_gyms').authorize(gymMerge, context, true);
    expect(domain.authorizeAdminMergeReplay).toHaveBeenCalledWith('gym', gymUuid, [duplicateGymUuid], context);
    await tool('merge_duplicate_gym_boards').authorize(boardMerge, context, true);
    expect(domain.authorizeAdminMergeReplay).toHaveBeenCalledWith('board', boardUuid, [duplicateBoardUuid], context);
    expect(domain.mergeAdminGyms).not.toHaveBeenCalled();
    expect(domain.mergeDuplicateBoards).not.toHaveBeenCalled();
  });

  it('prepares administrative execution without performing a write during authorization', async () => {
    const prepared = await tool('correct_gym_board_location_visibility').authorize(
      writeArguments.correct_gym_board_location_visibility,
      context,
      false,
    );
    expect(domain.assertGymMcpGlobalAdmin).toHaveBeenCalledOnce();
    expect(domain.correctBoardLocationVisibility).not.toHaveBeenCalled();
    await expect(prepared()).resolves.toEqual({ saved: true });
    expect(domain.correctBoardLocationVisibility).toHaveBeenCalledWith(
      writeArguments.correct_gym_board_location_visibility,
      context,
    );
    expect(domain.authorizeAdminMergeReplay).not.toHaveBeenCalled();
  });

  it('dispatches a real admin action through its prepared executor and records the committed result', async () => {
    const principal: GymMcpPrincipal = {
      userId: context.userId!,
      clientId: 'admin-assistant',
      connectionId: 'admin-oauth-connection',
      connectionGeneration: 1,
      scopes: ['gyms:admin:write'],
      accessTokenHash: 'hash-only',
      connectionLastUsedAt: null,
    };
    await expect(
      executeGymMcpTool(
        principal,
        'correct_gym_board_location_visibility',
        writeArguments.correct_gym_board_location_visibility,
      ),
    ).resolves.toEqual({ saved: true });
    expect(domain.assertGymMcpGlobalAdmin).toHaveBeenCalledOnce();
    expect(domain.correctBoardLocationVisibility).toHaveBeenCalledOnce();
    expect(domain.correctBoardLocationVisibility).toHaveBeenCalledWith(
      writeArguments.correct_gym_board_location_visibility,
      expect.objectContaining({ userId: principal.userId, isAuthenticated: true }),
    );
    expect(dispatch.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        operationName: 'correct_gym_board_location_visibility',
        result: { saved: true },
      }),
    );
  });

  it('propagates stale-state refusals without attempting another repair', async () => {
    const stale = new GraphQLError('Inspect again; the board changed', { extensions: { code: 'CONFLICT' } });
    domain.correctBoardSetup.mockRejectedValueOnce(stale);
    await expect(tool('correct_gym_board_setup').run(writeArguments.correct_gym_board_setup, context)).rejects.toBe(
      stale,
    );
    expect(domain.correctBoardLocationVisibility).not.toHaveBeenCalled();
    expect(domain.mergeAdminGyms).not.toHaveBeenCalled();
    expect(domain.mergeDuplicateBoards).not.toHaveBeenCalled();
  });
});
