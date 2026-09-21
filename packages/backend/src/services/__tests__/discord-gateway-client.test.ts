import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiscordGatewayClient, type DiscordGatewayMessage } from '../discord-gateway-client';

const BOT_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const MAINTAINER_ID = '300000000000000001';
const MESSAGE_ID = '400000000000000001';
const CHANNEL_ID = '500000000000000001';
const RESUME_URL = 'wss://gateway-us-east1-b.discord.gg/';

type SocketListener = (...arguments_: unknown[]) => void;

class FakeSocket {
  readyState: number = WebSocket.OPEN;
  readonly sentPayloads: string[] = [];
  readonly close = vi.fn((code = 1000, reason = '') => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  });
  readonly terminate = vi.fn(() => {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1006, Buffer.alloc(0));
  });
  private readonly listeners = new Map<string, SocketListener[]>();

  on(event: string, listener: SocketListener): this {
    const eventListeners = this.listeners.get(event) ?? [];
    eventListeners.push(listener);
    this.listeners.set(event, eventListeners);
    return this;
  }

  send(payload: string): void {
    this.sentPayloads.push(payload);
  }

  emitGateway(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  private emit(event: string, ...arguments_: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...arguments_);
  }
}

function gatewayHarness(random = () => 0.5) {
  const socket = new FakeSocket();
  const sockets = [socket];
  const createSocket = vi.fn((_url: string) => {
    const nextSocket = createSocket.mock.calls.length === 1 ? socket : new FakeSocket();
    if (nextSocket !== socket) sockets.push(nextSocket);
    return nextSocket as unknown as WebSocket;
  });
  const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const sleep = vi.fn(async (_milliseconds: number): Promise<void> => undefined);
  const client = createDiscordGatewayClient({
    fetchImplementation,
    createSocket,
    random,
    sleep,
  });
  return { client, fetchImplementation, socket, sockets, createSocket, sleep };
}

