import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { redisClientManager } from '../../redis/client';
import type { DiscordGatewayClient, DiscordGatewayMessage } from '../discord-gateway-client';

import {
  acquireDiscordIssueCommandClaim,
  extractDiscordIssueInstruction,
  handleDiscordIssueCommand,
  resetDiscordIssueCommandClaimsForTests,
  startDiscordIssueBotFromEnvironment,
  type DiscordIssueCommandMessage,
} from '../discord-issue-bot';

const BOT_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const MAINTAINER_ID = '300000000000000001';

beforeEach(() => {
  resetDiscordIssueCommandClaimsForTests();
});

afterEach(() => {
  resetDiscordIssueCommandClaimsForTests();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

function command(overrides: Partial<DiscordIssueCommandMessage> = {}): DiscordIssueCommandMessage {
  return {
    id: '400000000000000001',
    channelId: '500000000000000001',
    guildId: GUILD_ID,
    authorId: MAINTAINER_ID,
    authorIsBot: false,
    webhookId: null,
    content: `<@${BOT_ID}> create an issue from this thread`,
    botUserId: BOT_ID,
    botIsMentioned: true,
    react: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    ...overrides,
  };
}

function dependencies() {
  const release = vi.fn(async () => undefined);
  return {
    release,
    acquireClaim: vi.fn(async () => ({ release })),
    dispatcher: { dispatchDiscordIssueWorkflow: vi.fn(async () => undefined) },
    allowedGuildId: GUILD_ID,
    allowedUserIds: new Set([MAINTAINER_ID]),
  };
}

describe('handleDiscordIssueCommand', () => {
  it('dispatches only message coordinates and acknowledges with eyes', async () => {
    const discordMessage = command();
    const deps = dependencies();

    await handleDiscordIssueCommand(discordMessage, deps);

    expect(deps.dispatcher.dispatchDiscordIssueWorkflow).toHaveBeenCalledWith({
      channelId: discordMessage.channelId,
      triggerMessageId: discordMessage.id,
    });
    expect(discordMessage.react).toHaveBeenCalledWith('👀');
    expect(discordMessage.reply).not.toHaveBeenCalled();
  });

  it('ignores messages outside the guild, allowlist, and bot mention', async () => {
    for (const discordMessage of [
      command({ guildId: 'elsewhere' }),
      command({ authorId: 'not-allowed' }),
      command({ botIsMentioned: false }),
      command({ authorIsBot: true }),
      command({ webhookId: 'webhook' }),
    ]) {
      const deps = dependencies();
      await handleDiscordIssueCommand(discordMessage, deps);
      expect(deps.acquireClaim).not.toHaveBeenCalled();
      expect(deps.dispatcher.dispatchDiscordIssueWorkflow).not.toHaveBeenCalled();
    }
  });

  it('rejects an empty instruction before acquiring a claim', async () => {
    const discordMessage = command({ content: `<@!${BOT_ID}>` });
    const deps = dependencies();
    await handleDiscordIssueCommand(discordMessage, deps);
    expect(deps.acquireClaim).not.toHaveBeenCalled();
    expect(discordMessage.react).toHaveBeenCalledWith('❌');
    expect(discordMessage.reply).toHaveBeenCalled();
  });

  it('releases the claim and reports a dispatch failure', async () => {
    const discordMessage = command();
    const deps = dependencies();
    deps.dispatcher.dispatchDiscordIssueWorkflow.mockRejectedValueOnce(new Error('GitHub unavailable'));

    await handleDiscordIssueCommand(discordMessage, deps);

    expect(deps.release).toHaveBeenCalledOnce();
    expect(discordMessage.react).toHaveBeenCalledWith('❌');
    expect(discordMessage.reply).toHaveBeenCalled();
  });

  it('ignores a duplicate command claim', async () => {
    const discordMessage = command();
    const deps = dependencies();
    const acquireClaim = vi.fn(async () => null);
    await handleDiscordIssueCommand(discordMessage, { ...deps, acquireClaim });
    expect(deps.dispatcher.dispatchDiscordIssueWorkflow).not.toHaveBeenCalled();
  });
});

it('normalizes both Discord bot mention forms', () => {
  expect(extractDiscordIssueInstruction(`ignore this prefix <@!${BOT_ID}>  make two issues  `, BOT_ID)).toBe(
    'make two issues',
  );
  expect(extractDiscordIssueInstruction('<@100.001> create this', '100.001')).toBe('create this');
  expect(extractDiscordIssueInstruction('<@100x001> create this', '100.001')).toBe('');
});

describe('acquireDiscordIssueCommandClaim', () => {
  it('uses SET NX with a TTL and releases only its own Redis token', async () => {
    let claimToken: string | undefined;
    const set = vi.fn(async (_key: string, token: string) => {
      claimToken = token;
      return 'OK';
    });
    const evalCommand = vi.fn(async () => 1);
    const publisher = { set, eval: evalCommand };
    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
    vi.spyOn(redisClientManager, 'getClients').mockReturnValue({
      publisher,
      subscriber: publisher,
      streamConsumer: publisher,
    } as unknown as ReturnType<typeof redisClientManager.getClients>);

    const claim = await acquireDiscordIssueCommandClaim('400000000000000009');

    expect(claim).not.toBeNull();
    expect(set).toHaveBeenCalledWith('discord:issue-command:400000000000000009', expect.any(String), 'EX', 900, 'NX');
    await claim?.release();
    expect(evalCommand).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get', KEYS[1]) == ARGV[1]"),
      1,
      'discord:issue-command:400000000000000009',
      claimToken,
    );
  });

  it('rejects a duplicate Redis claim', async () => {
    const publisher = { set: vi.fn(async () => null) };
    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(true);
    vi.spyOn(redisClientManager, 'getClients').mockReturnValue({
      publisher,
      subscriber: publisher,
      streamConsumer: publisher,
    } as unknown as ReturnType<typeof redisClientManager.getClients>);

    await expect(acquireDiscordIssueCommandClaim('400000000000000010')).resolves.toBeNull();
  });

  it('allows a local fallback claim to be acquired again after its TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-03T00:00:00.000Z'));
    vi.spyOn(redisClientManager, 'isRedisConnected').mockReturnValue(false);

    const firstClaim = await acquireDiscordIssueCommandClaim('400000000000000012');
    await expect(acquireDiscordIssueCommandClaim('400000000000000012')).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(15 * 60_000 + 1);
    const renewedClaim = await acquireDiscordIssueCommandClaim('400000000000000012');

    expect(firstClaim).not.toBeNull();
    expect(renewedClaim).not.toBeNull();
    await renewedClaim?.release();
  });
});

