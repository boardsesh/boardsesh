import { describe, expect, it, vi } from 'vitest';

import {
  applyTriage,
  collectFeedback,
  DiscordClient,
  parseCliOptions,
  type ApplyOptions,
  type CollectBundle,
  type CollectOptions,
  type DiscordSource,
  type DiscordWriter,
  type IssueSink,
} from '../discord-feedback-scan';
import {
  authorRef,
  buildCollectedMessage,
  containsTriggerKeyword,
  hasReactionByAnyone,
  hasReactionFromMe,
  isCollectableMessage,
  isLikelyNoise,
  snowflakeForTimestamp,
  timestampFromSnowflake,
  type DiscordMessage,
} from '../lib/discord-feedback';
import { buildIssueDraft, discordFeedbackMarker, validateTriageResult } from '../lib/discord-feedback-issue';

const GUILD = '111111111111111111';
const CHANNEL = '222222222222222222';

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: '900000000000000001',
    channel_id: CHANNEL,
    type: 0,
    content: 'The board list takes 30 seconds to load on my Pixel 8.',
    timestamp: '2026-08-10T10:00:00.000Z',
    author: { id: '777777777777777777', bot: false, username: 'climber_marco' },
    attachments: [],
    reactions: [],
    ...overrides,
  };
}

function collected(overrides: Partial<ReturnType<typeof buildCollectedMessage>> = {}) {
  return {
    ...buildCollectedMessage({
      message: message(),
      guildId: GUILD,
      channelName: 'user-feedback',
      trigger: 'feedback-channel',
    }),
    ...overrides,
  };
}

describe('snowflake maths', () => {
  it('maps the Discord epoch to zero', () => {
    expect(snowflakeForTimestamp(1_420_070_400_000)).toBe('0');
    expect(snowflakeForTimestamp(1_420_070_400_001)).toBe('4194304');
  });

  it('round-trips a realistic timestamp without losing precision', () => {
    const when = Date.parse('2026-08-10T10:00:00.000Z');
    expect(timestampFromSnowflake(snowflakeForTimestamp(when))).toBe(when);
  });

  it('clamps timestamps before the epoch instead of going negative', () => {
    expect(snowflakeForTimestamp(0)).toBe('0');
  });
});

describe('reaction matching', () => {
  it('detects our own processed reaction', () => {
    const withMine = message({ reactions: [{ count: 1, me: true, emoji: { name: '✅' } }] });
    expect(hasReactionFromMe(withMine, '✅')).toBe(true);
    expect(hasReactionFromMe(withMine, '🐛')).toBe(false);
  });

  it('does not treat other people reacting as our own reaction', () => {
    const theirs = message({ reactions: [{ count: 3, me: false, emoji: { name: '✅' } }] });
    expect(hasReactionFromMe(theirs, '✅')).toBe(false);
    expect(hasReactionByAnyone(theirs, '✅')).toBe(true);
  });

  it('matches custom emoji on id, not name', () => {
    const custom = message({ reactions: [{ count: 1, emoji: { id: '123456789012345678', name: 'bugsplat' } }] });
    expect(hasReactionByAnyone(custom, 'bugsplat:123456789012345678')).toBe(true);
    expect(hasReactionByAnyone(custom, 'renamed:123456789012345678')).toBe(true);
    expect(hasReactionByAnyone(custom, 'bugsplat:999999999999999999')).toBe(false);
  });

  it('handles a message with no reactions array', () => {
    expect(hasReactionFromMe(message({ reactions: undefined }), '✅')).toBe(false);
    expect(hasReactionByAnyone(message({ reactions: undefined }), '🐛')).toBe(false);
  });
});

describe('containsTriggerKeyword', () => {
  const keywords = ['bug', 'file this', 'feature request'];

  it('matches whole words and phrases, case-insensitively', () => {
    expect(containsTriggerKeyword('this is a Bug', keywords)).toBe(true);
    expect(containsTriggerKeyword('please file this', keywords)).toBe(true);
  });

  it('does not fire on a substring', () => {
    expect(containsTriggerKeyword('I spent the day debugging', keywords)).toBe(false);
    expect(containsTriggerKeyword('debugger output', keywords)).toBe(false);
  });
});

