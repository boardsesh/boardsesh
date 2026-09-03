import { WebSocket } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiscordGatewayClient, type DiscordGatewayMessage } from '../discord-gateway-client';

const BOT_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const MAINTAINER_ID = '300000000000000001';
const MESSAGE_ID = '400000000000000001';
const CHANNEL_ID = '500000000000000001';

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

function gatewayHarness() {
  const socket = new FakeSocket();
  const fetchImplementation = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
  const client = createDiscordGatewayClient({
    fetchImplementation,
    createSocket: () => socket as unknown as WebSocket,
  });
  return { client, fetchImplementation, socket };
}

async function connectGateway(
  client: ReturnType<typeof createDiscordGatewayClient>,
  socket: FakeSocket,
): Promise<void> {
  const connection = client.connect('discord-token');
  socket.emitGateway({ op: 10, d: { heartbeat_interval: 30_000 } });
  socket.emitGateway({ op: 0, t: 'READY', s: 1, d: { user: { id: BOT_ID } } });
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