async function connectGateway(
  client: ReturnType<typeof createDiscordGatewayClient>,
  socket: FakeSocket,
): Promise<void> {
  const connection = client.connect('discord-token');
  socket.emitGateway({ op: 10, d: { heartbeat_interval: 30_000 } });
  socket.emitGateway({
    op: 0,
    t: 'READY',
    s: 1,
    d: { user: { id: BOT_ID }, session_id: 'session-1', resume_gateway_url: RESUME_URL },
  });
  await connection;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Discord Gateway client', () => {
  it('terminates and rejects a Gateway handshake that never becomes ready', async () => {
    vi.useFakeTimers();
    const { client, socket } = gatewayHarness();
    const connection = client.connect('discord-token');
    const rejection = expect(connection).rejects.toThrow(/did not become ready/);

    await vi.advanceTimersByTimeAsync(30_000);

    await rejection;
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('rejects a malformed handshake so the bot can reconnect', async () => {
    const { client, socket } = gatewayHarness();
    const connection = client.connect('discord-token');

    socket.emitGateway({ op: 10, d: {} });

    await expect(connection).rejects.toThrow(/heartbeat_interval/);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it('identifies with only the intents required for mention commands', async () => {
    const { client, socket } = gatewayHarness();

    await connectGateway(client, socket);

    expect(JSON.parse(socket.sentPayloads[0]!)).toEqual({
      op: 2,
      d: {
        token: 'discord-token',
        intents: 33_281,
        properties: {
          os: process.platform,
          browser: 'boardsesh-issue-bot',
          device: 'boardsesh-issue-bot',
        },
      },
    });
    await client.destroy();
  });

  it('adapts MESSAGE_CREATE and writes reactions and replies through Discord REST', async () => {
    const { client, fetchImplementation, socket } = gatewayHarness();
    let receivedMessage: DiscordGatewayMessage | undefined;
    client.onMessage((message) => {
      receivedMessage = message;
    });
    await connectGateway(client, socket);

    socket.emitGateway({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 2,
      d: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author: { id: MAINTAINER_ID, bot: false },
        webhook_id: null,
        content: `<@${BOT_ID}> create an issue`,
        mentions: [{ id: BOT_ID }],
      },
    });

    expect(receivedMessage).toMatchObject({
      id: MESSAGE_ID,
      channelId: CHANNEL_ID,
      guildId: GUILD_ID,
      authorId: MAINTAINER_ID,
      authorIsBot: false,
      webhookId: null,
      content: `<@${BOT_ID}> create an issue`,
      botUserId: BOT_ID,
      botIsMentioned: true,
    });
    await receivedMessage!.react('👀');
    await receivedMessage!.reply('Queued');

    expect(fetchImplementation).toHaveBeenNthCalledWith(
      1,
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}/reactions/%F0%9F%91%80/@me`,
      { method: 'PUT', headers: { Authorization: 'Bot discord-token' } },
    );
    expect(fetchImplementation).toHaveBeenNthCalledWith(
      2,
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
      expect.objectContaining({ method: 'POST' }),
    );
    const replyRequest = fetchImplementation.mock.calls[1]?.[1];
    const replyBody = replyRequest?.body;
    if (typeof replyBody !== 'string') throw new Error('Expected a JSON string reply body');
    expect(JSON.parse(replyBody)).toEqual({
      content: 'Queued',
      message_reference: { message_id: MESSAGE_ID, channel_id: CHANNEL_ID, guild_id: GUILD_ID },
      allowed_mentions: { replied_user: false },
    });
    await client.destroy();
  });

  it('heartbeats with the latest sequence and reports an established disconnect', async () => {
    vi.useFakeTimers();
    const { client, socket } = gatewayHarness();
    const disconnectListener = vi.fn();
    client.onDisconnect(disconnectListener);

    await connectGateway(client, socket);
    socket.emitGateway({ op: 11, d: null });
    await vi.advanceTimersByTimeAsync(30_000);

    expect(JSON.parse(socket.sentPayloads.at(-1)!)).toEqual({ op: 1, d: 1 });
    socket.close(4000, 'restart');
    expect(disconnectListener).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('restart') }),
    );
  });
});

describe('Discord Gateway session recovery', () => {
  it('resumes with the last dispatch sequence and delivers missed messages before RESUMED', async () => {
    const { client, socket, sockets, createSocket } = gatewayHarness();
    const received = vi.fn();
    client.onMessage(received);
    await connectGateway(client, socket);
    socket.emitGateway({ op: 0, t: 'GUILD_CREATE', s: 7, d: {} });
    socket.emitGateway({ op: 7, d: null });

    const connection = client.connect('discord-token');
    const resumedSocket = sockets.at(-1)!;
    expect(createSocket).toHaveBeenLastCalledWith(`${RESUME_URL}?v=10&encoding=json`);
    resumedSocket.emitGateway({ op: 10, d: { heartbeat_interval: 30_000 } });
    expect(JSON.parse(resumedSocket.sentPayloads[0]!)).toEqual({
      op: 6,
      d: {
        token: 'discord-token',
        session_id: 'session-1',
        seq: 7,
      },
    });
    resumedSocket.emitGateway({
      op: 0,
      t: 'MESSAGE_CREATE',
      s: 8,
      d: {
        id: MESSAGE_ID,
        channel_id: CHANNEL_ID,
        guild_id: GUILD_ID,
        author: { id: MAINTAINER_ID },
        content: `<@${BOT_ID}> file this`,
        mentions: [{ id: BOT_ID }],
      },
    });
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ id: MESSAGE_ID, botIsMentioned: true }));
    resumedSocket.emitGateway({ op: 0, t: 'RESUMED', s: 9, d: {} });
    await connection;
    // Events arriving late from the previous socket cannot alter the session.
    socket.emitGateway({ op: 0, t: 'GUILD_CREATE', s: 999, d: {} });
    resumedSocket.emitGateway({ op: 1, d: null });
    expect(JSON.parse(resumedSocket.sentPayloads.at(-1)!)).toEqual({ op: 1, d: 9 });
    await client.destroy();
  });

  it.each([
    ['resumable invalid session', null, true, 6],
    ['non-resumable invalid session', null, false, 2],
    ['invalid sequence', 4007, null, 2],
    ['expired session', 4009, null, 2],
    ['normal close', 1000, null, 2],
    ['abnormal close', 1006, null, 6],
  ] as const)('chooses Resume or Identify after %s', async (_reason, closeCode, resumable, opcode) => {
    const { client, socket, sockets, createSocket } = gatewayHarness();
    await connectGateway(client, socket);
    if (closeCode === null) socket.emitGateway({ op: 9, d: resumable });
    else socket.close(closeCode);
    const connection = client.connect('discord-token');
    const resumedSocket = sockets.at(-1)!;
    resumedSocket.emitGateway({ op: 10, d: { heartbeat_interval: 30_000 } });
    expect(JSON.parse(resumedSocket.sentPayloads[0]!).op).toBe(opcode);
    expect(createSocket).toHaveBeenLastCalledWith(
      opcode === 6 ? `${RESUME_URL}?v=10&encoding=json` : 'wss://gateway.discord.gg/?v=10&encoding=json',
    );
    if (opcode === 6) resumedSocket.emitGateway({ op: 0, t: 'RESUMED', s: 2, d: {} });
    else
      resumedSocket.emitGateway({
        op: 0,
        t: 'READY',
        s: 1,
        d: {
          user: { id: BOT_ID },
          session_id: 'session-2',
          resume_gateway_url: RESUME_URL,
        },
      });
    await connection;
    await client.destroy();
  });

  it('preserves resume details after a reconnect handshake times out', async () => {
    vi.useFakeTimers();
    const { client, socket, sockets } = gatewayHarness();
    await connectGateway(client, socket);
    socket.terminate();
    const failedConnection = client.connect('discord-token');
    const rejection = expect(failedConnection).rejects.toThrow(/did not become ready/);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejection;
    const retry = client.connect('discord-token');
    const retrySocket = sockets.at(-1)!;
    retrySocket.emitGateway({ op: 10, d: { heartbeat_interval: 30_000 } });
    expect(JSON.parse(retrySocket.sentPayloads[0]!)).toEqual({
      op: 6,
      d: {
        token: 'discord-token',
        session_id: 'session-1',
        seq: 1,
      },
    });
    retrySocket.emitGateway({ op: 0, t: 'RESUMED', s: 2, d: {} });
    await retry;
    await client.destroy();
  });

  it('destroy rejects a pending handshake and clears cached session state', async () => {
    const { client, socket, sockets } = gatewayHarness();
    await connectGateway(client, socket);
    socket.terminate();
    const connecting = client.connect('discord-token');
    const rejection = expect(connecting).rejects.toThrow(/backend stopping/);
    await client.destroy();
    await rejection;
    const freshConnection = client.connect('discord-token');
    const freshSocket = sockets.at(-1)!;
    freshSocket.emitGateway({ op: 10, d: { heartbeat_interval: 30_000 } });
    expect(JSON.parse(freshSocket.sentPayloads[0]!).op).toBe(2);
    freshSocket.emitGateway({
      op: 0,
      t: 'READY',
      s: 1,
      d: {
        user: { id: BOT_ID },
        session_id: 'session-2',
        resume_gateway_url: RESUME_URL,
      },
    });
    await freshConnection;
    await client.destroy();
  });
});

async function receiveGatewayMessage(harness: ReturnType<typeof gatewayHarness>): Promise<DiscordGatewayMessage> {
  let receivedMessage: DiscordGatewayMessage | undefined;
  harness.client.onMessage((message) => {
    receivedMessage = message;
  });
  await connectGateway(harness.client, harness.socket);
  harness.socket.emitGateway({
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 2,
    d: {
      id: MESSAGE_ID,
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      author: { id: MAINTAINER_ID },
      content: `<@${BOT_ID}> file this`,
      mentions: [{ id: BOT_ID }],
    },
  });
  if (!receivedMessage) throw new Error('Expected the Gateway message');
  return receivedMessage;
}

describe('Discord Gateway REST rate limits', () => {
  it.each(['reaction', 'reply'] as const)(
    'waits for a 429 delay before retrying a %s with the same request',
    async (kind) => {
      const harness = gatewayHarness();
      const message = await receiveGatewayMessage(harness);
      let releaseDelay: () => void = () => undefined;
      const delay = new Promise<void>((resolve) => {
        releaseDelay = resolve;
      });
      harness.sleep.mockImplementationOnce(async () => delay);
      harness.fetchImplementation.mockResolvedValueOnce(
        kind === 'reaction'
          ? Response.json({ retry_after: 0.75, global: true }, { status: 429 })
          : new Response('rate limited', { status: 429, headers: { 'Retry-After': '0.75' } }),
      );
      const operation = kind === 'reaction' ? message.react('👀') : message.reply('Queued');
      const completion = operation.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.waitFor(() => expect(harness.sleep).toHaveBeenCalledWith(1000));
      expect(harness.fetchImplementation).toHaveBeenCalledTimes(1);
      releaseDelay();
      expect(await completion).toBeUndefined();
      expect(harness.fetchImplementation).toHaveBeenCalledTimes(2);
      expect(harness.fetchImplementation.mock.calls[1]).toEqual(harness.fetchImplementation.mock.calls[0]);
      await harness.client.destroy();
    },
  );

  it('bounds repeated rate limits and uses a safe delay for malformed retry metadata', async () => {
    const harness = gatewayHarness();
    const message = await receiveGatewayMessage(harness);
    harness.fetchImplementation.mockImplementation(async () =>
      Response.json({ retry_after: 'invalid' }, { status: 429 }),
    );
    await expect(message.reply('Queued')).rejects.toThrow(/429/);
    expect(harness.fetchImplementation).toHaveBeenCalledTimes(6);
    expect(harness.sleep.mock.calls).toEqual(Array.from({ length: 5 }, () => [1250]));
    await harness.client.destroy();
  });

  it('refuses a delay that would overflow Node timers instead of retrying immediately', async () => {
    const harness = gatewayHarness();
    const message = await receiveGatewayMessage(harness);
    harness.fetchImplementation.mockResolvedValueOnce(Response.json({ retry_after: 3_000_000 }, { status: 429 }));
    await expect(message.reply('Queued')).rejects.toThrow(/timer range/);
    expect(harness.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(harness.sleep).not.toHaveBeenCalled();
    await harness.client.destroy();
  });

  it.each([403, 500])('does not replay a reply after HTTP %s', async (status) => {
    const harness = gatewayHarness();
    const message = await receiveGatewayMessage(harness);
    harness.fetchImplementation.mockResolvedValueOnce(new Response('failed', { status }));
    await expect(message.reply('Queued')).rejects.toThrow(String(status));
    expect(harness.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(harness.sleep).not.toHaveBeenCalled();
    await harness.client.destroy();
  });

  it('does not replay an ambiguous reply after a network failure', async () => {
    const harness = gatewayHarness();
    const message = await receiveGatewayMessage(harness);
    harness.fetchImplementation.mockRejectedValueOnce(new Error('network failed'));
    await expect(message.reply('Queued')).rejects.toThrow('network failed');
    expect(harness.fetchImplementation).toHaveBeenCalledTimes(1);
    expect(harness.sleep).not.toHaveBeenCalled();
    await harness.client.destroy();
  });
});

describe('Discord Gateway heartbeat schedule', () => {
  it('jitters the first heartbeat only, then uses the full interval and latest sequence', async () => {
    vi.useFakeTimers();
    const { client, socket } = gatewayHarness(() => 0.25);
    await connectGateway(client, socket);
    await vi.advanceTimersByTimeAsync(7499);
    expect(socket.sentPayloads).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(socket.sentPayloads.at(-1)!)).toEqual({ op: 1, d: 1 });
    socket.emitGateway({ op: 11, d: null });
    socket.emitGateway({ op: 0, t: 'GUILD_CREATE', s: 8, d: {} });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(socket.sentPayloads).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(socket.sentPayloads.at(-1)!)).toEqual({ op: 1, d: 8 });
    await client.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('terminates when the jittered first heartbeat is not acknowledged', async () => {
    vi.useFakeTimers();
    const { client, socket } = gatewayHarness(() => 0.25);
    await connectGateway(client, socket);
    await vi.advanceTimersByTimeAsync(37_500);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the pending first heartbeat on destroy', async () => {
    vi.useFakeTimers();
    const { client, socket } = gatewayHarness(() => 0.25);
    await connectGateway(client, socket);
    await client.destroy();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.sentPayloads).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
