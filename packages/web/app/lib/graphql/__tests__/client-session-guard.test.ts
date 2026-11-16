import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ClientError } from 'graphql-request';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { browserSessionGuard, SessionSupersededError, WEB_SESSION_CHECK_EVENT } from '@/app/lib/auth/session-guard';
import { createGraphQLHttpClient } from '../client';

const fixture = vi.hoisted(() => ({ url: '' }));
vi.mock('@/app/lib/backend-url', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/lib/backend-url')>()),
  getGraphQLHttpUrl: () => fixture.url,
}));

const GUARD_KEY = Symbol.for('boardsesh.web-session-guard.v1');
const QUERY = 'query Viewer { viewer { id } }';
const accountA = { userId: 'user-a', authSessionId: 'login-a' };
const accountB = { userId: 'user-b', authSessionId: 'login-b' };

type Handler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>;
let handle: Handler;
const received: { authorization?: string; body: string }[] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  received.push({ authorization: request.headers.authorization, body: Buffer.concat(chunks).toString() });
  await handle(request, response);
});
const realFetch = globalThis.fetch;

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  fixture.url = `http://127.0.0.1:${address.port}/graphql`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  delete (globalThis as typeof globalThis & { [key: symbol]: unknown })[GUARD_KEY];
  received.length = 0;
  handle = (_request, response) => reply(response, 200, { data: { viewer: { id: 'user-a' } } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createGraphQLHttpClient through the session guard', () => {
  it('returns data for the current account and sends its bearer token', async () => {
    browserSessionGuard().accept(accountA);

    await expect(createGraphQLHttpClient('token-a').request(QUERY)).resolves.toEqual({ viewer: { id: 'user-a' } });

    expect(received).toHaveLength(1);
    expect(received[0]?.authorization).toBe('Bearer token-a');
    expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({ operationName: 'Viewer' });
  });

  it('rejects with SessionSupersededError, not a ClientError, when the account changes mid-response', async () => {
    const guard = browserSessionGuard();
    guard.accept(accountA);
    let headersReceived!: () => void;
    const headersArrived = new Promise<void>((resolve) => {
      headersReceived = resolve;
    });
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await realFetch(input, init);
      headersReceived();
      return response;
    });
    let finishBody!: () => void;
    const bodyReleased = new Promise<void>((resolve) => {
      finishBody = resolve;
    });
    handle = async (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.write('{"data":{"viewer":');
      await bodyReleased;
      response.end('{"id":"user-a"}}}');
    };

    const pending = createGraphQLHttpClient('token-a').request(QUERY);
    await headersArrived;
    guard.expectLocalChange();
    guard.accept(accountB);
    finishBody();

    const failure = await pending.catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionSupersededError);
    expect(failure).not.toBeInstanceOf(ClientError);
  });

  it('sends nothing for a client still holding the previous account’s token', async () => {
    const guard = browserSessionGuard();
    guard.accept(accountA);
    guard.rememberToken('token-a', accountA);
    const staleClient = createGraphQLHttpClient('token-a');
    guard.expectLocalChange();
    guard.accept(accountB);

    await expect(staleClient.request(QUERY)).rejects.toBeInstanceOf(SessionSupersededError);
    expect(received).toHaveLength(0);
  });

  it('keeps a 401 as the caller’s ClientError and asks the page to re-check its session', async () => {
    browserSessionGuard().accept(accountA);
    const sessionCheck = vi.fn();
    window.addEventListener(WEB_SESSION_CHECK_EVENT, sessionCheck);
    handle = (_request, response) => reply(response, 401, { errors: [{ message: 'Unauthenticated' }] });

    try {
      const failure = await createGraphQLHttpClient('token-a')
        .request(QUERY)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ClientError);
      expect((failure as ClientError).response.status).toBe(401);
      await vi.waitFor(() => expect(sessionCheck).toHaveBeenCalledOnce(), { timeout: 3000 });
    } finally {
      window.removeEventListener(WEB_SESSION_CHECK_EVENT, sessionCheck);
    }
  });
});