describe('isLikelyNoise', () => {
  it('drops chatter', () => {
    expect(isLikelyNoise('thanks!')).toBe(true);
    expect(isLikelyNoise('+1')).toBe(true);
    expect(isLikelyNoise('👍👍👍')).toBe(true);
    expect(isLikelyNoise('   ')).toBe(true);
  });

  it('keeps a real report', () => {
    expect(isLikelyNoise('The queue empties when I background the app on Android.')).toBe(false);
  });
});

describe('isCollectableMessage', () => {
  it('skips bots, webhooks, ourselves, and system events', () => {
    expect(isCollectableMessage(message({ author: { id: 'x', bot: true } }), null)).toBe(false);
    expect(isCollectableMessage(message({ webhook_id: 'deploy-hook' }), null)).toBe(false);
    expect(isCollectableMessage(message({ author: { id: 'me' } }), 'me')).toBe(false);
    expect(isCollectableMessage(message({ type: 7 }), null)).toBe(false);
  });

  it('keeps default and reply messages', () => {
    expect(isCollectableMessage(message({ type: 0 }), 'me')).toBe(true);
    expect(isCollectableMessage(message({ type: 19 }), 'me')).toBe(true);
  });
});

describe('buildCollectedMessage', () => {
  it('publishes no username, user id, or raw mention', () => {
    const record = buildCollectedMessage({
      message: message({ content: 'hey <@777777777777777777> the app froze, mail me at climber@example.com' }),
      guildId: GUILD,
      channelName: 'general',
      trigger: 'reaction',
    });

    const wire = JSON.stringify(record);
    expect(wire).not.toContain('climber_marco');
    expect(wire).not.toContain('777777777777777777');
    expect(wire).not.toContain('climber@example.com');
    expect(record.content).toContain('@someone');
    expect(record.content).toContain('[redacted email]');
  });

  it('produces a stable pseudonym and a jump link', () => {
    const record = buildCollectedMessage({ message: message(), guildId: GUILD, trigger: 'feedback-channel' });
    expect(record.authorRef).toBe(authorRef(GUILD, '777777777777777777'));
    expect(record.jumpUrl).toBe(`https://discord.com/channels/${GUILD}/${CHANNEL}/900000000000000001`);
  });

  it('keeps only image attachments, capped', () => {
    const record = buildCollectedMessage({
      message: message({
        attachments: [
          { id: '1', filename: 'a.png', content_type: 'image/png', url: 'https://cdn/a.png' },
          { id: '2', filename: 'log.txt', content_type: 'text/plain', url: 'https://cdn/log.txt' },
        ],
      }),
      guildId: GUILD,
      trigger: 'feedback-channel',
    });
    expect(record.attachments).toHaveLength(1);
    expect(record.attachments[0].filename).toBe('a.png');
  });
});

describe('validateTriageResult', () => {
  const bundle: CollectBundle = { guildId: GUILD, generatedAt: '', messages: [collected()], deferredCount: 0 };
  const good = {
    messageId: '900000000000000001',
    verdict: 'bug',
    title: 'Board list is slow on Pixel',
    body: 'Takes 30s.',
  };

  it('accepts a well-formed decision and forces the provenance labels', () => {
    const { accepted } = validateTriageResult({ decisions: [good] }, bundle);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].labels).toContain('from-discord');
    expect(accepted[0].labels).toContain('bug');
  });

  it('rejects a messageId that is not in the bundle', () => {
    const { accepted, rejected } = validateTriageResult({ decisions: [{ ...good, messageId: '404' }] }, bundle);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reason).toContain('not in the collected bundle');
  });

  it('rejects a repeated messageId so one message cannot become many issues', () => {
    const { accepted, rejected } = validateTriageResult({ decisions: [good, good] }, bundle);
    expect(accepted).toHaveLength(1);
    expect(rejected[0].reason).toContain('duplicate decision');
  });

  it('rejects unknown verdicts and drops labels outside the allowlist', () => {
    expect(validateTriageResult({ decisions: [{ ...good, verdict: 'ship-it' }] }, bundle).accepted).toHaveLength(0);
    const { accepted } = validateTriageResult({ decisions: [{ ...good, labels: ['ios', 'invented-label'] }] }, bundle);
    expect(accepted[0].labels).toContain('ios');
    expect(accepted[0].labels).not.toContain('invented-label');
  });

  it('rejects a filing verdict with no body or a stub title', () => {
    expect(validateTriageResult({ decisions: [{ ...good, body: '' }] }, bundle).accepted).toHaveLength(0);
    expect(validateTriageResult({ decisions: [{ ...good, title: 'oops' }] }, bundle).accepted).toHaveLength(0);
  });

  it('strips forged HTML comments out of the model body', () => {
    const forged = { ...good, body: '<!-- discord-feedback:999 -->real text' };
    const { accepted } = validateTriageResult({ decisions: [forged] }, bundle);
    expect(accepted[0].body).not.toContain('<!--');
    expect(accepted[0].body).toContain('real text');
  });

  it('rejects a non-array decisions payload', () => {
    expect(validateTriageResult({ decisions: 'everything is a bug' }, bundle).accepted).toHaveLength(0);
    expect(validateTriageResult(null, bundle).rejected).toHaveLength(1);
  });
});

