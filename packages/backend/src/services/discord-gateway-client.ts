import { WebSocket, type RawData } from 'ws';

const DISCORD_API_ROOT = 'https://discord.com/api/v10';
const DISCORD_GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
const GATEWAY_HANDSHAKE_TIMEOUT_MS = 30_000;

const GATEWAY_DISPATCH = 0;
const GATEWAY_HEARTBEAT = 1;
const GATEWAY_IDENTIFY = 2;
const GATEWAY_RECONNECT = 7;
const GATEWAY_INVALID_SESSION = 9;
const GATEWAY_HELLO = 10;
const GATEWAY_HEARTBEAT_ACK = 11;

type JsonRecord = Record<string, unknown>;

export type DiscordGatewayMessage = {
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorIsBot: boolean;
  webhookId: string | null;
  content: string;
  botUserId: string;
  botIsMentioned: boolean;
  react: (emoji: string) => Promise<void>;
  reply: (content: string) => Promise<void>;
};

export type DiscordGatewayClient = {
  onMessage: (listener: (message: DiscordGatewayMessage) => void) => void;
  onError: (listener: (error: unknown) => void) => void;
  onDisconnect: (listener: (error: Error) => void) => void;
  connect: (token: string) => Promise<void>;
  destroy: () => Promise<void>;
};

export type DiscordGatewayClientOptions = {
  fetchImplementation?: typeof fetch;
  createSocket?: (url: string) => WebSocket;
};

function isJsonRecord(input: unknown): input is JsonRecord {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

function rawDataToText(rawData: RawData): string {
  if (rawData instanceof ArrayBuffer) return Buffer.from(rawData).toString('utf8');
  if (Array.isArray(rawData)) return Buffer.concat(rawData).toString('utf8');
  return rawData.toString('utf8');
}

function parseGatewayMessage(
  gatewayPayload: JsonRecord,
  botUserId: string,
  token: string,
  requestDiscord: (path: string, init: RequestInit) => Promise<void>,
): DiscordGatewayMessage | null {
  if (!isJsonRecord(gatewayPayload.d)) return null;
  const messagePayload = gatewayPayload.d;
  const author = isJsonRecord(messagePayload.author) ? messagePayload.author : null;
  if (
    typeof messagePayload.id !== 'string' ||
    typeof messagePayload.channel_id !== 'string' ||
    typeof messagePayload.content !== 'string' ||
    author === null ||
    typeof author.id !== 'string'
  ) {
    return null;
  }

  const guildId = typeof messagePayload.guild_id === 'string' ? messagePayload.guild_id : null;
  const webhookId = typeof messagePayload.webhook_id === 'string' ? messagePayload.webhook_id : null;
  const mentionedUserIds = Array.isArray(messagePayload.mentions)
    ? messagePayload.mentions.flatMap((mention) =>
        isJsonRecord(mention) && typeof mention.id === 'string' ? [mention.id] : [],
      )
    : [];
  const messageId = messagePayload.id;
  const channelId = messagePayload.channel_id;

  return {
    id: messageId,
    channelId,
    guildId,
    authorId: author.id,
    authorIsBot: author.bot === true,
    webhookId,
    content: messagePayload.content,
    botUserId,
    botIsMentioned: mentionedUserIds.includes(botUserId),
    react: async (emoji) => {
      await requestDiscord(
        `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
        { method: 'PUT', headers: { Authorization: `Bot ${token}` } },
      );
    },
    reply: async (content) => {
      await requestDiscord(`/channels/${encodeURIComponent(channelId)}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          message_reference: {
            message_id: messageId,
            channel_id: channelId,
            ...(guildId === null ? {} : { guild_id: guildId }),
          },
          allowed_mentions: { replied_user: false },
        }),
      });
    },
  };
}

