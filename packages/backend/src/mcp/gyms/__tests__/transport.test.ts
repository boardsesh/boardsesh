import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { PartnerApiPrincipal } from '../../../auth/partner/bearer';
import { createGymMcpHandler, GYM_MCP_METADATA_PATH, GYM_MCP_PATH, GYM_MCP_STATUS_PATH } from '../transport';

const principal: PartnerApiPrincipal = {
  clientId: 'https://assistant.example/oauth/client.json',
  userId: 'gym-owner',
  connectionId: 'connection-1',
  connectionGeneration: 1,
  scopes: ['gyms:read', 'gyms:write'],
  accessTokenHash: 'only-a-test-hash',
  connectionLastUsedAt: null,
};

async function request(
  handler: ReturnType<typeof createGymMcpHandler>,
  options: { path?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {},
) {
  const body = options.body === undefined ? '' : JSON.stringify(options.body);
  const incoming = Readable.from(body ? [Buffer.from(body)] : []) as unknown as IncomingMessage;
  incoming.url = options.path ?? GYM_MCP_PATH;
  incoming.method = options.method ?? 'POST';
  incoming.headers = {
    host: 'api.boardsesh.com',
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    authorization: 'Bearer test-access-token',
    'mcp-protocol-version': '2025-11-25',
    ...options.headers,
  };
  incoming.socket = { remoteAddress: '127.0.0.1' } as IncomingMessage['socket'];
  const headers = new Map<string, string>();
  let responseBody = '';
  const response = {
    statusCode: 200,
    headersSent: false,
    setHeader(name: string, header: string) {
      headers.set(name.toLowerCase(), header);
    },
    writeHead(status: number, responseHeaders?: Record<string, string>) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [name, header] of Object.entries(responseHeaders ?? {})) headers.set(name.toLowerCase(), header);
    },
    end(content?: Buffer | string) {
      responseBody = content?.toString() ?? '';
    },
  };
  const handled = await handler(incoming, response as unknown as ServerResponse);
  return {
    handled,
    status: response.statusCode,
    headers,
    body: responseBody ? (JSON.parse(responseBody) as Record<string, unknown>) : undefined,
  };
}

function serverFor(actor: PartnerApiPrincipal) {
  const server = new McpServer({ name: 'gym-test', version: '1.0.0' });
  server.registerTool(
    'get_gym_actor',
    {
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: 'text', text: actor.userId }] }),
  );
  return server;
}