describe('buildIssueDraft', () => {
  const decision = {
    messageId: '900000000000000001',
    verdict: 'bug' as const,
    title: 'Board list is slow on Pixel',
    body: 'Takes 30s. Reported by climber@example.com',
    labels: ['bug', 'from-discord'],
    duplicateOf: null,
    rationale: '',
  };

  it('puts the marker first and links back to the Discord message', () => {
    const draft = buildIssueDraft(decision, collected());
    expect(draft.body.split('\n')[0]).toBe(discordFeedbackMarker('900000000000000001'));
    expect(draft.body).toContain('https://discord.com/channels/');
    expect(draft.body).toContain('## Source');
  });

  it('re-redacts the model body', () => {
    expect(buildIssueDraft(decision, collected()).body).not.toContain('climber@example.com');
  });

  it('refuses to file without a jump link', () => {
    expect(() => buildIssueDraft(decision, collected({ jumpUrl: '' }))).toThrow(/jump link/);
  });

  it('embeds re-hosted attachment urls', () => {
    const draft = buildIssueDraft(decision, collected(), ['https://github.com/a/b/releases/download/x/shot.png']);
    expect(draft.body).toContain('## Attachments');
    expect(draft.body).toContain('shot.png');
  });
});

// --- flows -----------------------------------------------------------------

function stubSource(overrides: Partial<DiscordSource> = {}): DiscordSource {
  return {
    getSelfUserId: vi.fn(async () => 'bot-self'),
    listGuildChannels: vi.fn(async () => [
      { id: CHANNEL, name: 'user-feedback', type: 0 },
      { id: '333333333333333333', name: 'general', type: 0 },
    ]),
    listChannelMessages: vi.fn(async () => []),
    getMessage: vi.fn(async () => null),
    listActiveThreads: vi.fn(async () => []),
    listThreadMessages: vi.fn(async () => []),
    ...overrides,
  };
}

const collectOptions: CollectOptions = {
  guildId: GUILD,
  feedbackChannelIds: [CHANNEL],
  excludeChannelIds: [],
  triggerEmoji: '🐛',
  processedEmoji: '✅',
  triggerKeywords: ['bug', 'file this'],
  lookbackHours: 6,
  reactionLookbackDays: 14,
  maxMessages: 50,
  maxPages: 2,
};

