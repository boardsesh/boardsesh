import { describe, expect, it, vi } from 'vitest';

import {
  extractDiscordIssueInstruction,
  handleDiscordIssueCommand,
  type DiscordIssueCommandMessage,
} from '../discord-issue-bot';

const BOT_ID = '100000000000000001';
const GUILD_ID = '200000000000000001';
const MAINTAINER_ID = '300000000000000001';

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
});