describe('hosted gym MCP transport', () => {
  it('publishes a disabled status without authenticating or constructing a server', async () => {
    const authenticate = vi.fn();
    const createServer = vi.fn();
    const handler = createGymMcpHandler({ mode: 'off', partnerMode: 'open', authenticate, createServer });
    expect(await request(handler, { path: GYM_MCP_STATUS_PATH, method: 'GET' })).toMatchObject({
      status: 200,
      body: { enabled: false, invitationRequired: false },
    });
    expect((await request(handler)).handled).toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
    expect(createServer).not.toHaveBeenCalled();
  });

  it.each([
    ['pilot', 'open', true, true],
    ['pilot', 'allowlist', true, true],
    ['on', 'open', true, false],
    ['pilot', 'hold', false, false],
    ['pilot', 'off', false, false],
  ] as const)(
    'publishes invitation requirements without user details: %s/%s',
    async (mode, partnerMode, enabled, invitationRequired) => {
      const authenticate = vi.fn();
      const createServer = vi.fn();
      const handler = createGymMcpHandler({ mode, partnerMode, authenticate, createServer });
      const result = await request(handler, { path: GYM_MCP_STATUS_PATH, method: 'GET' });
      expect(result.body).toEqual({ enabled, invitationRequired });
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect((await request(handler, { path: GYM_MCP_STATUS_PATH, method: 'HEAD' })).body).toBeUndefined();
      expect(authenticate).not.toHaveBeenCalled();
      expect(createServer).not.toHaveBeenCalled();
    },
  );

  it('keeps the parent OAuth off and hold controls authoritative', async () => {
    const disabled = createGymMcpHandler({ mode: 'on', partnerMode: 'off' });
    expect((await request(disabled)).handled).toBe(false);
    const held = createGymMcpHandler({ mode: 'on', partnerMode: 'hold' });
    expect(await request(held)).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
  });

  it('serves exact protected-resource discovery without a credential', async () => {
    const authenticate = vi.fn();
    const handler = createGymMcpHandler({ mode: 'on', partnerMode: 'open', authenticate });
    const result = await request(handler, { path: GYM_MCP_METADATA_PATH, method: 'GET' });
    expect(result.body).toMatchObject({
      resource: 'https://api.boardsesh.com/mcp/gyms',
      authorization_servers: ['https://api.boardsesh.com/api/auth'],
      scopes_supported: [
        'gyms:read',
        'gyms:write',
        'gyms:access:write',
        'offline_access',
        'gyms:admin:read',
        'gyms:admin:write',
      ],
    });
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('answers a missing bearer with discoverable OAuth rather than a protocol error', async () => {
    const handler = createGymMcpHandler({ mode: 'on', partnerMode: 'open' });
    const result = await request(handler, { headers: { authorization: '' } });
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).not.toContain('gyms:admin:');
    expect(result.headers.get('www-authenticate')).toContain(
      `resource_metadata="https://api.boardsesh.com${GYM_MCP_METADATA_PATH}"`,
    );
  });

  it('refuses revoked tokens and first-party credentials before dispatch', async () => {
    const createServer = vi.fn(serverFor);
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate: async () => ({ refusal: 'wrong_audience' }),
      createServer,
    });
    const result = await request(handler);
    expect(result.status).toBe(401);
    expect(result.headers.get('www-authenticate')).toContain('invalid_token');
    expect(createServer).not.toHaveBeenCalled();
  });

  it('serves real SDK initialization and tools without an in-memory MCP session', async () => {
    const createServer = vi.fn(serverFor);
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate: async () => ({ principal }),
      createServer,
    });
    const initialized = await request(handler, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'integration-test', version: '1' },
        },
      },
    });
    expect(initialized.status).toBe(200);
    expect(initialized.headers.has('mcp-session-id')).toBe(false);
    const called = await request(handler, {
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_gym_actor', arguments: {} } },
    });
    expect(called.status).toBe(200);
    expect(called.body).toMatchObject({ id: 2, result: { content: [{ type: 'text', text: 'gym-owner' }] } });
    expect(createServer).toHaveBeenCalledTimes(2);
    expect(createServer).toHaveBeenNthCalledWith(1, principal, undefined);
    expect(createServer).toHaveBeenNthCalledWith(2, principal, 'get_gym_actor');
    expect(called.headers.get('cache-control')).toBe('no-store');
  });

  it.each(['gyms:admin:read', 'gyms:admin:write'])(
    'serves initialization and tool calls with only %s',
    async (scope) => {
      const handler = createGymMcpHandler({
        mode: 'on',
        partnerMode: 'open',
        authenticate: async () => ({ principal: { ...principal, scopes: [scope] } }),
        createServer: serverFor,
      });
      expect(
        await request(handler, {
          body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              clientInfo: { name: 'admin-test', version: '1' },
            },
          },
        }),
      ).toMatchObject({ status: 200, body: { id: 1, result: { serverInfo: { name: 'gym-test' } } } });
      expect(
        await request(handler, {
          body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_gym_actor', arguments: {} } },
        }),
      ).toMatchObject({ status: 200, body: { id: 2, result: { content: [{ text: 'gym-owner' }] } } });
    },
  );

  it('requires a read or explicit admin scope before dispatch', async () => {
    const createServer = vi.fn(serverFor);
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate: async () => ({ principal: { ...principal, scopes: ['gyms:write'] } }),
      createServer,
    });
    expect(await request(handler)).toMatchObject({ status: 403, body: { error: 'insufficient_scope' } });
    expect(createServer).not.toHaveBeenCalled();
  });

  it('creates a distinct actor-bound server for every request', async () => {
    let invocation = 0;
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate: async () => ({ principal: { ...principal, userId: `owner-${++invocation}` } }),
      createServer: serverFor,
    });
    const body = { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_gym_actor', arguments: {} } };
    expect((await request(handler, { body })).body).toMatchObject({ result: { content: [{ text: 'owner-1' }] } });
    expect((await request(handler, { body })).body).toMatchObject({ result: { content: [{ text: 'owner-2' }] } });
  });

  it('validates the API host and browser origins before authentication', async () => {
    const authenticate = vi.fn();
    const handler = createGymMcpHandler({ mode: 'on', partnerMode: 'open', authenticate });
    expect((await request(handler, { headers: { host: 'ws.boardsesh.com' } })).handled).toBe(false);
    expect((await request(handler, { headers: { origin: 'https://attacker.example' } })).status).toBe(403);
    const preflight = await request(handler, { method: 'OPTIONS', headers: { origin: 'https://claude.ai' } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://claude.ai');
    expect(authenticate).not.toHaveBeenCalled();
  });

  it('rejects oversized declared JSON bodies before constructing a tool server', async () => {
    const createServer = vi.fn(serverFor);
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate: async () => ({ principal }),
      createServer,
    });
    expect((await request(handler, { headers: { 'content-length': '65537' } })).status).toBe(413);
    expect(createServer).not.toHaveBeenCalled();
  });
});