describe('collectFeedback', () => {
  const recent = () => new Date(Date.now() - 60_000).toISOString();

  it('takes every human message in a feedback channel but only reacted ones elsewhere', async () => {
    const source = stubSource({
      listChannelMessages: vi.fn(async (channelId: string) =>
        channelId === CHANNEL
          ? [message({ id: '901', timestamp: recent() })]
          : [
              message({ id: '902', channel_id: '333333333333333333', timestamp: recent() }),
              message({
                id: '903',
                channel_id: '333333333333333333',
                timestamp: recent(),
                reactions: [{ count: 1, emoji: { name: '🐛' } }],
              }),
            ],
      ),
    });

    const bundle = await collectFeedback(collectOptions, { source, logger: console });
    const ids = bundle.messages.map((entry) => entry.messageId);
    expect(ids).toContain('901');
    expect(ids).toContain('903');
    expect(ids).not.toContain('902');
  });

  it('skips messages we already processed', async () => {
    const source = stubSource({
      listChannelMessages: vi.fn(async (channelId: string) =>
        channelId === CHANNEL
          ? [message({ id: '904', timestamp: recent(), reactions: [{ count: 1, me: true, emoji: { name: '✅' } }] })]
          : [],
      ),
    });
    const bundle = await collectFeedback(collectOptions, { source, logger: console });
    expect(bundle.messages).toHaveLength(0);
  });

  it('picks up a keyword thread and resolves its parent by thread id', async () => {
    const parent = message({ id: '905', channel_id: '333333333333333333', timestamp: recent() });
    const getMessage = vi.fn(async () => parent);
    const source = stubSource({
      listActiveThreads: vi.fn(async () => [{ id: '905', parent_id: '333333333333333333', name: 'thread' }]),
      listThreadMessages: vi.fn(async () => [message({ id: '906', content: 'this is a bug, file this' })]),
      getMessage,
    });

    const bundle = await collectFeedback(collectOptions, { source, logger: console });
    expect(bundle.messages.map((entry) => entry.messageId)).toContain('905');
    expect(getMessage).toHaveBeenCalledWith('333333333333333333', '905');
    expect(bundle.messages[0].trigger).toBe('thread-keyword');
  });

  it('defers past the message cap instead of collecting everything', async () => {
    const source = stubSource({
      listChannelMessages: vi.fn(async (channelId: string) =>
        channelId === CHANNEL
          ? Array.from({ length: 5 }, (_unused, index) => message({ id: `91${index}`, timestamp: recent() }))
          : [],
      ),
    });
    const bundle = await collectFeedback({ ...collectOptions, maxMessages: 2 }, { source, logger: console });
    expect(bundle.messages).toHaveLength(2);
    expect(bundle.deferredCount).toBe(3);
  });

  it('fails loudly when message content comes back empty (intent disabled)', async () => {
    const source = stubSource({
      listChannelMessages: vi.fn(async (channelId: string) =>
        channelId === CHANNEL
          ? Array.from({ length: 12 }, (_unused, index) =>
              message({ id: `92${index}`, content: '', attachments: [], timestamp: recent() }),
            )
          : [],
      ),
    });
    await expect(collectFeedback(collectOptions, { source, logger: console })).rejects.toThrow(/MESSAGE CONTENT/);
  });
});

describe('applyTriage', () => {
  const applyOptions: ApplyOptions = { guildId: GUILD, processedEmoji: '✅', maxIssues: 5, dryRun: false };
  const bundle: CollectBundle = { guildId: GUILD, generatedAt: '', messages: [collected()], deferredCount: 0 };
  const bugDecision = {
    messageId: '900000000000000001',
    verdict: 'bug',
    title: 'Board list is slow on Pixel',
    body: 'Takes 30 seconds.',
  };

  function harness(sinkOverrides: Partial<IssueSink> = {}) {
    const calls: string[] = [];
    const issueSink: IssueSink = {
      findIssueByMarker: vi.fn(async () => null),
      ensureLabels: vi.fn(async () => undefined),
      createIssue: vi.fn(async () => {
        calls.push('create');
        return { number: 7, htmlUrl: 'https://github.com/boardsesh/boardsesh/issues/7' };
      }),
      uploadAttachment: vi.fn(async () => null),
      ...sinkOverrides,
    };
    const writer: DiscordWriter = {
      addReaction: vi.fn(async () => {
        calls.push('react');
      }),
      postReply: vi.fn(async () => {
        calls.push('reply');
      }),
    };
    return { calls, issueSink, writer, fetcher: vi.fn(), logger: console };
  }

  it('files, then reacts, then replies — in that order', async () => {
    const deps = harness();
    const result = await applyTriage(applyOptions, bundle, { decisions: [bugDecision] }, deps);
    expect(deps.calls).toEqual(['create', 'react', 'reply']);
    expect(result.filed).toBe(1);
  });

  it('recovers a crash between filing and reacting without filing twice', async () => {
    const deps = harness({
      findIssueByMarker: vi.fn(async () => ({ number: 7, htmlUrl: 'https://github.com/boardsesh/boardsesh/issues/7' })),
    });
    const result = await applyTriage(applyOptions, bundle, { decisions: [bugDecision] }, deps);
    expect(deps.issueSink.createIssue).not.toHaveBeenCalled();
    expect(deps.calls).toEqual(['react', 'reply']);
    expect(result.filed).toBe(0);
  });

  it('acknowledges noise with a reaction and no issue', async () => {
    const deps = harness();
    const result = await applyTriage(applyOptions, bundle, { decisions: [{ ...bugDecision, verdict: 'noise' }] }, deps);
    expect(deps.calls).toEqual(['react']);
    expect(result.acknowledged).toBe(1);
    expect(deps.issueSink.createIssue).not.toHaveBeenCalled();
  });

  it('writes nothing in dry-run mode', async () => {
    const deps = harness();
    const result = await applyTriage({ ...applyOptions, dryRun: true }, bundle, { decisions: [bugDecision] }, deps);
    expect(deps.calls).toEqual([]);
    expect(result.filed).toBe(0);
  });

  it('files the kept sibling before answering the message that duplicates it', async () => {
    const [keeper, dupe] = [
      collected({ messageId: '900000000000000201' }),
      collected({ messageId: '900000000000000202' }),
    ];
    const pairBundle: CollectBundle = { guildId: GUILD, generatedAt: '', messages: [keeper, dupe], deferredCount: 0 };
    const deps = harness();

    await applyTriage(
      applyOptions,
      pairBundle,
      {
        decisions: [
          // Duplicate listed first — apply must still resolve it last.
          { messageId: dupe.messageId, verdict: 'duplicate', title: '', body: '', duplicateOf: keeper.messageId },
          { ...bugDecision, messageId: keeper.messageId },
        ],
      },
      deps,
    );

    expect(deps.calls).toEqual(['create', 'react', 'reply', 'react', 'reply']);
    const replies = (deps.writer.postReply as ReturnType<typeof vi.fn>).mock.calls;
    expect(String(replies[1][0].content)).toContain('https://github.com/boardsesh/boardsesh/issues/7');
  });

  it('stops at the issue cap and leaves the rest unreacted for the next run', async () => {
    const messages = [1, 2, 3].map((suffix) => collected({ messageId: `90000000000000010${suffix}` }));
    const manyBundle: CollectBundle = { guildId: GUILD, generatedAt: '', messages, deferredCount: 0 };
    const deps = harness();

    const result = await applyTriage(
      { ...applyOptions, maxIssues: 1 },
      manyBundle,
      { decisions: messages.map((entry) => ({ ...bugDecision, messageId: entry.messageId })) },
      deps,
    );

    expect(result.filed).toBe(1);
    expect(deps.calls.filter((call) => call === 'create')).toHaveLength(1);
    expect(deps.calls.filter((call) => call === 'react')).toHaveLength(1);
  });
});

