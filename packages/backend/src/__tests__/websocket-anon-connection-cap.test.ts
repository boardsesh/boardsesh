import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { WebSocket } from 'ws';
import type { RawData, WebSocketServer } from 'ws';

/**
 * Cover for issue #4035: the real `setupWebSocketServer` must cap the number of
 * *concurrent* anonymous sockets per IP, not just the rate of their operations.
 *
 * Same harness shape as `websocket-client-ip-context.test.ts` — a genuine `ws`
 * upgrade through the real server with only room-manager/auth mocked — so the
 * whole onConnect ordering (acquire before registerClient, release on raw socket
 * close) is exercised rather than re-implemented.
 */

const VALID_USER_TOKEN = 'valid-user-token';
const VALID_CONTROLLER_API_KEY = 'valid-controller-key';
const ANON_CAP_CLOSE_CODE = 4429;

const { registerClient } = vi.hoisted(() => ({
  registerClient: vi.fn().mockResolvedValue('participant-1'),
}));

vi.mock('../services/room-manager', () => ({
  roomManager: {
    registerClient,
    clearBoardWriterForConnection: vi.fn().mockResolvedValue(undefined),
    disconnectClient: vi.fn().mockResolvedValue(undefined),
    removeClient: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../middleware/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/auth')>();
  return {
    ...actual,
    validateToken: vi.fn(async (token: string) =>
      token === VALID_USER_TOKEN ? { userId: 'user-1', isAuthenticated: true as const } : null,
    ),
    validateControllerApiKey: vi.fn(async (apiKey: string) =>
      apiKey === VALID_CONTROLLER_API_KEY
        ? {
            controllerId: 'controller-1',
            controllerApiKey: apiKey,
            userId: null,
            boardName: 'kilter',
            layoutId: 1,
            sizeId: 1,
            setIds: '1,2',
          }
        : null,
    ),
  };
});

import { setupWebSocketServer } from '../websocket/setup';
import {
  anonConnectionCapRegistrySize,
  countAnonConnectionSlots,
  releaseAnonConnectionSlot,
  resetAnonConnectionCapRegistry,
  tryAcquireAnonConnectionSlot,
} from '../websocket/connection-cap';
import { logger } from '../utils/logger';

const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws';

const CAP_ENV_KEYS = [
  'WS_ANON_CONNECTIONS_PER_CLIENT_IP',
  'WS_ANON_CONNECTIONS_PER_SOCKET_PEER',
  'WS_ANON_CONNECTIONS_PER_SOCKET_PEER_ENFORCE',
] as const;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Test server did not expose a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
}

function decodeMessage(message: RawData): string {
  if (Array.isArray(message)) return Buffer.concat(message).toString('utf8');
  if (message instanceof ArrayBuffer) return Buffer.from(message).toString('utf8');
  return message.toString('utf8');
}

type ConnectionOutcome =
  | { accepted: true; socket: WebSocket }
  | { accepted: false; closeCode: number; closeReason: string };

describe('WebSocket anonymous connection cap', () => {
  let httpServer: Server;
  let webSocketServer: WebSocketServer;
  let pingInterval: NodeJS.Timeout;
  let webSocketUrl: string;
  const openSockets: WebSocket[] = [];

  beforeAll(async () => {
    httpServer = createServer();
    const setup = setupWebSocketServer(httpServer);
    webSocketServer = setup.wss;
    pingInterval = setup.pingInterval;
    const port = await listen(httpServer);
    webSocketUrl = `ws://127.0.0.1:${port}/graphql`;
  });

  afterAll(async () => {
    clearInterval(pingInterval);
    for (const client of webSocketServer.clients) client.terminate();
    await new Promise<void>((resolve, reject) => webSocketServer.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => httpServer.close((error) => (error ? reject(error) : resolve())));
  });

  beforeEach(() => {
    registerClient.mockClear();
    resetAnonConnectionCapRegistry();
    for (const key of CAP_ENV_KEYS) delete process.env[key];
    // The whole suite shares 127.0.0.1 as its TCP peer, so leave the backstop
    // wide unless a test is specifically about it.
    process.env.WS_ANON_CONNECTIONS_PER_SOCKET_PEER = '10000';
  });

  afterEach(async () => {
    await Promise.all(openSockets.splice(0).map(closeAndWait));
    resetAnonConnectionCapRegistry();
    for (const key of CAP_ENV_KEYS) delete process.env[key];
  });

  function closeAndWait(socket: WebSocket): Promise<void> {
    if (socket.readyState === socket.CLOSED) return Promise.resolve();
    return new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.close(1000);
    });
  }

  /** Wait for the raw socket close the server observed to be processed. */
  function waitForServerClose(socket: WebSocket, terminate = false): Promise<void> {
    return new Promise<void>((resolve) => {
      socket.once('close', () => setTimeout(resolve, 25));
      if (terminate) socket.terminate();
      else socket.close(1000);
    });
  }

  /**
   * Open a connection with forged upgrade headers and settle on either a
   * connection_ack (accepted, socket left open for the caller) or the close code
   * the server rejected it with.
   */
  function connect(
    headers: Record<string, string>,
    connectionParams?: Record<string, unknown>,
  ): Promise<ConnectionOutcome> {
    return new Promise<ConnectionOutcome>((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl, GRAPHQL_TRANSPORT_WS, { headers });
      socket.once('open', () => socket.send(JSON.stringify({ type: 'connection_init', payload: connectionParams })));
      socket.once('message', (message) => {
        const payload = JSON.parse(decodeMessage(message)) as { type?: unknown };
        if (payload.type !== 'connection_ack') {
          reject(new Error(`Expected connection_ack, got ${String(payload.type)}`));
          return;
        }
        openSockets.push(socket);
        resolve({ accepted: true, socket });
      });
      socket.once('close', (closeCode, closeReason) =>
        resolve({ accepted: false, closeCode, closeReason: closeReason.toString('utf8') }),
      );
      socket.once('error', () => {
        /* a server-side close surfaces as an error on some Node versions; the
           'close' handler above is what resolves the outcome. */
      });
    });
  }

  async function connectExpectingAccept(
    headers: Record<string, string>,
    connectionParams?: Record<string, unknown>,
  ): Promise<WebSocket> {
    const outcome = await connect(headers, connectionParams);
    if (!outcome.accepted) {
      throw new Error(`Expected the connection to be accepted, got close ${outcome.closeCode}`);
    }
    return outcome.socket;
  }

  it('rejects the connection past the per-client-IP cap without registering it', async () => {
    process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '2';
    const headers = { 'cf-connecting-ip': '203.0.113.7' };

    await connectExpectingAccept(headers);
    await connectExpectingAccept(headers);
    expect(registerClient).toHaveBeenCalledTimes(2);

    const rejected = await connect(headers);

    expect(rejected.accepted).toBe(false);
    if (rejected.accepted) return;
    // 4429 is in the graphql-ws client fatal list, so a capped client stops
    // rather than retrying ten times through our shared client's shouldRetry.
    expect(rejected.closeCode).toBe(ANON_CAP_CLOSE_CODE);
    // The point of the cap: a rejected socket must cost no room-manager state.
    expect(registerClient).toHaveBeenCalledTimes(2);
  });

  it('frees the slot on a clean disconnect so the next connection is admitted', async () => {
    process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '1';
    const headers = { 'cf-connecting-ip': '203.0.113.8' };

    const first = await connectExpectingAccept(headers);
    expect((await connect(headers)).accepted).toBe(false);

    await waitForServerClose(first);
    expect(countAnonConnectionSlots('client-ip', '203.0.113.8')).toBe(0);

    const replacement = await connect(headers);
    expect(replacement.accepted).toBe(true);
  });

  it('frees the slot when a connection is abruptly terminated without a close frame', async () => {
    process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '1';
    const headers = { 'cf-connecting-ip': '203.0.113.9' };

    const first = await connectExpectingAccept(headers);
    expect(countAnonConnectionSlots('client-ip', '203.0.113.9')).toBe(1);

    await waitForServerClose(first, true);

    // A half-open socket that dies without a close handshake must not strand a
    // slot — stranded slots permanently shrink an IP's budget on this instance.
    expect(countAnonConnectionSlots('client-ip', '203.0.113.9')).toBe(0);
    expect((await connect(headers)).accepted).toBe(true);
  });

  it('exempts authenticated connections from the cap', async () => {
    process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '1';
    const headers = { 'cf-connecting-ip': '203.0.113.10' };

    await connectExpectingAccept(headers, { authToken: VALID_USER_TOKEN });
    await connectExpectingAccept(headers, { authToken: VALID_USER_TOKEN });

    expect(countAnonConnectionSlots('client-ip', '203.0.113.10')).toBe(0);
    // ...and they left the anonymous budget untouched.
    expect((await connect(headers)).accepted).toBe(true);
  });

  it('exempts API-key controllers from the cap', async () => {
    process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '1';
    const headers = { 'cf-connecting-ip': '203.0.113.11' };

    // Controllers authenticate by API key and never set isAuthenticated, so a
    // gym's wall controller would be evicted by browsing phones without this.
    await connectExpectingAccept(headers, { controllerApiKey: VALID_CONTROLLER_API_KEY });
    await connectExpectingAccept(headers, { controllerApiKey: VALID_CONTROLLER_API_KEY });

    expect(countAnonConnectionSlots('client-ip', '203.0.113.11')).toBe(0);
  });

  it('shares one bucket across a client rotating within its IPv6 /64', async () => {
    process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '2';

    await connectExpectingAccept({ 'cf-connecting-ip': '2001:db8:abcd:1234::1' });
    await connectExpectingAccept({ 'cf-connecting-ip': '2001:db8:abcd:1234:5:6:7:8' });

    const rejected = await connect({ 'cf-connecting-ip': '2001:db8:abcd:1234::ffff' });
    expect(rejected.accepted).toBe(false);
    expect(countAnonConnectionSlots('client-ip', '2001:db8:abcd:1234::/64')).toBe(2);
  });

  it('admits past the socket-peer backstop by default and rejects only when enforcement is on', async () => {
    process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '100';
    process.env.WS_ANON_CONNECTIONS_PER_SOCKET_PEER = '1';

    // Warn-only by default: in the hosted topology the TCP peer can be a shared
    // Cloudflare/Railway edge, which would make this tier an instance-global cap.
    await connectExpectingAccept({ 'cf-connecting-ip': '203.0.113.20' });
    await connectExpectingAccept({ 'cf-connecting-ip': '203.0.113.21' });
    expect(countAnonConnectionSlots('socket-peer', '127.0.0.1')).toBe(2);

    process.env.WS_ANON_CONNECTIONS_PER_SOCKET_PEER_ENFORCE = '1';
    // A direct-origin caller rotating a forged cf-connecting-ip keeps minting
    // fresh client-IP buckets, but cannot change its TCP peer.
    const rejected = await connect({ 'cf-connecting-ip': '203.0.113.22' });
    expect(rejected.accepted).toBe(false);
    if (rejected.accepted) return;
    expect(rejected.closeCode).toBe(ANON_CAP_CLOSE_CODE);
  });

  describe('registry bookkeeping', () => {
    it('falls back to the socket peer when no client IP resolves', () => {
      process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '1';

      expect(tryAcquireAnonConnectionSlot({ connectionId: 'a', socketPeerIp: '198.51.100.4' }).allowed).toBe(true);
      expect(tryAcquireAnonConnectionSlot({ connectionId: 'b', socketPeerIp: '198.51.100.4' }).allowed).toBe(false);
      expect(countAnonConnectionSlots('client-ip', '198.51.100.4')).toBe(1);
    });

    it('admits when neither identity resolves', () => {
      process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '1';

      expect(tryAcquireAnonConnectionSlot({ connectionId: 'a' }).allowed).toBe(true);
      expect(tryAcquireAnonConnectionSlot({ connectionId: 'b' }).allowed).toBe(true);
    });

    it('holds no slot on the client-IP tier when the enforced peer tier rejects', () => {
      process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = '100';
      process.env.WS_ANON_CONNECTIONS_PER_SOCKET_PEER = '1';
      process.env.WS_ANON_CONNECTIONS_PER_SOCKET_PEER_ENFORCE = '1';

      tryAcquireAnonConnectionSlot({ connectionId: 'a', clientIp: '203.0.113.30', socketPeerIp: '198.51.100.9' });
      const second = tryAcquireAnonConnectionSlot({
        connectionId: 'b',
        clientIp: '203.0.113.31',
        socketPeerIp: '198.51.100.9',
      });

      expect(second.allowed).toBe(false);
      // Check-all-then-commit-all: the first tier must not keep a stray slot.
      expect(countAnonConnectionSlots('client-ip', '203.0.113.31')).toBe(0);
    });

    it('releases idempotently and drains the registry', () => {
      tryAcquireAnonConnectionSlot({ connectionId: 'a', clientIp: '203.0.113.40', socketPeerIp: '198.51.100.9' });
      tryAcquireAnonConnectionSlot({ connectionId: 'b', clientIp: '203.0.113.40', socketPeerIp: '198.51.100.9' });

      releaseAnonConnectionSlot('a');
      releaseAnonConnectionSlot('a');

      // The double release must not free b's slot.
      expect(countAnonConnectionSlots('client-ip', '203.0.113.40')).toBe(1);

      releaseAnonConnectionSlot('b');
      expect(countAnonConnectionSlots('client-ip', '203.0.113.40')).toBe(0);
      // Empty holder sets are deleted, so the registry can't grow one entry per
      // IP ever seen.
      expect(anonConnectionCapRegistrySize()).toBe(0);
    });

    it('falls back to the default cap when the env override is not a positive integer', () => {
      process.env.WS_ANON_CONNECTIONS_PER_CLIENT_IP = 'many';
      // Every acquisition re-reads the env, so silence the (correct) per-read
      // complaint rather than printing it 201 times.
      const warn = vi.spyOn(logger, 'warn').mockReturnValue(logger);

      for (let index = 0; index < 200; index += 1) {
        expect(tryAcquireAnonConnectionSlot({ connectionId: `c${index}`, clientIp: '203.0.113.50' }).allowed).toBe(
          true,
        );
      }
      expect(tryAcquireAnonConnectionSlot({ connectionId: 'c200', clientIp: '203.0.113.50' }).allowed).toBe(false);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
  });
});
