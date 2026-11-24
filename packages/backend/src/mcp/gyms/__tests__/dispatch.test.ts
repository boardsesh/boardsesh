import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
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
    await expect(executeGymMcpTool(principal, 'grant_gym_edit_access', {})).rejects.toThrow('allow');
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