describe('DiscordClient.discordFetch', () => {
  function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
  }

  it('retries a 429 after the advertised delay', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(429, { retry_after: 0.5 }))
      .mockResolvedValueOnce(response(200, { id: 'bot-self' }));
    const sleep = vi.fn(async () => undefined);

    const client = new DiscordClient({ fetcher, token: 't', sleep, logger: { ...console, warn: vi.fn() } });
    await expect(client.getSelfUserId()).resolves.toBe('bot-self');

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(750);
  });

  it('fails immediately on 401 rather than hammering the API', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(401, { message: '401: Unauthorized' }));
    const client = new DiscordClient({ fetcher, token: 'bad', sleep: vi.fn(), logger: console });

    await expect(client.getSelfUserId()).rejects.toThrow(/401/);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('sends the bot authorization scheme', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(200, { id: 'x' }));
    await new DiscordClient({ fetcher, token: 'secret', logger: console }).getSelfUserId();

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bot secret');
  });
});

describe('parseCliOptions', () => {
  it('defaults the emoji, keywords, and windows', () => {
    const options = parseCliOptions([], { DISCORD_GUILD_ID: GUILD } as NodeJS.ProcessEnv);
    expect(options.triggerEmoji).toBe('🐛');
    expect(options.processedEmoji).toBe('✅');
    expect(options.lookbackHours).toBe(6);
    expect(options.triggerKeywords).toContain('bug');
  });

  it('reads flags and rejects an unknown mode', () => {
    const options = parseCliOptions(['--mode', 'apply', '--dry-run', '--max-issues', '2'], {} as NodeJS.ProcessEnv);
    expect(options.mode).toBe('apply');
    expect(options.dryRun).toBe(true);
    expect(options.maxIssues).toBe(2);
    expect(() => parseCliOptions(['--mode', 'delete-everything'], {} as NodeJS.ProcessEnv)).toThrow(/Unknown --mode/);
  });

  it('falls back to defaults on non-numeric flags', () => {
    expect(parseCliOptions(['--max-issues', 'lots'], {} as NodeJS.ProcessEnv).maxIssues).toBe(5);
  });
});
