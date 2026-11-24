import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GraphQLError } from 'graphql';
import type { GymMcpPrincipal } from '../auth';
import type { GymMcpTool } from '../registry';

const mocks = vi.hoisted(() => ({
  registerTool: vi.fn(),
  hasAdmin: vi.fn(),
  execute: vi.fn(),
  media: vi.fn(),
  failure: vi.fn(),
  recordResult: vi.fn(),
  tools: [] as GymMcpTool[],
}));
vi.mock('@modelcontextprotocol/server', () => ({
  McpServer: class {
    registerTool = mocks.registerTool;
  },
}));
vi.mock('../registry', () => ({
  get gymMcpTools() {
    return mocks.tools;
  },
}));
vi.mock('../dispatch', () => ({ executeGymMcpTool: mocks.execute }));
vi.mock('../media-tools', () => ({ registerGymMcpMediaTools: mocks.media }));
vi.mock('../tool-result', () => ({ gymMcpToolFailure: mocks.failure, recordGymMcpToolResult: mocks.recordResult }));
vi.mock('../../../graphql/resolvers/social/roles', () => ({ hasAdmin: mocks.hasAdmin }));
vi.mock('../admin-domain', () => ({
  assertGymMcpGlobalAdmin: vi.fn(),
  authorizeAdminMergeReplay: vi.fn(),
  correctBoardLocationVisibility: vi.fn(),
  correctBoardSetup: vi.fn(),
  inspectGymDuplicates: vi.fn(),
  mergeAdminGyms: vi.fn(),
  repairGymCanonicalSlug: vi.fn(),
  authorizeCanonicalSlugReplay: vi.fn(),
}));
vi.mock('../../../services/merge-duplicate-boards', () => ({ mergeDuplicateBoards: vi.fn() }));

import { gymMcpAdminTools } from '../admin-tools';
import { createGymMcpServer } from '../server';

const principal: GymMcpPrincipal = {
  userId: 'admin-actor',
  clientId: 'assistant-client',
  connectionId: 'oauth-connection',
  connectionGeneration: 4,
  scopes: ['gyms:read', 'gyms:write'],
  accessTokenHash: 'hash-only',
  connectionLastUsedAt: null,
};
const inspectionName = 'inspect_gym_duplicates';
const capabilityName = 'get_gym_mcp_capabilities';
const writeNames = gymMcpAdminTools.filter((tool) => !tool.readOnly).map((tool) => tool.name);

function advertisedNames(): string[] {
  return mocks.registerTool.mock.calls.map((call) => String(call[0]));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasAdmin.mockResolvedValue(true);
  mocks.execute.mockResolvedValue({ repaired: true });
  mocks.failure.mockImplementation(() => ({ isError: true, content: [{ type: 'text', text: 'Access revoked' }] }));
  mocks.tools.splice(
    0,
    mocks.tools.length,
    {
      name: 'list_managed_gyms',
      description: 'List managed gyms',
      category: 'overview',
      scope: 'gyms:read',
      readOnly: true,
      destructive: false,
      inputSchema: z.object({}).strict(),
      authorize: async () => async () => ({}),
      run: async () => ({}),
    },
    ...gymMcpAdminTools,
  );
});

