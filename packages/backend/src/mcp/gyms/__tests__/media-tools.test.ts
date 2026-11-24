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
  recordSource: vi.fn(),
  getSource: vi.fn(),
}));

vi.mock('../media', () => ({ prepareGymMcpImage: fixtures.prepare }));
vi.mock('../media-source', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../media-source')>()),
  recordGymImageSource: fixtures.recordSource,
  getGymImageSource: fixtures.getSource,
}));
vi.mock('../domain', () => ({ resolveGymForTool: fixtures.resolveGym, executeGymDocument: fixtures.execute }));
vi.mock('../dispatch', () => ({
  hasGymMcpWriteReceipt: fixtures.hasReceipt,
  executeGymMcpWriteAction: fixtures.runWrite,
  createGymMcpContext: () => ({ userId: 'owner', transport: 'http', isAuthenticated: true }),
}));

import { registerGymMcpMediaTools } from '../media-tools';
import { gymMcpMediaToolMetadata } from '../media-tool-metadata';
import { gymMcpCapabilities } from '../capabilities';

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
const mediaScopeCases: { scopes: string[] }[] = [
  { scopes: [] },
  { scopes: ['gyms:read'] },
  { scopes: ['gyms:write'] },
  { scopes: ['gyms:read', 'gyms:write'] },
  { scopes: ['gyms:admin:read'] },
];

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
    fixtures.resolveGym.mockResolvedValue({ id: 42, uuid: gymUuid, imageUrl: '/previous-photo.png', logoUrl: null });
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

  it.each(mediaScopeCases)(
    'keeps actual media registration and advertised metadata aligned for scopes $scopes',
    async ({ scopes }) => {
      const server = new McpServer({ name: 'media-metadata-test', version: '1' });
      const register = vi.spyOn(server, 'registerTool');
      try {
        registerGymMcpMediaTools(server, { ...principal, scopes });
        const expected = gymMcpMediaToolMetadata.filter((tool) => scopes.includes(tool.scope));
        const registered = register.mock.calls.map(([name]) => name);
        expect(registered).toEqual(expected.map((tool) => tool.name));
        const capabilities = gymMcpCapabilities(scopes, null, []);
        expect(capabilities.actions.map(({ name, requiredScope }) => ({ name, scope: requiredScope }))).toEqual(
          gymMcpMediaToolMetadata.map(({ name, scope }) => ({ name, scope })),
        );
        expect(capabilities.actions.filter((action) => action.available).map((action) => action.name)).toEqual(
          registered,
        );
      } finally {
        await server.close();
      }
    },
  );

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
    expect(fixtures.recordSource).toHaveBeenCalledWith({
      gymId: 42,
      gymUuid,
      actorUserId: 'owner',
      kind: 'photo',
      previousUrl: '/previous-photo.png',
      storedUrl,
      source: { imageUrl: input.imageUrl },
    });
  });

  it('records explicit source credit inside the same write as the saved photo', async () => {
    const attribution = {
      pageUrl: 'https://gym.example/photos',
      credit: 'Gym photographer',
      license: 'Used with permission',
    };
    await callImageTool('set_gym_image', { ...input, attribution });
    expect(fixtures.recordSource).toHaveBeenCalledWith(
      expect.objectContaining({ source: { imageUrl: input.imageUrl, attribution } }),
    );
    expect(fixtures.runWrite).toHaveBeenCalledWith(
      principal,
      'set_gym_image',
      expect.objectContaining({ attribution }),
      'gyms:write',
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('reads current source information only after gym authorization', async () => {
    fixtures.getSource.mockResolvedValue({ gymUuid, kind: 'photo', storedUrl, source: { imageUrl: input.imageUrl } });
    const result = await callImageTool('get_gym_image_source', { gymUuid, kind: 'photo' });
    expect(result.result.structuredContent).toMatchObject({ source: { imageUrl: input.imageUrl } });
    expect(fixtures.getSource).toHaveBeenCalledWith(gymUuid, 'photo', '/previous-photo.png');
    fixtures.getSource.mockClear();
    fixtures.resolveGym.mockRejectedValueOnce(new Error('Not authorized'));
    expect((await callImageTool('get_gym_image_source', { gymUuid, kind: 'photo' })).result.isError).toBe(true);
    expect(fixtures.getSource).not.toHaveBeenCalled();
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
    expect(fixtures.recordSource).not.toHaveBeenCalled();
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
