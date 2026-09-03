import { randomUUID } from 'node:crypto';
import { redisClientManager } from '../redis/client';
import { logger } from '../utils/logger';
import {
  createDiscordGatewayClient,
  type DiscordGatewayClient,
  type DiscordGatewayMessage,
} from './discord-gateway-client';
import {
  createGitHubActionsDispatcherFromEnvironment,
  type GitHubActionsDispatcher,
} from './github-actions-dispatcher';

const CLAIM_TTL_SECONDS = 15 * 60;
const INITIAL_CONNECT_RETRY_MS = 5_000;
const MAX_CONNECT_RETRY_MS = 5 * 60_000;
const FAILURE_REPLY = 'I could not start the issue workflow. Please mention me again to retry.';
const EMPTY_INSTRUCTION_REPLY = 'Add a short instruction after my mention, then try again.';

type CommandClaim = {
  release: () => Promise<void>;
};

export type DiscordIssueCommandMessage = {
  id: string;
  channelId: string;
  guildId: string | null;
  authorId: string;
  authorIsBot: boolean;
  webhookId: string | null;
  content: string;
  botUserId: string;
  botIsMentioned: boolean;
  react: (emoji: string) => Promise<unknown>;
  reply: (content: string) => Promise<unknown>;
};

type DiscordIssueCommandDependencies = {
  allowedGuildId: string;
  allowedUserIds: ReadonlySet<string>;
  acquireClaim: (messageId: string) => Promise<CommandClaim | null>;
  dispatcher: GitHubActionsDispatcher;
};

export type DiscordIssueBotHandle = {
  stop: () => Promise<void>;
};

export type DiscordIssueBotStartDependencies = {
  createClient?: () => DiscordGatewayClient;
  createDispatcher?: () => GitHubActionsDispatcher;
};

const localClaims = new Map<string, number>();

export function resetDiscordIssueCommandClaimsForTests(): void {
  localClaims.clear();
}

function pruneLocalClaims(nowMilliseconds: number): void {
  for (const [messageId, expiresAt] of localClaims) {
    if (expiresAt <= nowMilliseconds) localClaims.delete(messageId);
  }
}

async function acquireLocalClaim(messageId: string): Promise<CommandClaim | null> {
  const nowMilliseconds = Date.now();
  pruneLocalClaims(nowMilliseconds);
  if (localClaims.has(messageId)) return null;
  localClaims.set(messageId, nowMilliseconds + CLAIM_TTL_SECONDS * 1000);
  return {
    release: async () => {
      localClaims.delete(messageId);
    },
  };
}

export async function acquireDiscordIssueCommandClaim(messageId: string): Promise<CommandClaim | null> {
  if (!redisClientManager.isRedisConnected()) return acquireLocalClaim(messageId);

  const claimKey = `discord:issue-command:${messageId}`;
  const claimToken = randomUUID();
  try {
    const { publisher } = redisClientManager.getClients();
    const result = await publisher.set(claimKey, claimToken, 'EX', CLAIM_TTL_SECONDS, 'NX');
    if (result !== 'OK') return null;
    return {
      release: async () => {
        await publisher.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          claimKey,
          claimToken,
        );
      },
    };
  } catch (error) {
    logger.warn('[discord-issue-bot] Redis claim failed; using process-local duplicate suppression', error);
    return acquireLocalClaim(messageId);
  }
}