describe('hosted gym administrative tool advertisement', () => {
  it('never advertises admin actions on an ordinary connection, even for an admin account', async () => {
    await createGymMcpServer(principal);
    expect(advertisedNames()).toEqual([capabilityName, 'list_managed_gyms']);
    expect(mocks.hasAdmin).not.toHaveBeenCalled();
    expect(mocks.media).toHaveBeenCalledWith(expect.any(Object), principal);
  });

  it('returns identical ordinary capabilities for admin and non-admin accounts without reading their role', async () => {
    const responses: unknown[] = [];
    for (const accountHasAdmin of [true, false]) {
      mocks.hasAdmin.mockResolvedValue(accountHasAdmin);
      mocks.registerTool.mockClear();
      await createGymMcpServer({ ...principal, userId: `account-${accountHasAdmin}` });
      const registration = mocks.registerTool.mock.calls.find(([name]) => name === capabilityName);
      const handler = registration?.[2] as () => Promise<{ structuredContent: Record<string, unknown> }>;
      responses.push((await handler()).structuredContent);
    }
    expect(responses[0]).toEqual(responses[1]);
    expect(responses[0]).toMatchObject({ isGlobalAdmin: null });
    expect(mocks.hasAdmin).not.toHaveBeenCalled();
  });

  it('advertises only the explicitly granted admin category', async () => {
    await createGymMcpServer({ ...principal, scopes: ['gyms:read', 'gyms:admin:read'] });
    expect(advertisedNames()).toEqual([capabilityName, 'list_managed_gyms', inspectionName]);
    expect(mocks.hasAdmin).toHaveBeenCalledWith(principal.userId);
    mocks.registerTool.mockClear();
    await createGymMcpServer({ ...principal, scopes: ['gyms:read', 'gyms:admin:write'] });
    expect(advertisedNames()).toEqual([capabilityName, 'list_managed_gyms', ...writeNames]);
  });

  it('hides administrative tools immediately when global authority is revoked', async () => {
    mocks.hasAdmin.mockResolvedValue(false);
    await createGymMcpServer({ ...principal, scopes: ['gyms:read', 'gyms:admin:read', 'gyms:admin:write'] });
    expect(advertisedNames()).toEqual([capabilityName, 'list_managed_gyms']);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('declares repairs destructive and audits read-only, with retry-safe annotations', async () => {
    await createGymMcpServer({ ...principal, scopes: ['gyms:admin:read', 'gyms:admin:write'] });
    for (const [name, options] of mocks.registerTool.mock.calls) {
      expect(options).toMatchObject({
        annotations: {
          readOnlyHint: name === inspectionName || name === capabilityName,
          destructiveHint: name !== inspectionName && name !== capabilityName,
          idempotentHint: true,
          openWorldHint: false,
        },
      });
    }
  });

  it('explains hidden writes on ordinary and admin-only connections', async () => {
    await createGymMcpServer({ ...principal, scopes: ['gyms:admin:read'] });
    const registration = mocks.registerTool.mock.calls.find(([name]) => name === capabilityName);
    const handler = registration?.[2] as () => Promise<{ structuredContent: Record<string, unknown> }>;
    expect((await handler()).structuredContent).toMatchObject({
      grantedScopes: ['gyms:admin:read'],
      isGlobalAdmin: true,
      actions: expect.arrayContaining([
        expect.objectContaining({ name: 'set_gym_image', requiredScope: 'gyms:write', available: false }),
        expect.objectContaining({
          name: 'repair_gym_canonical_slug',
          requiredScope: 'gyms:admin:write',
          available: false,
        }),
      ]),
    });
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('routes calls through the authenticated dispatcher rather than a caller-selected actor', async () => {
    const adminPrincipal = { ...principal, scopes: ['gyms:admin:read'] };
    await createGymMcpServer(adminPrincipal);
    const registration = mocks.registerTool.mock.calls.find(([name]) => name === inspectionName);
    const handler = registration?.[2] as (arguments_: Record<string, unknown>) => Promise<unknown>;
    const arguments_ = { gymUuids: ['00000000-0000-4000-8000-000000000001'] };
    await expect(handler(arguments_)).resolves.toMatchObject({ structuredContent: { repaired: true } });
    expect(mocks.execute).toHaveBeenCalledWith(adminPrincipal, inspectionName, arguments_);
    expect(mocks.recordResult).toHaveBeenCalledWith(inspectionName, 'success', expect.any(Number));
  });

  it('still refuses execution if global authority is revoked after discovery', async () => {
    await createGymMcpServer({ ...principal, scopes: ['gyms:admin:write'] });
    const registration = mocks.registerTool.mock.calls.find(([name]) => name === 'merge_duplicate_gym_boards');
    const handler = registration?.[2] as (arguments_: Record<string, unknown>) => Promise<unknown>;
    const revoked = new GraphQLError('Global admin revoked', { extensions: { code: 'FORBIDDEN' } });
    mocks.execute.mockRejectedValueOnce(revoked);
    await expect(handler({})).resolves.toMatchObject({ isError: true });
    expect(mocks.failure).toHaveBeenCalledWith(revoked, 'merge_duplicate_gym_boards', expect.any(Number));
    expect(mocks.recordResult).not.toHaveBeenCalled();
  });
});
