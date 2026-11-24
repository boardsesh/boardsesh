import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GymMcpPrincipal } from '../auth';

const fixtures = vi.hoisted(() => ({
  hasAdmin: vi.fn(),
  execute: vi.fn(),
  prepareImage: vi.fn(),
  write: vi.fn(),
}));
vi.mock('../../../graphql/resolvers/social/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../graphql/resolvers/social/roles')>()),
  hasAdmin: fixtures.hasAdmin,
}));
vi.mock('../dispatch', () => ({
  executeGymMcpTool: fixtures.execute,
  createGymMcpContext: vi.fn(),
  executeGymMcpWriteAction: fixtures.write,
  hasGymMcpWriteReceipt: vi.fn(),
}));
vi.mock('../media', () => ({ prepareGymMcpImage: fixtures.prepareImage }));

import { createGymMcpHandler } from '../transport';
import { createGymMcpServer } from '../server';

const principal: GymMcpPrincipal = {
  userId: 'directory-admin',
  clientId: 'assistant-client',
  connectionId: 'hidden-tool-connection',
  connectionGeneration: 1,
  scopes: ['gyms:read'],
  accessTokenHash: 'test-hash',
  connectionLastUsedAt: null,
};

function handlerFor(scopes = principal.scopes) {
  return createGymMcpHandler({
    mode: 'on',
    partnerMode: 'open',
    authenticate: async () => ({ principal: { ...principal, scopes } }),
    createServer: createGymMcpServer,
  });
}

async function send(handler: ReturnType<typeof handlerFor>, method: string, params?: Record<string, unknown>) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) });
  const incoming = Readable.from([Buffer.from(body)]) as unknown as IncomingMessage;
  incoming.url = '/mcp/gyms';
  incoming.method = 'POST';
  incoming.headers = {
    host: 'api.boardsesh.com',
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    authorization: 'Bearer test-access-token',
    'mcp-protocol-version': '2025-11-25',
  };
  incoming.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket'];
  let responseBody = '';
  const response = {
    statusCode: 200,
    headersSent: false,
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
    },
    end(content?: Buffer | string) {
      responseBody = content?.toString() ?? '';
    },
  };
  await handler(incoming, response as unknown as ServerResponse);
  expect(response.statusCode).toBe(200);
  return JSON.parse(responseBody) as {
    result?: {
      tools?: { name: string }[];
      isError?: boolean;
      content?: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
    };
    error?: { code: number; message: string };
  };
}

function expectForbidden(response: Awaited<ReturnType<typeof send>>, expectedMessage: string) {
  expect(response.error).toBeUndefined();
  expect(response.result?.isError).toBe(true);
  expect(JSON.parse(response.result!.content![0]!.text)).toEqual({
    error: { code: 'FORBIDDEN', message: expect.stringContaining(expectedMessage) },
  });
  expect(fixtures.execute).not.toHaveBeenCalled();
  expect(fixtures.prepareImage).not.toHaveBeenCalled();
  expect(fixtures.write).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.hasAdmin.mockResolvedValue(true);
  fixtures.execute.mockResolvedValue({ saved: true });
});

describe('real SDK calls to undiscoverable gym tools', () => {
  it('keeps ordinary capabilities and admin-call denials independent of the account global role', async () => {
    const capabilities: unknown[] = [];
    const denials: unknown[] = [];
    for (const accountHasAdmin of [true, false]) {
      fixtures.hasAdmin.mockResolvedValue(accountHasAdmin);
      const handler = handlerFor();
      capabilities.push((await send(handler, 'tools/call', { name: 'get_gym_mcp_capabilities' })).result);
      denials.push((await send(handler, 'tools/call', { name: 'repair_gym_canonical_slug' })).result);
    }
    expect(capabilities[0]).toEqual(capabilities[1]);
    expect(capabilities[0]).toMatchObject({ structuredContent: { isGlobalAdmin: null } });
    expect(denials[0]).toEqual(denials[1]);
    expect(fixtures.hasAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ['update_gym_profile', 'gyms:write'],
    ['repair_gym_canonical_slug', 'gyms:admin:write'],
    ['set_gym_image', 'gyms:write'],
    ['remove_gym_image', 'gyms:write'],
  ])('keeps %s hidden in tools/list but names its missing scope on tools/call', async (name, scope) => {
    const handler = handlerFor();
    const listed = await send(handler, 'tools/list');
    expect(listed.result?.tools?.map((tool) => tool.name)).not.toContain(name);
    for (const arguments_ of [undefined, { gymUuid: 123, confirm: false, idempotencyKey: 'invalid' }]) {
      const response = await send(handler, 'tools/call', {
        name,
        ...(arguments_ ? { arguments: arguments_ } : {}),
      });
      expectForbidden(response, `request ${scope} to use ${name}`);
    }
    const listedAfterCall = await send(handler, 'tools/list');
    expect(listedAfterCall.result?.tools?.map((tool) => tool.name)).not.toContain(name);
  });

  it('names the read scope for image-source calls on admin-only connections', async () => {
    const handler = handlerFor(['gyms:admin:read']);
    const listed = await send(handler, 'tools/list');
    expect(listed.result?.tools?.map((tool) => tool.name)).not.toContain('get_gym_image_source');
    expectForbidden(await send(handler, 'tools/call', { name: 'get_gym_image_source' }), 'request gyms:read');
  });

  it('names a revoked global-admin role before validating repair arguments', async () => {
    const handler = handlerFor(['gyms:admin:write']);
    expect((await send(handler, 'tools/list')).result?.tools?.map((tool) => tool.name)).toContain(
      'repair_gym_canonical_slug',
    );
    fixtures.hasAdmin.mockResolvedValue(false);
    const listed = await send(handler, 'tools/list');
    expect(listed.result?.tools?.map((tool) => tool.name)).not.toContain('repair_gym_canonical_slug');
    expectForbidden(
      await send(handler, 'tools/call', { name: 'repair_gym_canonical_slug', arguments: { confirm: false } }),
      'A current global Boardsesh admin role is required.',
    );
    expect(fixtures.hasAdmin).toHaveBeenCalledTimes(3);
  });

  it('keeps unknown names on the SDK not-found path', async () => {
    const response = await send(handlerFor(), 'tools/call', { name: 'invented_gym_action' });
    expect(response.error).toMatchObject({ code: -32602, message: 'Tool invented_gym_action not found' });
    expect(fixtures.execute).not.toHaveBeenCalled();
  });

  it('keeps permitted calls on the authenticated dispatcher', async () => {
    await send(handlerFor(), 'tools/call', { name: 'list_managed_gyms', arguments: {} });
    expect(fixtures.execute).toHaveBeenCalledWith(principal, 'list_managed_gyms', { limit: 20, offset: 0 });
  });
});
