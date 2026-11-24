import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { GymMcpPrincipal } from '../auth';

const mocks = vi.hoisted(() => ({
  receipt: vi.fn(),
  insert: vi.fn(),
  write: vi.fn(),
  authorize: vi.fn(),
  run: vi.fn(),
  findTool: vi.fn(),
}));
vi.mock('../../../db/client', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.receipt }) }) }),
    insert: () => ({ values: mocks.insert }),
  },
}));
vi.mock('../auth', () => ({ withGymMcpWrite: mocks.write }));
vi.mock('../registry', () => ({ findGymMcpTool: mocks.findTool }));

import { createGymMcpContext, executeGymMcpTool, executeGymMcpWriteAction, gymMcpInputHash } from '../dispatch';

const principal: GymMcpPrincipal = {
  userId: 'actor',
  clientId: 'assistant',
  connectionId: 'connection',
  connectionGeneration: 2,
  scopes: ['gyms:read', 'gyms:write'],
  accessTokenHash: 'hashed-secret',
  connectionLastUsedAt: null,
};
const arguments_ = {
  gymUuid: '00000000-0000-4000-8000-000000000001',
  idempotencyKey: '00000000-0000-4000-8000-000000000002',
  body: 'See you tonight',
};
const result = { comment: { uuid: 'new-comment', body: 'See you tonight' } };
function receipt(overrides: Record<string, unknown> = {}) {
  return {
    operationName: 'add_gym_comment',
    inputHash: gymMcpInputHash(arguments_),
    result,
    expiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

describe('gym MCP mutation receipts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.write.mockImplementation((_principal, _scope, work: () => Promise<unknown>) => work());
    mocks.receipt.mockResolvedValue([]);
    mocks.insert.mockResolvedValue(undefined);
    mocks.authorize.mockResolvedValue(undefined);
    mocks.run.mockResolvedValue(result);
  });

  it('records the result inside the same authorized transaction as the action', async () => {
    await expect(
      executeGymMcpWriteAction(principal, 'add_gym_comment', arguments_, 'gyms:write', mocks.run, mocks.authorize),
    ).resolves.toEqual(result);
    expect(mocks.write).toHaveBeenCalledWith(principal, 'gyms:write', expect.any(Function));
    expect(mocks.authorize).toHaveBeenCalledWith(false);
    expect(mocks.run).toHaveBeenCalledOnce();
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: principal.userId,
        clientId: principal.clientId,
        connectionGeneration: 2,
        operationName: 'add_gym_comment',
        result,
      }),
    );
  });

  it('runs the prepared action once without repeating the registry authorization pass', async () => {
    const prepared = vi.fn(async () => result);
    mocks.authorize.mockResolvedValue(prepared);
    mocks.findTool.mockReturnValue({
      name: 'add_gym_comment',
      scope: 'gyms:write',
      readOnly: false,
      inputSchema: z.object({ gymUuid: z.string(), idempotencyKey: z.string(), body: z.string() }),
      authorize: mocks.authorize,
      run: mocks.run,
    });
    await expect(executeGymMcpTool(principal, 'add_gym_comment', arguments_)).resolves.toEqual(result);
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(prepared).toHaveBeenCalledOnce();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('does not allow deleted-resource replay exceptions for a mismatched receipt', async () => {
    mocks.receipt.mockResolvedValue([receipt({ operationName: 'delete_gym_board' })]);
    await expect(
      executeGymMcpWriteAction(principal, 'add_gym_comment', arguments_, 'gyms:write', mocks.run, mocks.authorize),
    ).rejects.toMatchObject({ extensions: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(mocks.authorize).toHaveBeenCalledWith(false);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('rechecks current gym authority before replay and does not repeat the action', async () => {
    mocks.receipt.mockResolvedValue([receipt()]);
    await expect(
      executeGymMcpWriteAction(principal, 'add_gym_comment', arguments_, 'gyms:write', mocks.run, mocks.authorize),
    ).resolves.toEqual(result);
    expect(mocks.authorize).toHaveBeenCalledWith(true);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();

    mocks.authorize.mockRejectedValueOnce(new Error('Gym access revoked'));
    await expect(
      executeGymMcpWriteAction(principal, 'add_gym_comment', arguments_, 'gyms:write', mocks.run, mocks.authorize),
    ).rejects.toThrow('revoked');
  });

  it('requests the grade collection snapshot at the outer write boundary', async () => {
    await executeGymMcpWriteAction(
      principal,
      'set_gym_grade_collection',
      arguments_,
      'gyms:write',
      mocks.run,
      mocks.authorize,
    );
    expect(mocks.write).toHaveBeenCalledWith(principal, 'gyms:write', expect.any(Function), {
      isolationLevel: 'repeatable read',
    });
  });

  it('restarts a stale grade receipt snapshot and reauthorizes before returning the committed result', async () => {
    const gradeReceipt = receipt({ operationName: 'set_gym_grade_collection' });
    mocks.receipt.mockResolvedValueOnce([]).mockResolvedValueOnce([gradeReceipt]);
    mocks.insert.mockRejectedValueOnce({ cause: { code: '23505' } });
    await expect(
      executeGymMcpWriteAction(
        principal,
        'set_gym_grade_collection',
        arguments_,
        'gyms:write',
        mocks.run,
        mocks.authorize,
      ),
    ).resolves.toEqual(result);
    expect(mocks.write).toHaveBeenCalledTimes(2);
    expect(mocks.authorize.mock.calls).toEqual([[false], [true]]);
    expect(mocks.run).toHaveBeenCalledOnce();
  });

  it('retries grade serialization refusals once and keeps authorization failures final', async () => {
    const unavailable = new GraphQLError('Grade comparison is temporarily unavailable', {
      extensions: { code: 'TEMPORARILY_UNAVAILABLE' },
    });
    mocks.write.mockRejectedValueOnce(unavailable).mockRejectedValueOnce(unavailable);
    await expect(
      executeGymMcpWriteAction(principal, 'set_gym_grade_collection', arguments_, 'gyms:write', mocks.run),
    ).rejects.toBe(unavailable);
    expect(mocks.write).toHaveBeenCalledTimes(2);
    mocks.write.mockClear();
    const forbidden = new GraphQLError('Access revoked', { extensions: { code: 'FORBIDDEN' } });
    mocks.write.mockRejectedValueOnce(forbidden);
    await expect(
      executeGymMcpWriteAction(principal, 'set_gym_grade_collection', arguments_, 'gyms:write', mocks.run),
    ).rejects.toBe(forbidden);
    expect(mocks.write).toHaveBeenCalledOnce();
  });

  it('refuses changed input, changed operations, and expired keys without executing', async () => {
    for (const stored of [
      receipt({ inputHash: 'different' }),
      receipt({ operationName: 'delete_gym_kiosk' }),
      receipt({ expiresAt: new Date(0), result: null }),
    ]) {
      mocks.receipt.mockResolvedValueOnce([stored]);
      await expect(
        executeGymMcpWriteAction(principal, 'add_gym_comment', arguments_, 'gyms:write', mocks.run, mocks.authorize),
      ).rejects.toThrow();
    }
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('checks connection revocation before reading any prior private result', async () => {
    mocks.write.mockRejectedValueOnce(new Error('Reconnect your assistant'));
    await expect(
      executeGymMcpWriteAction(principal, 'add_gym_comment', arguments_, 'gyms:write', mocks.run, mocks.authorize),
    ).rejects.toThrow('Reconnect');
    expect(mocks.receipt).not.toHaveBeenCalled();
  });

  it.each(['inspect_gym_duplicates', 'merge_duplicate_gym_boards'])(
    'does not let ordinary gym consent execute %s',
    async (name) => {
      mocks.findTool.mockReturnValue({
        name,
        scope: name.startsWith('inspect_') ? 'gyms:admin:read' : 'gyms:admin:write',
        readOnly: name.startsWith('inspect_'),
        inputSchema: z.object({}),
        run: mocks.run,
        authorize: mocks.authorize,
      });
      await expect(executeGymMcpTool(principal, name, {})).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN' } });
      expect(mocks.write).not.toHaveBeenCalled();
      expect(mocks.receipt).not.toHaveBeenCalled();
      expect(mocks.run).not.toHaveBeenCalled();
    },
  );

  it('replays an administrative merge receipt only after live tombstone authorization', async () => {
    const name = 'merge_duplicate_gym_boards';
    const adminPrincipal = { ...principal, scopes: ['gyms:admin:write'] };
    const mergeResult = { canonicalBoardUuid: 'survivor', mergedBoardUuids: ['merged-tombstone'] };
    mocks.findTool.mockReturnValue({
      name,
      scope: 'gyms:admin:write',
      readOnly: false,
      inputSchema: z.object({ gymUuid: z.string(), idempotencyKey: z.string(), body: z.string() }).strict(),
      run: mocks.run,
      authorize: mocks.authorize,
    });
    mocks.receipt.mockResolvedValue([receipt({ operationName: name, result: mergeResult })]);
    await expect(executeGymMcpTool(adminPrincipal, name, arguments_)).resolves.toEqual(mergeResult);
    expect(mocks.authorize).toHaveBeenCalledWith(
      arguments_,
      expect.objectContaining({ userId: principal.userId }),
      true,
    );
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    const revoked = new GraphQLError('Global admin revoked', { extensions: { code: 'FORBIDDEN' } });
    mocks.authorize.mockRejectedValueOnce(revoked);
    await expect(executeGymMcpTool(adminPrincipal, name, arguments_)).rejects.toBe(revoked);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('keeps inspected-state changes distinct from retries of an administrative repair', async () => {
    const name = 'correct_gym_board_location_visibility';
    const adminPrincipal = { ...principal, scopes: ['gyms:admin:write'] };
    const repair = { ...arguments_, expectedStateHash: 'a'.repeat(64), hideLocation: false };
    mocks.findTool.mockReturnValue({
      name,
      scope: 'gyms:admin:write',
      readOnly: false,
      inputSchema: z
        .object({
          gymUuid: z.string(),
          idempotencyKey: z.string(),
          body: z.string(),
          expectedStateHash: z.string(),
          hideLocation: z.boolean(),
        })
        .strict(),
      run: mocks.run,
      authorize: mocks.authorize,
    });
    mocks.receipt.mockResolvedValue([receipt({ operationName: name, inputHash: gymMcpInputHash(repair) })]);
    await expect(
      executeGymMcpTool(adminPrincipal, name, { ...repair, expectedStateHash: 'b'.repeat(64) }),
    ).rejects.toMatchObject({ extensions: { code: 'IDEMPOTENCY_CONFLICT' } });
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('hashes equivalent object-key orders equally, but distinguishes changes and array order', () => {
    expect(gymMcpInputHash({ gymUuid: 'gym', changes: { name: 'Name', address: null } })).toBe(
      gymMcpInputHash({ changes: { address: null, name: 'Name' }, gymUuid: 'gym' }),
    );
    expect(gymMcpInputHash({ slots: ['one', 'two'] })).not.toBe(gymMcpInputHash({ slots: ['two', 'one'] }));
    expect(gymMcpInputHash({ body: 'first' })).not.toBe(gymMcpInputHash({ body: 'second' }));
  });

  it('requires the registered scope and builds no cron/controller/session authority', async () => {
    mocks.findTool.mockReturnValue({
      name: 'grant_gym_edit_access',
      scope: 'gyms:access:write',
      readOnly: false,
      inputSchema: z.object({}),
      run: mocks.run,
      authorize: mocks.authorize,
    });
    await expect(executeGymMcpTool(principal, 'grant_gym_edit_access', {})).rejects.toMatchObject({
      message: 'Reconnect to Boardsesh and request gyms:access:write to use grant_gym_edit_access.',
      extensions: { code: 'FORBIDDEN', requiredScope: 'gyms:access:write' },
    });
    expect(mocks.run).not.toHaveBeenCalled();
    expect(createGymMcpContext(principal)).toMatchObject({
      userId: 'actor',
      isAuthenticated: true,
      transport: 'http',
      isCronAuthenticated: false,
    });
    expect(createGymMcpContext(principal).controllerId).toBeUndefined();
    expect(createGymMcpContext(principal).webSignIn).toBeUndefined();
  });
});
