import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartnerApiPrincipal, PartnerBearerResult } from '../../../auth/partner/bearer';

const fixtures = vi.hoisted(() => ({
  consume: vi.fn(),
  readBody: vi.fn(),
  prepare: vi.fn(),
  runWrite: vi.fn(),
  log: vi.fn(),
  recordUsage: vi.fn(),
  recordAddressRefusal: vi.fn(),
}));
vi.mock('../media', () => ({ prepareGymMcpImage: fixtures.prepare }));
vi.mock('../domain', () => ({ resolveGymForTool: vi.fn(), executeGymDocument: vi.fn() }));
vi.mock('../dispatch', () => ({
  hasGymMcpWriteReceipt: async () => false,
  executeGymMcpWriteAction: fixtures.runWrite,
  createGymMcpContext: () => ({}),
}));
vi.mock('../../../handlers/partner-rate-limits', () => ({
  RateLimitLedger: class {
    consume(...arguments_: unknown[]) {
      return fixtures.consume(...arguments_);
    }
    headers() {
      return {};
    }
  },
  PartnerRateLimited: class extends Error {},
}));
vi.mock('../../../handlers/public-api/workouts', () => ({
  readWorkoutBody: fixtures.readBody,
  WorkoutBodyError: class extends Error {},
}));
vi.mock('../../../utils/logger', () => ({ logger: { info: fixtures.log, error: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../services/public-api-usage', () => ({
  recordPublicApiRequest: fixtures.recordUsage,
  recordGymMcpPendingAuthAddressRefusal: fixtures.recordAddressRefusal,
}));

import { createGymMcpHandler } from '../transport';
import { registerGymMcpMediaTools } from '../media-tools';
import { trackGymMcpToolWork } from '../request-lifetime';

const principal: PartnerApiPrincipal = {
  clientId: 'assistant',
  userId: 'owner',
  connectionId: 'connection',
  connectionGeneration: 1,
  scopes: ['gyms:read', 'gyms:write'],
  accessTokenHash: 'test-hash',
  connectionLastUsedAt: null,
};

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((fulfill, refuse) => {
    resolve = fulfill;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

function startRequest(handler: ReturnType<typeof createGymMcpHandler>, address: string, token = 'invalid') {
  const incoming = Readable.from([]) as unknown as IncomingMessage;
  incoming.url = '/mcp/gyms';
  incoming.method = 'POST';
  incoming.headers = {
    host: 'api.boardsesh.com',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-11-25',
  };
  incoming.socket = { remoteAddress: address } as IncomingMessage['socket'];
  const headers = new Map<string, string>();
  const response = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, header: string) {
      headers.set(name.toLowerCase(), header);
    },
    writeHead(status: number, additions: Record<string, string> = {}) {
      this.statusCode = status;
      this.headersSent = true;
      for (const [name, header] of Object.entries(additions)) headers.set(name.toLowerCase(), header);
    },
    end() {
      this.writableEnded = true;
    },
  });
  const completion = handler(incoming, response as unknown as ServerResponse).then(() => ({
    status: response.statusCode,
    headers,
  }));
  return { incoming, response, completion };
}

async function request(handler: ReturnType<typeof createGymMcpHandler>, address: string, token = 'invalid') {
  return startRequest(handler, address, token).completion;
}

function serverFor(actor: PartnerApiPrincipal, finish?: Promise<void>): McpServer {
  const server = new McpServer({ name: 'admission-test', version: '1' });
  server.registerTool('get_actor', { inputSchema: z.object({}) }, () =>
    trackGymMcpToolWork(async () => {
      await finish;
      return { content: [{ type: 'text', text: actor.userId }] };
    }),
  );
  return server;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixtures.consume.mockResolvedValue(undefined);
  fixtures.readBody.mockResolvedValue({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'get_actor', arguments: {} },
  });
});