type FakeDiscordClient = {
  client: DiscordGatewayClient;
  connect: Mock<(token: string) => Promise<void>>;
  destroy: ReturnType<typeof vi.fn>;
  emitDisconnect: (error: Error) => void;
  emitMessage: (message: DiscordGatewayMessage) => void;
};

function fakeDiscordClient(
  connect: Mock<(token: string) => Promise<void>> = vi.fn(async () => undefined),
): FakeDiscordClient {
  let messageListener: (message: DiscordGatewayMessage) => void = () => undefined;
  let disconnectListener: (error: Error) => void = () => undefined;
  const destroy = vi.fn(async () => undefined);
  const client: DiscordGatewayClient = {
    connect,
    destroy,
    onMessage: (listener) => {
      messageListener = listener;
    },
    onError: () => undefined,
    onDisconnect: (listener) => {
      disconnectListener = listener;
    },
  };
  return {
    client,
    connect,
    destroy,
    emitDisconnect: (error) => disconnectListener(error),
    emitMessage: (message) => messageListener(message),
  };
}

function enableBotEnvironment(): void {
  vi.stubEnv('DISCORD_ISSUE_BOT_ENABLED', 'true');
  vi.stubEnv('DISCORD_BOT_TOKEN', 'discord-token');
  vi.stubEnv('DISCORD_GUILD_ID', GUILD_ID);
  vi.stubEnv('DISCORD_ISSUE_TRIGGER_USER_IDS', MAINTAINER_ID);
}

describe('startDiscordIssueBotFromEnvironment', () => {
  it('feeds Discord MESSAGE_CREATE events into the command handler', async () => {
    enableBotEnvironment();
    const fakeClient = fakeDiscordClient();
    const dispatchDiscordIssueWorkflow = vi.fn(async () => undefined);
    const react = vi.fn(async () => undefined);
    const reply = vi.fn(async () => undefined);
    const handle = startDiscordIssueBotFromEnvironment({
      createClient: () => fakeClient.client,
      createDispatcher: () => ({ dispatchDiscordIssueWorkflow }),
    });

    fakeClient.emitMessage({
      id: '400000000000000011',
      channelId: '500000000000000001',
      guildId: GUILD_ID,
      authorId: MAINTAINER_ID,
      authorIsBot: false,
      webhookId: null,
      content: `<@${BOT_ID}> create an issue`,
      botUserId: BOT_ID,
      botIsMentioned: true,
      react,
      reply,
    });

    await vi.waitFor(() => expect(dispatchDiscordIssueWorkflow).toHaveBeenCalledOnce());
    expect(react).toHaveBeenCalledWith('👀');
    expect(reply).not.toHaveBeenCalled();
    await handle?.stop();
  });

  it('retries a failed initial Gateway login and can stop cleanly', async () => {
    enableBotEnvironment();
    vi.useFakeTimers();
    const connect = vi
      .fn<(token: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('gateway unavailable'))
      .mockResolvedValueOnce(undefined);
    const fakeClient = fakeDiscordClient(connect);
    const handle = startDiscordIssueBotFromEnvironment({
      createClient: () => fakeClient.client,
      createDispatcher: () => ({ dispatchDiscordIssueWorkflow: vi.fn(async () => undefined) }),
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(connect).toHaveBeenCalledTimes(2);

    await handle?.stop();
    expect(fakeClient.destroy).toHaveBeenCalled();
  });

  it('reconnects after an established Gateway connection closes', async () => {
    enableBotEnvironment();
    vi.useFakeTimers();
    const fakeClient = fakeDiscordClient();
    const handle = startDiscordIssueBotFromEnvironment({
      createClient: () => fakeClient.client,
      createDispatcher: () => ({ dispatchDiscordIssueWorkflow: vi.fn(async () => undefined) }),
    });

    await vi.waitFor(() => expect(fakeClient.connect).toHaveBeenCalledOnce());
    fakeClient.emitDisconnect(new Error('connection dropped'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fakeClient.connect).toHaveBeenCalledTimes(2);
    await handle?.stop();
  });
});