export function extractDiscordIssueInstruction(content: string, botUserId: string): string {
  const escapedBotUserId = botUserId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const mentionMatch = content.match(new RegExp(`<@!?${escapedBotUserId}>`));
  if (mentionMatch?.index === undefined) return '';
  return content
    .slice(mentionMatch.index + mentionMatch[0].length)
    .replaceAll(`<@${botUserId}>`, ' ')
    .replaceAll(`<@!${botUserId}>`, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function signalCommandFailure(message: DiscordIssueCommandMessage, reply: string): Promise<void> {
  await Promise.allSettled([message.react('❌'), message.reply(reply)]);
}

export async function handleDiscordIssueCommand(
  message: DiscordIssueCommandMessage,
  dependencies: DiscordIssueCommandDependencies,
): Promise<void> {
  if (message.guildId !== dependencies.allowedGuildId) return;
  if (message.authorIsBot || message.webhookId !== null) return;
  if (!dependencies.allowedUserIds.has(message.authorId)) return;
  if (!message.botIsMentioned) return;

  const instruction = extractDiscordIssueInstruction(message.content, message.botUserId);
  if (instruction.length === 0) {
    logger.info('[discord-issue-bot] Rejected command with no instruction', {
      channelId: message.channelId,
      triggerMessageId: message.id,
    });
    await signalCommandFailure(message, EMPTY_INSTRUCTION_REPLY);
    return;
  }

  const claim = await dependencies.acquireClaim(message.id);
  if (claim === null) {
    logger.info('[discord-issue-bot] Ignored duplicate command', { triggerMessageId: message.id });
    return;
  }

  try {
    await dependencies.dispatcher.dispatchDiscordIssueWorkflow({
      channelId: message.channelId,
      triggerMessageId: message.id,
    });
    logger.info('[discord-issue-bot] Dispatched workflow', {
      channelId: message.channelId,
      triggerMessageId: message.id,
    });
    try {
      await message.react('👀');
    } catch (error) {
      logger.warn('[discord-issue-bot] Workflow dispatched but acknowledgement reaction failed', error);
    }
  } catch (error) {
    await claim.release().catch((releaseError: unknown) => {
      logger.warn('[discord-issue-bot] Failed to release command claim', releaseError);
    });
    logger.error('[discord-issue-bot] Workflow dispatch failed', error);
    await signalCommandFailure(message, FAILURE_REPLY);
  }
}

function adaptDiscordMessage(message: DiscordGatewayMessage): DiscordIssueCommandMessage {
  return {
    id: message.id,
    channelId: message.channelId,
    guildId: message.guildId,
    authorId: message.authorId,
    authorIsBot: message.authorIsBot,
    webhookId: message.webhookId,
    content: message.content,
    botUserId: message.botUserId,
    botIsMentioned: message.botIsMentioned,
    react: message.react,
    reply: message.reply,
  };
}

function readRequiredBotConfig(): {
  token: string;
  guildId: string;
  allowedUserIds: ReadonlySet<string>;
} {
  const token = process.env.DISCORD_BOT_TOKEN?.trim();
  const guildId = process.env.DISCORD_GUILD_ID?.trim();
  const allowedUserIds = new Set(
    (process.env.DISCORD_ISSUE_TRIGGER_USER_IDS ?? '')
      .split(/[\s,]+/)
      .map((userId) => userId.trim())
      .filter(Boolean),
  );
  if (!token || !guildId || allowedUserIds.size === 0) {
    throw new Error(
      'DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, and DISCORD_ISSUE_TRIGGER_USER_IDS are required when the issue bot is enabled',
    );
  }
  if (!/^\d{16,20}$/.test(guildId) || [...allowedUserIds].some((userId) => !/^\d{16,20}$/.test(userId))) {
    throw new Error('DISCORD_GUILD_ID and every DISCORD_ISSUE_TRIGGER_USER_IDS entry must be Discord snowflakes');
  }
  return { token, guildId, allowedUserIds };
}

export function startDiscordIssueBotFromEnvironment(
  dependencies: DiscordIssueBotStartDependencies = {},
): DiscordIssueBotHandle | null {
  if (process.env.DISCORD_ISSUE_BOT_ENABLED !== 'true') {
    logger.info('[discord-issue-bot] Disabled');
    return null;
  }

  const { token, guildId, allowedUserIds } = readRequiredBotConfig();
  const dispatcher = (dependencies.createDispatcher ?? createGitHubActionsDispatcherFromEnvironment)();
  const client = dependencies.createClient?.() ?? createDiscordGatewayClient();

  client.onMessage((discordMessage) => {
    void handleDiscordIssueCommand(adaptDiscordMessage(discordMessage), {
      allowedGuildId: guildId,
      allowedUserIds,
      acquireClaim: acquireDiscordIssueCommandClaim,
      dispatcher,
    });
  });
  client.onError((error) => {
    logger.error('[discord-issue-bot] Discord client error', error);
  });

  let stopped = false;
  let retryDelayMilliseconds = INITIAL_CONNECT_RETRY_MS;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let failedConnectionAttempts = 0;

  const scheduleReconnect = (error: unknown): void => {
    if (stopped || retryTimer !== null) return;
    failedConnectionAttempts += 1;
    const message = `[discord-issue-bot] Connection failed; retrying in ${retryDelayMilliseconds}ms`;
    if (failedConnectionAttempts === 1) logger.error(message, error);
    else logger.warn(message, error);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect();
    }, retryDelayMilliseconds);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
    retryDelayMilliseconds = Math.min(retryDelayMilliseconds * 2, MAX_CONNECT_RETRY_MS);
  };

  const connect = async (): Promise<void> => {
    try {
      await client.connect(token);
      if (stopped) {
        await client.destroy();
        return;
      }
      failedConnectionAttempts = 0;
      retryDelayMilliseconds = INITIAL_CONNECT_RETRY_MS;
      logger.info('[discord-issue-bot] Connected', { guildId, allowedUserCount: allowedUserIds.size });
    } catch (error) {
      await client.destroy().catch(() => undefined);
      scheduleReconnect(error);
    }
  };

  client.onDisconnect((error) => {
    scheduleReconnect(error);
  });

  logger.info('[discord-issue-bot] Starting', { guildId, allowedUserCount: allowedUserIds.size });
  void connect();

  return {
    stop: async () => {
      stopped = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      await client.destroy();
      logger.info('[discord-issue-bot] Disconnected');
    },
  };
}