describe('gym MCP authentication admission', () => {
  it('identifies pending-auth address refusals with a fixed event field and existing anonymous usage metrics', async () => {
    const authentication = deferred<PartnerBearerResult>();
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate: () => authentication.promise,
    });
    const pending = Array.from({ length: 4 }, () => request(handler, '198.51.100.19', 'private-bearer-marker'));
    try {
      const refused = await Promise.all(
        Array.from({ length: 5 }, () => request(handler, '198.51.100.19', 'private-bearer-marker')),
      );
      expect(refused.every((result) => result.status === 429)).toBe(true);
      expect(fixtures.log).toHaveBeenCalledTimes(5);
      for (const event of fixtures.log.mock.calls) {
        expect(event).toEqual([
          'Gym MCP request',
          {
            requestId: expect.any(String),
            clientId: undefined,
            connectionId: undefined,
            tool: undefined,
            status: 429,
            completed: false,
            admissionRefusal: 'pending_auth_address_cap',
          },
        ]);
      }
      expect(fixtures.recordUsage).toHaveBeenCalledTimes(5);
      expect(fixtures.recordUsage).toHaveBeenCalledWith(undefined, 'mcp', 429, expect.any(Number));
      expect(fixtures.recordAddressRefusal.mock.calls).toEqual([[], [], [], [], []]);
      expect(JSON.stringify([fixtures.log.mock.calls, fixtures.recordUsage.mock.calls])).not.toMatch(
        /198\.51\.100\.19|private-bearer-marker/,
      );
      authentication.resolve({ refusal: 'unknown' });
      await Promise.all(pending);
      expect(fixtures.recordAddressRefusal).toHaveBeenCalledTimes(5);
      expect(fixtures.log.mock.calls.slice(5).every((event) => event[1]?.admissionRefusal === undefined)).toBe(true);
    } finally {
      authentication.resolve({ refusal: 'unknown' });
      await Promise.allSettled(pending);
    }
  });

  it('bounds one junk address before token lookup and preserves invalid-token charging/challenges', async () => {
    const authentication = deferred<PartnerBearerResult>();
    const authenticate = vi.fn(() => authentication.promise);
    const handler = createGymMcpHandler({ mode: 'on', partnerMode: 'open', authenticate });
    const attempts = Array.from({ length: 33 }, () => request(handler, '198.51.100.10'));
    try {
      await vi.waitFor(() => expect(authenticate).toHaveBeenCalledTimes(4));
      const refused = await Promise.all(attempts.slice(4));
      for (const result of refused) {
        expect(result.status).toBe(429);
        expect(result.headers.get('retry-after')).toBe('2');
        expect(result.headers.get('cache-control')).toBe('no-store');
        expect(result.headers.get('x-request-id')).toBeDefined();
      }
      authentication.resolve({ refusal: 'unknown' });
      const invalid = await Promise.all(attempts.slice(0, 4));
      expect(invalid.every((result) => result.status === 401)).toBe(true);
      expect(invalid[0]?.headers.get('www-authenticate')).toContain('invalid_token');
      expect(fixtures.consume).toHaveBeenCalledTimes(4);
      expect(fixtures.consume).toHaveBeenCalledWith('198.51.100.10', 'gymMcpInvalidToken', 600);
    } finally {
      authentication.resolve({ refusal: 'unknown' });
      await Promise.allSettled(attempts);
    }
  });

  it('leaves valid users on other addresses admitted while a junk address holds its permits', async () => {
    const invalidAuthentication = deferred<PartnerBearerResult>();
    const authenticate = vi.fn((token: string): Promise<PartnerBearerResult> =>
      token === 'invalid'
        ? invalidAuthentication.promise
        : Promise.resolve({ principal: { ...principal, connectionId: token } }),
    );
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate,
      createServer: (actor) => serverFor(actor),
    });
    const junk = Array.from({ length: 4 }, () => request(handler, '198.51.100.11'));
    try {
      await vi.waitFor(() => expect(authenticate).toHaveBeenCalledTimes(4));
      const valid = await Promise.all(
        Array.from({ length: 6 }, (_, index) => request(handler, `203.0.113.${index + 1}`, `valid-${index}`)),
      );
      expect(valid.every((result) => result.status === 200)).toBe(true);
      expect(authenticate).toHaveBeenCalledTimes(10);
      expect(fixtures.consume).toHaveBeenCalledWith('valid-0', 'gymMcpConnection', 120);
      expect(fixtures.consume).toHaveBeenCalledWith('assistant', 'gymMcpClient', 6000);
    } finally {
      invalidAuthentication.resolve({ refusal: 'unknown' });
      await Promise.all(junk);
    }
  });

  it('releases address permits after valid authentication rather than capping active cloud users', async () => {
    const finishTools = deferred<void>();
    const createServer = vi.fn((actor: PartnerApiPrincipal) => serverFor(actor, finishTools.promise));
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      createServer,
      authenticate: async (token) => ({ principal: { ...principal, connectionId: token } }),
    });
    const firstWave = Array.from({ length: 4 }, (_, index) => request(handler, '198.51.100.12', `first-${index}`));
    const secondWave: ReturnType<typeof request>[] = [];
    try {
      await vi.waitFor(() => expect(createServer).toHaveBeenCalledTimes(4));
      secondWave.push(...Array.from({ length: 4 }, (_, index) => request(handler, '198.51.100.12', `second-${index}`)));
      await vi.waitFor(() => expect(createServer).toHaveBeenCalledTimes(8));
      finishTools.resolve();
      expect((await Promise.all([...firstWave, ...secondWave])).every((result) => result.status === 200)).toBe(true);
    } finally {
      finishTools.resolve();
      await Promise.allSettled([...firstWave, ...secondWave]);
    }
  });

  it('releases address/global permits if token lookup throws', async () => {
    const authenticate = vi
      .fn()
      .mockRejectedValueOnce(new Error('Lookup unavailable'))
      .mockResolvedValue({ principal });
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate,
      createServer: (actor) => serverFor(actor),
    });
    expect((await request(handler, '198.51.100.13')).status).toBe(503);
    expect((await request(handler, '198.51.100.13', 'valid')).status).toBe(200);
    expect(fixtures.recordAddressRefusal).not.toHaveBeenCalled();
  });

  it('aborts the actual SDK media callback on premature HTTP response close, without attaching the image', async () => {
    let imageSignal: AbortSignal | undefined;
    fixtures.prepare.mockImplementation(async (_actor, _gym, _kind, _url, signal: AbortSignal) => {
      imageSignal = signal;
      await new Promise<void>((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    fixtures.readBody.mockResolvedValue({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'set_gym_image',
        arguments: {
          gymUuid: '11111111-1111-4111-8111-111111111111',
          kind: 'photo',
          idempotencyKey: '22222222-2222-4222-8222-222222222222',
          imageUrl: 'https://images.example/photo.png',
          confirm: true,
        },
      },
    });
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate: async () => ({ principal }),
      createServer: () => {
        const server = new McpServer({ name: 'media-cancellation', version: '1' });
        registerGymMcpMediaTools(server, principal);
        return server;
      },
    });
    const active = startRequest(handler, '198.51.100.14', 'valid');
    try {
      await vi.waitFor(() => expect(imageSignal).toBeDefined());
      active.incoming.emit('close');
      expect(imageSignal?.aborted).toBe(false);
      active.response.emit('close');
      expect((await active.completion).status).toBe(499);
      expect(imageSignal?.aborted).toBe(true);
      expect(fixtures.runWrite).not.toHaveBeenCalled();
    } finally {
      active.response.emit('close');
      await active.completion;
    }
  });

  it('retains cancelled callback permits until non-cooperative work actually settles', async () => {
    const finishTools = deferred<void>();
    const entered = vi.fn();
    const handler = createGymMcpHandler({
      mode: 'on',
      partnerMode: 'open',
      authenticate: async () => ({ principal }),
      createServer: () => {
        const server = new McpServer({ name: 'non-cooperative', version: '1' });
        server.registerTool('get_actor', { inputSchema: z.object({}) }, () =>
          trackGymMcpToolWork(async () => {
            entered();
            await finishTools.promise;
            return { content: [{ type: 'text', text: 'done' }] };
          }),
        );
        return server;
      },
    });
    const pending = Array.from({ length: 4 }, () => startRequest(handler, '198.51.100.15', 'valid'));
    try {
      await vi.waitFor(() => expect(entered).toHaveBeenCalledTimes(4));
      for (const active of pending) active.response.emit('close');
      expect((await request(handler, '203.0.113.15', 'valid')).status).toBe(429);
      expect(entered).toHaveBeenCalledTimes(4);
      finishTools.resolve();
      expect(
        (await Promise.all(pending.map((active) => active.completion))).every((result) => result.status === 499),
      ).toBe(true);
      expect((await request(handler, '203.0.113.15', 'valid')).status).toBe(200);
    } finally {
      finishTools.resolve();
      await Promise.allSettled(pending.map((active) => active.completion));
    }
  });
});
