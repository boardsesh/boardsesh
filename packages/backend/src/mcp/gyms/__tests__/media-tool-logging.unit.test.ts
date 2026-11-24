import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { GraphQLError } from 'graphql';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GymMcpPrincipal } from '../auth';

const fixtures = vi.hoisted(() => ({
  hasReceipt: vi.fn(),
  prepare: vi.fn(),
  discard: vi.fn(),
  resolveGym: vi.fn(),
  execute: vi.fn(),
  runWrite: vi.fn(),
  log: vi.fn(),
}));
vi.mock('../media', () => ({ prepareGymMcpImage: fixtures.prepare }));
vi.mock('../media-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media-source')>()),
  recordGymImageSource: vi.fn(),
}));
vi.mock('../domain', () => ({ resolveGymForTool: fixtures.resolveGym, executeGymDocument: fixtures.execute }));
vi.mock('../dispatch', () => ({
  hasGymMcpWriteReceipt: fixtures.hasReceipt,
  executeGymMcpWriteAction: fixtures.runWrite,
  createGymMcpContext: () => ({ userId: 'owner' }),
}));
vi.mock('../../../utils/logger', () => ({ logger: { info: fixtures.log } }));
vi.mock('../../../graphql/mask-error', () => ({ isDatabaseLeakError: () => false }));

import { registerGymMcpMediaTools } from '../media-tools';

const gymUuid = '11111111-1111-4111-8111-111111111111';
const storedUrl = `/static/gym-photos/${gymUuid}.22222222-2222-4222-8222-222222222222.png`;
const input = {
  gymUuid,
  kind: 'photo',
  idempotencyKey: '33333333-3333-4333-8333-333333333333',
  confirm: true,
  imageUrl: 'https://images.example/private-path-marker.png?private-query-marker=secret',
};
const principal: GymMcpPrincipal = {
  clientId: 'assistant',
  userId: 'owner',
  connectionId: 'connection',
  connectionGeneration: 1,
  scopes: ['gyms:read', 'gyms:write'],
  accessTokenHash: 'private-token-marker',
  connectionLastUsedAt: null,
};

async function callTool(name: string) {
  const server = new McpServer({ name: 'media-logging', version: '1' });
  registerGymMcpMediaTools(server, principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const { imageUrl: _imageUrl, ...removal } = input;
    const response = await transport.handleRequest(
      new Request('https://api.boardsesh.com/mcp/gyms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name, arguments: name === 'set_gym_image' ? input : removal },
        }),
      }),
    );
    return (await response.json()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
  } finally {
    await server.close();
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  fixtures.hasReceipt.mockResolvedValue(false);
  fixtures.prepare.mockResolvedValue({ storedUrl, discard: fixtures.discard });
  fixtures.resolveGym.mockResolvedValue({ uuid: gymUuid });
  fixtures.runWrite.mockImplementation(
    async (_principal, _name, _arguments, _scope, work: () => Promise<unknown>, authorize: () => Promise<void>) => {
      await authorize();
      return work();
    },
  );
});

describe('gym MCP image tool outcome events', () => {
  it.each(['set_gym_image', 'remove_gym_image'])('records bounded success metadata for %s', async (tool) => {
    expect((await callTool(tool)).result.isError).not.toBe(true);
    expect(fixtures.log).toHaveBeenCalledExactlyOnceWith('Gym MCP tool completed', {
      tool,
      status: 'success',
      code: undefined,
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(fixtures.log.mock.calls)).not.toMatch(/private-|https:|storedUrl|owner/);
  });

  it.each(['set_gym_image', 'remove_gym_image'])(
    'records the typed failure code without tool inputs for %s',
    async (tool) => {
      fixtures.runWrite.mockRejectedValue(
        new GraphQLError('private-error-description-marker', { extensions: { code: 'FORBIDDEN' } }),
      );
      expect((await callTool(tool)).result.isError).toBe(true);
      expect(fixtures.log).toHaveBeenCalledExactlyOnceWith('Gym MCP tool completed', {
        tool,
        status: 'error',
        code: 'FORBIDDEN',
        durationMs: expect.any(Number),
      });
      expect(JSON.stringify(fixtures.log.mock.calls)).not.toMatch(/private-|https:|storedUrl|owner/);
    },
  );

  it('records successful replay without preparing or attaching another image', async () => {
    fixtures.hasReceipt.mockResolvedValue(true);
    fixtures.runWrite.mockResolvedValue({ gymUuid, kind: 'photo', storedUrl });
    expect((await callTool('set_gym_image')).result.structuredContent).toMatchObject({ storedUrl });
    expect(fixtures.prepare).not.toHaveBeenCalled();
    expect(fixtures.execute).not.toHaveBeenCalled();
    expect(fixtures.log).toHaveBeenCalledWith(
      'Gym MCP tool completed',
      expect.objectContaining({ tool: 'set_gym_image', status: 'success' }),
    );
  });

  it('keeps the action failure and its event when staged cleanup also fails', async () => {
    fixtures.runWrite.mockRejectedValue(new GraphQLError('Permission removed', { extensions: { code: 'FORBIDDEN' } }));
    fixtures.discard.mockRejectedValue(new Error('Storage unavailable'));
    expect((await callTool('set_gym_image')).result.isError).toBe(true);
    expect(fixtures.discard).toHaveBeenCalledOnce();
    expect(fixtures.log).toHaveBeenCalledExactlyOnceWith(
      'Gym MCP tool completed',
      expect.objectContaining({ tool: 'set_gym_image', status: 'error', code: 'FORBIDDEN' }),
    );
  });
});
