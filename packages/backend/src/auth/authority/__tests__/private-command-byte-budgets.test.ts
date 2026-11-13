import { createServer, request as sendRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vite-plus/test';
import { AUTH_COMMAND_MAX_BODY_BYTES, AUTH_COMMAND_REQUEST_BYTES } from '@boardsesh/auth-protocol';
import { readPrivateAuthCommand } from '../../../handlers/current-store-private-transport';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        }),
    ),
  );
});
function bodyOfBytes(bytes: number) {
  return JSON.stringify({ payload: 'x'.repeat(bytes - 14) });
}
async function endpoint(trustedBudget?: number) {
  let rejected = 0;
  const server = createServer(async (request, response) => {
    try {
      const body = await readPrivateAuthCommand(request, trustedBudget);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    } catch {
      rejected += 1;
      if (!response.destroyed) {
        response.writeHead(400);
        response.end();
      }
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    rejected: () => rejected,
    post(body: string, headers: Record<string, string> = {}) {
      return new Promise<{ status: number; body: string } | { disconnected: true }>((resolve, reject) => {
        const request = sendRequest(
          {
            hostname: '127.0.0.1',
            port,
            path: '/?maxBytes=262144',
            method: 'POST',
            agent: false,
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () =>
              resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString('utf8') }),
            );
            response.on('error', reject);
          },
        );
        request.on('error', () => resolve({ disconnected: true }));
        request.end(body);
      });
    },
  };
}

it('keeps the released body default at exactly 16 KiB and disconnects an actual HTTP byte over it', async () => {
  const server = await endpoint();
  expect(await server.post(bodyOfBytes(AUTH_COMMAND_REQUEST_BYTES))).toMatchObject({ status: 200 });
  expect(await server.post(bodyOfBytes(AUTH_COMMAND_REQUEST_BYTES + 1))).toEqual({ disconnected: true });
  expect(server.rejected()).toBe(1);
});

it('accepts a trusted 64 KiB browser facade and rejects its next actual HTTP byte', async () => {
  const server = await endpoint(65_536);
  const body = bodyOfBytes(65_536);
  expect(await server.post(body)).toEqual({ status: 200, body });
  expect(await server.post(bodyOfBytes(65_537))).toEqual({ disconnected: true });
});

it('accepts the trusted provider budget while HTTP header, query and body fields cannot widen defaults', async () => {
  const provider = await endpoint(196_608);
  const body = bodyOfBytes(196_608);
  expect(await provider.post(body)).toEqual({ status: 200, body });
  const original = await endpoint();
  expect(
    await original.post(JSON.stringify({ maxBytes: AUTH_COMMAND_MAX_BODY_BYTES, payload: 'x'.repeat(16384) }), {
      'X-Body-Byte-Limit': String(AUTH_COMMAND_MAX_BODY_BYTES),
    }),
  ).toEqual({ disconnected: true });
});

it('counts UTF8 bytes rather than character count for an actual request', async () => {
  const server = await endpoint();
  const body = JSON.stringify({ payload: '🧗'.repeat(4096) });
  expect(body.length).toBeLessThan(AUTH_COMMAND_REQUEST_BYTES);
  expect(Buffer.byteLength(body)).toBeGreaterThan(AUTH_COMMAND_REQUEST_BYTES);
  expect(await server.post(body)).toEqual({ disconnected: true });
});

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, AUTH_COMMAND_MAX_BODY_BYTES + 1])(
  'refuses invalid server-owned budget %s before reading a request',
  async (bytes) => {
    const server = await endpoint(bytes);
    expect(await server.post('{}')).toMatchObject({ status: 400 });
    expect(server.rejected()).toBe(1);
  },
);
