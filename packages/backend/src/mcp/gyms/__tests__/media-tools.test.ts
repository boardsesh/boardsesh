import { McpServer, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import type { GymMcpPrincipal } from '../auth';

const fixtures = vi.hoisted(() => ({
  hasReceipt: vi.fn(),
  prepare: vi.fn(),
  discard: vi.fn(),
  resolveGym: vi.fn(),
  execute: vi.fn(),
  runWrite: vi.fn(),
}));

vi.mock('../media', () => ({ prepareGymMcpImage: fixtures.prepare }));
vi.mock('../domain', () => ({ resolveGymForTool: fixtures.resolveGym, executeGymDocument: fixtures.execute }));
vi.mock('../dispatch', () => ({
  hasGymMcpWriteReceipt: fixtures.hasReceipt,
  executeGymMcpWriteAction: fixtures.runWrite,
  createGymMcpContext: () => ({ userId: 'owner', transport: 'http', isAuthenticated: true }),
}));

import { registerGymMcpMediaTools } from '../media-tools';

const gymUuid = '11111111-1111-4111-8111-111111111111';
const storedUrl = `/static/gym-photos/${gymUuid}.22222222-2222-4222-8222-222222222222.png`;
const principal: GymMcpPrincipal = {
  userId: 'owner',
  clientId: 'assistant',
  connectionId: 'connection',
  connectionGeneration: 1,
  scopes: ['gyms:read', 'gyms:write'],
  accessTokenHash: 'test-hash',
  connectionLastUsedAt: null,
};

async function callImageTool(name: string, arguments_: Record<string, unknown>) {
  const server = new McpServer({ name: 'gym-media-test', version: '1.0.0' });
  registerGymMcpMediaTools(server, principal);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(
      new Request('https://api.boardsesh.com/mcp/gyms', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-11-25',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: arguments_ } }),
      }),
    );
    return (await response.json()) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } };
  } finally {
    await server.close();
  }
}

describe('gym image action retries', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.hasReceipt.mockResolvedValue(false);
    fixtures.prepare.mockResolvedValue({ storedUrl, discard: fixtures.discard });
    fixtures.resolveGym.mockResolvedValue({ uuid: gymUuid });
    fixtures.execute.mockResolvedValue({ updateGym: { uuid: gymUuid } });
    fixtures.runWrite.mockImplementation(
      async (
        _principal: unknown,
        _name: unknown,
        _arguments: unknown,
        _scope: unknown,
        work: () => Promise<unknown>,
        authorize: () => Promise<void>,
      ) => {
        await authorize();
        return work();
      },
    );
  });

  const input = {
    gymUuid,
    kind: 'photo',
    idempotencyKey: '33333333-3333-4333-8333-333333333333',
    imageUrl: 'https://images.example/photo.png',
    confirm: true,
  };

  it('publishes a prepared unique image through the authorized gym update', async () => {
    const result = await callImageTool('set_gym_image', input);
    expect(result.result.structuredContent).toEqual({ gymUuid, kind: 'photo', storedUrl });
    expect(fixtures.resolveGym).toHaveBeenCalledWith(gymUuid, 'owner', true, true);
    expect(fixtures.execute).toHaveBeenCalledWith(
      'updateGym',
      { input: { gymUuid, imageUrl: storedUrl } },
      expect.objectContaining({ userId: 'owner' }),
    );
    expect(fixtures.discard).not.toHaveBeenCalled();
  });

  it('replays a saved image change even when the original image URL is gone', async () => {
    fixtures.hasReceipt.mockResolvedValue(true);
    fixtures.prepare.mockRejectedValue(new Error('The remote source is now gone'));
    fixtures.runWrite.mockImplementation(
      async (
        _principal: unknown,
        _name: unknown,
        _arguments: unknown,
        _scope: unknown,
        _work: unknown,
        authorize: () => Promise<void>,
      ) => {
        await authorize();
        return { gymUuid, kind: 'photo', storedUrl };
      },
    );
    const result = await callImageTool('set_gym_image', input);
    expect(result.result.isError).not.toBe(true);
    expect(result.result.structuredContent).toMatchObject({ storedUrl });
    expect(fixtures.prepare).not.toHaveBeenCalled();
    expect(fixtures.execute).not.toHaveBeenCalled();
  });

  it('discards a staged object if authority or the final write fails', async () => {
    fixtures.runWrite.mockRejectedValue(new Error('The role was revoked while uploading'));
    const result = await callImageTool('set_gym_image', input);
    expect(result.result.isError).toBe(true);
    expect(fixtures.discard).toHaveBeenCalledOnce();
    expect(fixtures.execute).not.toHaveBeenCalled();
  });

  it('requires acknowledgement before clearing an image', async () => {
    const { imageUrl: _imageUrl, ...removal } = input;
    const result = await callImageTool('remove_gym_image', { ...removal, confirm: false });
    expect(result.result.isError).toBe(true);
    expect(fixtures.runWrite).not.toHaveBeenCalled();
  });
});