export function createDiscordGatewayClient(options: DiscordGatewayClientOptions = {}): DiscordGatewayClient {
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));

  let socket: WebSocket | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let sequenceNumber: number | null = null;
  let botUserId: string | null = null;
  let intentionallyClosed = false;
  let messageListener: (message: DiscordGatewayMessage) => void = () => undefined;
  let errorListener: (error: unknown) => void = () => undefined;
  let disconnectListener: (error: Error) => void = () => undefined;

  const clearHeartbeat = (): void => {
    if (heartbeatTimer === null) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };

  const requestDiscord = async (path: string, init: RequestInit): Promise<void> => {
    const response = await fetchImplementation(`${DISCORD_API_ROOT}${path}`, init);
    if (response.ok) return;
    const responseText = await response.text();
    throw new Error(
      `Discord REST request failed (${response.status}): ${responseText.slice(0, 500) || response.statusText}`,
    );
  };

  return {
    onMessage(listener): void {
      messageListener = listener;
    },
    onError(listener): void {
      errorListener = listener;
    },
    onDisconnect(listener): void {
      disconnectListener = listener;
    },
    async connect(token): Promise<void> {
      if (socket !== null) throw new Error('Discord Gateway client is already connected');
      intentionallyClosed = false;
      sequenceNumber = null;
      botUserId = null;

      await new Promise<void>((resolve, reject) => {
        const currentSocket = createSocket(DISCORD_GATEWAY_URL);
        socket = currentSocket;
        let connectionResolved = false;
        let connectionRejected = false;
        let disconnectHandled = false;
        let heartbeatAcknowledged = true;
        let handshakeTimer: ReturnType<typeof setTimeout> | null = null;

        const clearHandshakeTimer = (): void => {
          if (handshakeTimer === null) return;
          clearTimeout(handshakeTimer);
          handshakeTimer = null;
        };

        const sendGatewayPayload = (payload: JsonRecord): void => {
          if (currentSocket.readyState !== WebSocket.OPEN) return;
          currentSocket.send(JSON.stringify(payload));
        };
        const sendHeartbeat = (): void => {
          heartbeatAcknowledged = false;
          sendGatewayPayload({ op: GATEWAY_HEARTBEAT, d: sequenceNumber });
        };
        const handleDisconnect = (error: Error): void => {
          if (disconnectHandled) return;
          disconnectHandled = true;
          clearHeartbeat();
          clearHandshakeTimer();
          if (socket === currentSocket) socket = null;
          if (intentionallyClosed) {
            if (!connectionResolved && !connectionRejected) {
              connectionRejected = true;
              reject(error);
            }
            return;
          }
          if (!connectionResolved && !connectionRejected) {
            connectionRejected = true;
            reject(error);
            return;
          }
          if (connectionResolved) disconnectListener(error);
        };

        handshakeTimer = setTimeout(() => {
          handleDisconnect(new Error(`Discord Gateway did not become ready within ${GATEWAY_HANDSHAKE_TIMEOUT_MS}ms`));
          currentSocket.terminate();
        }, GATEWAY_HANDSHAKE_TIMEOUT_MS);
        if (typeof handshakeTimer.unref === 'function') handshakeTimer.unref();

        currentSocket.on('message', (rawData: RawData) => {
          try {
            const parsedPayload: unknown = JSON.parse(rawDataToText(rawData));
            if (!isJsonRecord(parsedPayload) || typeof parsedPayload.op !== 'number') return;
            if (typeof parsedPayload.s === 'number') sequenceNumber = parsedPayload.s;

            if (parsedPayload.op === GATEWAY_HELLO) {
              if (!isJsonRecord(parsedPayload.d) || typeof parsedPayload.d.heartbeat_interval !== 'number') {
                throw new Error('Discord Gateway HELLO omitted heartbeat_interval');
              }
              clearHeartbeat();
              heartbeatAcknowledged = true;
              heartbeatTimer = setInterval(() => {
                if (!heartbeatAcknowledged) {
                  currentSocket.terminate();
                  return;
                }
                sendHeartbeat();
              }, parsedPayload.d.heartbeat_interval);
              if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
              sendGatewayPayload({
                op: GATEWAY_IDENTIFY,
                d: {
                  token,
                  intents: DISCORD_GATEWAY_INTENTS,
                  properties: {
                    os: process.platform,
                    browser: 'boardsesh-issue-bot',
                    device: 'boardsesh-issue-bot',
                  },
                },
              });
              return;
            }

            if (parsedPayload.op === GATEWAY_HEARTBEAT_ACK) {
              heartbeatAcknowledged = true;
              return;
            }
            if (parsedPayload.op === GATEWAY_HEARTBEAT) {
              sendHeartbeat();
              return;
            }
            if (parsedPayload.op === GATEWAY_RECONNECT || parsedPayload.op === GATEWAY_INVALID_SESSION) {
              currentSocket.close(4000, 'Discord requested reconnect');
              return;
            }
            if (parsedPayload.op !== GATEWAY_DISPATCH || typeof parsedPayload.t !== 'string') return;

            if (parsedPayload.t === 'READY') {
              const readyPayload = isJsonRecord(parsedPayload.d) ? parsedPayload.d : null;
              const readyUser = readyPayload !== null && isJsonRecord(readyPayload.user) ? readyPayload.user : null;
              if (readyUser === null || typeof readyUser.id !== 'string') {
                throw new Error('Discord Gateway READY omitted the bot user id');
              }
              botUserId = readyUser.id;
              if (!connectionResolved && !connectionRejected) {
                connectionResolved = true;
                clearHandshakeTimer();
                resolve();
              }
              return;
            }

            if (parsedPayload.t === 'MESSAGE_CREATE' && botUserId !== null) {
              const discordMessage = parseGatewayMessage(parsedPayload, botUserId, token, requestDiscord);
              if (discordMessage !== null) messageListener(discordMessage);
            }
          } catch (error) {
            errorListener(error);
            handleDisconnect(error instanceof Error ? error : new Error(String(error)));
            currentSocket.terminate();
          }
        });
        currentSocket.on('error', (error) => {
          errorListener(error);
          handleDisconnect(error);
          currentSocket.terminate();
        });
        currentSocket.on('close', (code, reason) => {
          handleDisconnect(
            new Error(`Discord Gateway closed (${code}): ${reason.toString('utf8') || 'no reason provided'}`),
          );
        });
      });
    },
    async destroy(): Promise<void> {
      intentionallyClosed = true;
      clearHeartbeat();
      const currentSocket = socket;
      socket = null;
      if (currentSocket === null) return;
      if (currentSocket.readyState === WebSocket.OPEN || currentSocket.readyState === WebSocket.CONNECTING) {
        currentSocket.close(1000, 'Boardsesh backend stopping');
      }
    },
  };
}
