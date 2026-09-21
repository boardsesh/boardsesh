import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  applyTriage,
  bundleDigest,
  collectMentionCommand,
  DiscordClient,
  GitHubIssueClient,
  notifyFailure,
  runCli,
  validateTriageArtifacts,
  type DiscordSource,
  type DiscordWriter,
  type IssueSink,
} from '../discord-feedback-scan';
import {
  collectImageAttachments,
  extractCommandInstruction,
  type CollectBundle,
  type DiscordChannel,
  type DiscordMessage,
} from '../lib/discord-feedback';
import {
  buildIssueDraft,
  discordFeedbackMarker,
  validateTriageResult,
  type IssueDraft,
} from '../lib/discord-feedback-issue';

const GUILD_ID = '100000000000000001';
const BOT_ID = '200000000000000001';
const MAINTAINER_ID = '300000000000000001';
const USER_ID = '400000000000000001';
const COMMAND_ID = '900000000000000001';

function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: COMMAND_ID,
    channel_id: '500000000000000001',
    type: 0,
    content: `<@${BOT_ID}> create an issue for this`,
    timestamp: '2026-09-03T01:00:00.000Z',
    author: { id: MAINTAINER_ID },
    mentions: [{ id: BOT_ID }],
    attachments: [],
    ...overrides,
  };
}

function channel(overrides: Partial<DiscordChannel> = {}): DiscordChannel {
  return {
    id: '500000000000000001',
    name: 'feedback',
    type: 0,
    guild_id: GUILD_ID,
    parent_id: null,
    ...overrides,
  };
}

function source(overrides: Partial<DiscordSource> = {}): DiscordSource {
  return {
    getSelfUserId: vi.fn(async () => BOT_ID),
    getChannel: vi.fn(async () => channel()),
    getMessage: vi.fn(async () => message()),
    listRecentMessages: vi.fn(async () => []),
    listMessagesBefore: vi.fn(async () => []),
    ...overrides,
  };
}

function bundle(): CollectBundle {
  return {
    version: 2,
    guildId: GUILD_ID,
    generatedAt: '2026-09-03T01:00:01.000Z',
    command: {
      messageId: COMMAND_ID,
      channelId: '500000000000000001',
      channelName: 'feedback',
      guildId: GUILD_ID,
      sourceKind: 'reply',
      instruction: 'create an issue for this',
      authorRef: 'discord-maintainer',
      timestamp: '2026-09-03T01:00:00.000Z',
      jumpUrl: `https://discord.com/channels/${GUILD_ID}/500000000000000001/${COMMAND_ID}`,
    },
    source: {
      messageId: '800000000000000001',
      channelId: '500000000000000001',
      channelName: 'feedback',
      guildId: GUILD_ID,
      threadId: null,
      authorRef: 'discord-reporter',
      timestamp: '2026-09-03T00:59:00.000Z',
      jumpUrl: `https://discord.com/channels/${GUILD_ID}/500000000000000001/800000000000000001`,
      content: 'Queue jumps back after logging a send.',
      context: [],
      attachments: [],
    },
  };
}

function decision(issueIndex = 1) {
  return {
    commandMessageId: COMMAND_ID,
    issueIndex,
    verdict: 'bug',
    title: `Queue selection jumps ${issueIndex}`,
    body: 'After logging a send, the queue selects the first climb instead of the next climb.',
    labels: ['mobile'],
    duplicateOf: null,
    rationale: 'The command requests a concrete issue.',
  };
}

describe('Discord feedback collection helpers', () => {
  it('extracts the maintainer instruction after either mention form', () => {
    expect(extractCommandInstruction(`not the instruction <@!${BOT_ID}>   split this into two issues`, BOT_ID)).toBe(
      'split this into two issues',
    );
    expect(extractCommandInstruction('<@200.001> create this', '200.001')).toBe('create this');
    expect(extractCommandInstruction('<@200x001> create this', '200.001')).toBe('');
  });

  it('caps image attachments across messages', () => {
    const messages = Array.from({ length: 6 }, (_, index) =>
      message({
        id: String(index),
        attachments: [{ id: `a${index}`, url: `https://cdn.test/${index}.png`, content_type: 'image/png' }],
      }),
    );
    expect(collectImageAttachments(messages)).toHaveLength(4);
  });
});

describe('collectMentionCommand', () => {
  const options = {
    guildId: GUILD_ID,
    channelId: '500000000000000001',
    triggerMessageId: COMMAND_ID,
    allowedUserIds: new Set([MAINTAINER_ID]),
  };

  it('uses a replied-to message as the source', async () => {
    const command = message({
      message_reference: { message_id: '800000000000000001', channel_id: '500000000000000001' },
    });
    const report = message({
      id: '800000000000000001',
      content: `The queue skips the next climb. Email climber@example.com or <@${MAINTAINER_ID}>.`,
      author: { id: USER_ID },
      mentions: [],
    });
    const discordSource = source({
      getMessage: vi.fn(async (_channelId, messageId) => (messageId === COMMAND_ID ? command : report)),
    });

    const result = await collectMentionCommand(options, { source: discordSource });

    expect(result.command.sourceKind).toBe('reply');
    expect(result.source.messageId).toBe(report.id);
    expect(result.source.content).toContain('[redacted email]');
    expect(result.source.content).toContain('@someone');
    expect(result.source.content).not.toContain(MAINTAINER_ID);
    expect(result.source.authorRef).not.toContain(USER_ID);
    expect(result.command.instruction).toBe('create an issue for this');
  });

  it('uses the thread starter and newest human thread messages', async () => {
    const threadId = '600000000000000001';
    const command = message({ channel_id: threadId });
    const starter = message({
      id: threadId,
      channel_id: '500000000000000001',
      content: 'Board connection drops after one climb.',
      author: { id: USER_ID },
      mentions: [],
    });
    const discussion = message({
      id: '700000000000000001',
      channel_id: threadId,
      content: 'This happens on Android.',
      author: { id: USER_ID },
      mentions: [],
    });
    const botMessage = message({
      id: '700000000000000002',
      channel_id: threadId,
      author: { id: BOT_ID, bot: true },
    });
    const discordSource = source({
      getChannel: vi.fn(async (channelId) =>
        channelId === threadId
          ? channel({ id: threadId, name: 'connection-drop', type: 11, parent_id: '500000000000000001' })
          : channel(),
      ),
      getMessage: vi.fn(async (_channelId, messageId) => (messageId === COMMAND_ID ? command : starter)),
      listRecentMessages: vi.fn(async () => [starter, discussion, botMessage, command]),
    });

    const result = await collectMentionCommand({ ...options, channelId: threadId }, { source: discordSource });

    expect(result.command.sourceKind).toBe('thread');
    expect(result.source.messageId).toBe(threadId);
    expect(result.source.threadId).toBe(threadId);
    expect(result.source.context.map((entry) => entry.content)).toEqual(['This happens on Android.']);
  });

  it('uses up to ten preceding human messages from the prior 30 minutes', async () => {
    const recent = Array.from({ length: 12 }, (_, index) =>
      message({
        id: `8000000000000000${String(index).padStart(2, '0')}`,
        content: `context ${index}`,
        timestamp: `2026-09-03T00:${String(40 + index).padStart(2, '0')}:00.000Z`,
        author: { id: USER_ID },
        mentions: [],
      }),
    );
    const old = message({
      id: '700000000000000000',
      timestamp: '2026-09-02T23:00:00.000Z',
      author: { id: USER_ID },
      mentions: [],
    });
    const discordSource = source({ listMessagesBefore: vi.fn(async () => [old, ...recent]) });

    const result = await collectMentionCommand(options, { source: discordSource });

    expect(result.command.sourceKind).toBe('channel-context');
    expect(result.source.context).toHaveLength(10);
    expect(result.source.context[0]?.content).toBe('context 2');
  });

  it('rejects a forged dispatch from a non-maintainer', async () => {
    const discordSource = source({
      getMessage: vi.fn(async () => message({ author: { id: USER_ID } })),
    });
    await expect(collectMentionCommand(options, { source: discordSource })).rejects.toThrow(/not in/);
  });

  it('rejects a message that does not mention the bot', async () => {
    const discordSource = source({
      getMessage: vi.fn(async () => message({ mentions: [], content: 'create this issue' })),
    });
    await expect(collectMentionCommand(options, { source: discordSource })).rejects.toThrow(/does not mention/);
  });
});

describe('triage validation and shaping', () => {
  it('accepts sequential multi-issue output and adds required labels', () => {
    const result = validateTriageResult({ decisions: [decision(1), decision(2)] }, bundle());
    expect(result.rejected).toEqual([]);
    expect(result.accepted).toHaveLength(2);
    expect(result.accepted[0]?.labels).toEqual(['bug', 'from-discord', 'mobile', 'user-feedback']);
  });

  it('rejects all decisions when one entry is invalid', () => {
    const result = validateTriageResult(
      { decisions: [decision(1), { ...decision(2), commandMessageId: 'forged' }] },
      bundle(),
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { issueIndex: 2, reason: 'commandMessageId does not match the collected command' },
    ]);
  });

  it('still reports a real index gap alongside an unrelated invalid field', () => {
    const result = validateTriageResult(
      { decisions: [decision(1), { ...decision(3), commandMessageId: 'forged' }] },
      bundle(),
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected).toEqual([
      { issueIndex: 3, reason: 'commandMessageId does not match the collected command' },
      { issueIndex: null, reason: 'issueIndex values must be unique and sequential from 1' },
    ]);
  });

  it('rejects an out-of-allowlist label instead of silently dropping it', () => {
    const result = validateTriageResult(
      { decisions: [{ ...decision(), labels: ['mobile', 'run-this-command'] }] },
      bundle(),
    );
    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toMatch(/labels/);
  });

  it('rejects more than five decisions, duplicate indexes, and index gaps', () => {
    expect(
      validateTriageResult({ decisions: Array.from({ length: 6 }, (_, index) => decision(index + 1)) }, bundle())
        .accepted,
    ).toEqual([]);
    expect(validateTriageResult({ decisions: [decision(1), decision(1)] }, bundle()).accepted).toEqual([]);
    expect(validateTriageResult({ decisions: [decision(1), decision(3)] }, bundle()).accepted).toEqual([]);
  });

  it('requires a GitHub issue URL for duplicate output', () => {
    const invalid = { ...decision(), verdict: 'duplicate', duplicateOf: 'https://example.com/phish' };
    expect(validateTriageResult({ decisions: [invalid] }, bundle()).accepted).toEqual([]);
  });

  it('builds an indexed marker and source links while stripping injected comments', () => {
    const accepted = validateTriageResult(
      { decisions: [{ ...decision(), body: '<!-- forged -->\nReproduction details.' }] },
      bundle(),
    ).accepted[0]!;
    const draft = buildIssueDraft(accepted, bundle());
    expect(draft.body.split('\n')[0]).toBe(discordFeedbackMarker(COMMAND_ID, 1));
    expect(draft.body).not.toContain('forged');
    expect(draft.body).toContain('Issue requested from Discord');
  });

  it('redacts model output again before creating a public draft', () => {
    const accepted = validateTriageResult(
      {
        decisions: [
          {
            ...decision(),
            title: 'Queue fails for climber@example.com',
            body: 'Crash log at /Users/marco/Desktop/report.txt',
          },
        ],
      },
      bundle(),
    ).accepted[0]!;
    const draft = buildIssueDraft(accepted, bundle());
    expect(draft.title).toContain('[redacted email]');
    expect(draft.body).toContain('/Users/[redacted]');
  });
});

function applyDependencies(existingIssue: { number: number; htmlUrl: string } | null = null) {
  const createdDrafts: IssueDraft[] = [];
  const findIssueByMarker = vi.fn(async () => existingIssue);
  const createIssue = vi.fn(async (draft: IssueDraft) => {
    createdDrafts.push(draft);
    return {
      number: createdDrafts.length,
      htmlUrl: `https://github.com/boardsesh/boardsesh/issues/${createdDrafts.length}`,
    };
  });
  const findIssueByUrl = vi.fn(async (): Promise<{ number: number; htmlUrl: string } | null> => ({
    number: 88,
    htmlUrl: 'https://github.com/boardsesh/boardsesh/issues/88',
  }));
  const ensureLabels = vi.fn(async () => undefined);
  const uploadAttachment = vi.fn(async () => null);
  const issueSink: IssueSink = { findIssueByMarker, findIssueByUrl, ensureLabels, createIssue, uploadAttachment };
  const addReaction = vi.fn(async () => undefined);
  const removeReaction = vi.fn(async () => undefined);
  const postReply = vi.fn(async () => undefined);
  const writer: DiscordWriter = {
    addReaction,
    removeReaction,
    postReply,
  };
  return {
    issueSink,
    writer,
    createdDrafts,
    findIssueByMarker,
    findIssueByUrl,
    ensureLabels,
    uploadAttachment,
    createIssue,
    addReaction,
    removeReaction,
    postReply,
  };
}

describe('applyTriage', () => {
  it('creates every requested issue, then acknowledges once', async () => {
    const deps = applyDependencies();
    const result = await applyTriage(
      bundle(),
      { decisions: [decision(1), decision(2)] },
      { dryRun: false },
      {
        ...deps,
        fetcher: fetch,
        logger: console,
      },
    );

    expect(result).toEqual({ filed: 2, recovered: 0, duplicates: 0 });
    expect(deps.createdDrafts).toHaveLength(2);
    expect(deps.removeReaction).toHaveBeenCalledWith('500000000000000001', COMMAND_ID, '👀');
    expect(deps.addReaction).toHaveBeenCalledWith('500000000000000001', COMMAND_ID, '✅');
    expect(deps.postReply).toHaveBeenCalledTimes(1);
  });

  it('recovers an existing indexed marker without creating another issue', async () => {
    const deps = applyDependencies({ number: 88, htmlUrl: 'https://github.com/boardsesh/boardsesh/issues/88' });
    const result = await applyTriage(
      bundle(),
      { decisions: [decision()] },
      { dryRun: false },
      {
        ...deps,
        fetcher: fetch,
        logger: console,
      },
    );
    expect(result.recovered).toBe(1);
    expect(deps.createIssue).not.toHaveBeenCalled();
  });

  it('still acknowledges created issues when reaction cleanup returns 404', async () => {
    const deps = applyDependencies();
    deps.removeReaction.mockRejectedValue(new Error('Discord 404'));

    const result = await applyTriage(
      bundle(),
      { decisions: [decision()] },
      { dryRun: false },
      {
        ...deps,
        fetcher: fetch,
        logger: console,
      },
    );

    expect(result.filed).toBe(1);
    expect(deps.addReaction).toHaveBeenCalledWith('500000000000000001', COMMAND_ID, '✅');
    expect(deps.postReply).toHaveBeenCalledTimes(1);
  });

  it.each(['addReaction', 'postReply'] as const)(
    'keeps completed issues successful when %s fails',
    async (failedWrite) => {
      const deps = applyDependencies();
      const logger = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
      deps[failedWrite].mockRejectedValue(new Error('Discord unavailable'));
      const result = await applyTriage(
        bundle(),
        { decisions: [decision()] },
        { dryRun: false },
        {
          ...deps,
          fetcher: fetch,
          logger,
        },
      );
      expect(result).toEqual({ filed: 1, recovered: 0, duplicates: 0 });
      expect(deps.addReaction).toHaveBeenCalledOnce();
      expect(deps.postReply).toHaveBeenCalledOnce();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Issues processed successfully'));
    },
  );

  it('verifies all duplicate targets before writing an earlier new issue', async () => {
    const deps = applyDependencies();
    deps.findIssueByUrl.mockResolvedValue(null);
    await expect(
      applyTriage(
        bundle(),
        {
          decisions: [
            decision(),
            {
              ...decision(2),
              verdict: 'duplicate',
              duplicateOf: 'https://github.com/boardsesh/boardsesh/issues/88',
            },
          ],
        },
        { dryRun: false },
        { ...deps, fetcher: fetch, logger: console },
      ),
    ).rejects.toThrow(/not an existing repository issue/);
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(deps.ensureLabels).not.toHaveBeenCalled();
    expect(deps.uploadAttachment).not.toHaveBeenCalled();
    expect(deps.removeReaction).not.toHaveBeenCalled();
    expect(deps.addReaction).not.toHaveBeenCalled();
    expect(deps.postReply).not.toHaveBeenCalled();
  });

  it('links a verified duplicate without creating an issue', async () => {
    const deps = applyDependencies();
    const result = await applyTriage(
      bundle(),
      {
        decisions: [
          {
            ...decision(),
            verdict: 'duplicate',
            duplicateOf: 'https://github.com/boardsesh/boardsesh/issues/88',
          },
        ],
      },
      { dryRun: false },
      { ...deps, fetcher: fetch, logger: console },
    );
    expect(result).toEqual({ filed: 0, recovered: 0, duplicates: 1 });
    expect(deps.createIssue).not.toHaveBeenCalled();
    expect(deps.postReply).toHaveBeenCalledWith(
      '500000000000000001',
      COMMAND_ID,
      GUILD_ID,
      expect.stringContaining('/issues/88'),
    );
  });

  it('performs no writes when any decision is invalid', async () => {
    const deps = applyDependencies();
    await expect(
      applyTriage(
        bundle(),
        { decisions: [{ ...decision(), issueIndex: 3 }] },
        { dryRun: false },
        {
          ...deps,
          fetcher: fetch,
          logger: console,
        },
      ),
    ).rejects.toThrow(/Refusing all writes/);
    expect(deps.findIssueByMarker).not.toHaveBeenCalled();
    expect(deps.addReaction).not.toHaveBeenCalled();
  });

  it('turns the pending reaction into a failure reply', async () => {
    const deps = applyDependencies();
    await notifyFailure(
      {
        channelId: '500000000000000001',
        triggerMessageId: COMMAND_ID,
        guildId: GUILD_ID,
        allowedUserIds: new Set([MAINTAINER_ID]),
      },
      { source: source(), writer: deps.writer },
    );
    expect(deps.removeReaction).toHaveBeenCalledWith('500000000000000001', COMMAND_ID, '👀');
    expect(deps.addReaction).toHaveBeenCalledWith('500000000000000001', COMMAND_ID, '❌');
    expect(deps.postReply).toHaveBeenCalledTimes(1);
  });
});

it('does not notify Discord when a failure handler is a dry run', async () => {
  const logger = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
  const exitCode = await runCli(
    ['--mode', 'notify-failure', '--channel-id', '500000000000000001', '--trigger-message-id', COMMAND_ID, '--dry-run'],
    {
      DISCORD_BOT_TOKEN: 'unused-in-dry-run',
      DISCORD_GUILD_ID: GUILD_ID,
    },
    logger,
  );

  expect(exitCode).toBe(0);
  expect(logger.log).toHaveBeenCalledWith('[discord-feedback] (dry run) skipped Discord failure notification');
});

it.each([
  ['wrong guild', { getChannel: vi.fn(async () => channel({ guild_id: '600000000000000001' })) }],
  ['unlisted author', { getMessage: vi.fn(async () => message({ author: { id: USER_ID } })) }],
  ['bot author', { getMessage: vi.fn(async () => message({ author: { id: MAINTAINER_ID, bot: true } })) }],
  ['missing mention', { getMessage: vi.fn(async () => message({ mentions: [], content: 'unrelated' })) }],
  ['wrong coordinates', { getMessage: vi.fn(async () => message({ id: '600000000000000001' })) }],
] as const)('refuses all failure-notifier writes for %s', async (_reason, overrides) => {
  const deps = applyDependencies();
  await expect(
    notifyFailure(
      {
        channelId: '500000000000000001',
        triggerMessageId: COMMAND_ID,
        guildId: GUILD_ID,
        allowedUserIds: new Set([MAINTAINER_ID]),
      },
      {
        source: source(overrides),
        writer: deps.writer,
      },
    ),
  ).rejects.toThrow();
  expect(deps.removeReaction).not.toHaveBeenCalled();
  expect(deps.addReaction).not.toHaveBeenCalled();
  expect(deps.postReply).not.toHaveBeenCalled();
});

it.each([undefined, '', '   '])(
  'fails closed without network access for an empty notifier allowlist (%j)',
  async (allowlist) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const logger = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
    try {
      const exitCode = await runCli(
        ['--mode', 'notify-failure', '--channel-id', '500000000000000001', '--trigger-message-id', COMMAND_ID],
        { DISCORD_BOT_TOKEN: 'unused', DISCORD_GUILD_ID: GUILD_ID, DISCORD_ISSUE_TRIGGER_USER_IDS: allowlist },
        logger,
      );
      expect(exitCode).toBe(1);
      expect(logger.error).toHaveBeenCalledWith('[discord-feedback] DISCORD_ISSUE_TRIGGER_USER_IDS is empty.');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  },
);

it('notifies Discord through the live failure-handler CLI path', async () => {
  const requests: Array<{ method: string; url: string; body: string | null }> = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    requests.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    if (String(input).endsWith('/users/@me')) return Response.json({ id: BOT_ID });
    if ((init?.method ?? 'GET') === 'GET') {
      return Response.json(String(input).includes('/messages/') ? message() : channel());
    }
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal('fetch', fetchMock);

  try {
    const logger = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
    const exitCode = await runCli(
      ['--mode', 'notify-failure', '--channel-id', '500000000000000001', '--trigger-message-id', COMMAND_ID],
      { DISCORD_BOT_TOKEN: 'bot-token', DISCORD_GUILD_ID: GUILD_ID, DISCORD_ISSUE_TRIGGER_USER_IDS: MAINTAINER_ID },
      logger,
    );

    expect(exitCode).toBe(0);
    expect(requests.map(({ method }) => method)).toEqual(['GET', 'GET', 'GET', 'DELETE', 'DELETE', 'PUT', 'POST']);
    expect(requests[5]?.url).toContain(`/reactions/${encodeURIComponent('❌')}/@me`);
    expect(requests[6]?.body).toContain('rerun the workflow for this message');
  } finally {
    vi.unstubAllGlobals();
  }
});

it('validates the exact triage artifact schema before apply', () => {
  const serializedBundle = JSON.stringify(bundle());
  const commonArgs = {
    serializedBundle,
    expectedBundleSha256: bundleDigest(serializedBundle),
    channelId: '500000000000000001',
    triggerMessageId: COMMAND_ID,
  };

  expect(
    validateTriageArtifacts({ ...commonArgs, serializedDecisions: JSON.stringify({ decisions: [decision()] }) }),
  ).toBe(1);
  expect(() =>
    validateTriageArtifacts({
      ...commonArgs,
      serializedDecisions: JSON.stringify({ decisions: [{ ...decision(), unexpected: true }] }),
    }),
  ).toThrow(/unexpected field/);
});

it('runs artifact validation without Discord or GitHub credentials', async () => {
  const artifactDirectory = mkdtempSync(join(tmpdir(), 'boardsesh-discord-validation-'));
  const bundlePath = join(artifactDirectory, 'bundle.json');
  const decisionsPath = join(artifactDirectory, 'decisions.json');
  const serializedBundle = JSON.stringify(bundle());
  writeFileSync(bundlePath, serializedBundle);
  writeFileSync(decisionsPath, JSON.stringify({ decisions: [decision()] }));

  try {
    const logger = { error: vi.fn(), log: vi.fn(), warn: vi.fn() };
    const exitCode = await runCli(
      [
        '--mode',
        'validate',
        '--channel-id',
        '500000000000000001',
        '--trigger-message-id',
        COMMAND_ID,
        '--bundle',
        bundlePath,
        '--decisions',
        decisionsPath,
        '--bundle-sha256',
        bundleDigest(serializedBundle),
      ],
      {},
      logger,
    );

    expect(exitCode).toBe(0);
    expect(logger.log).toHaveBeenCalledWith('[discord-feedback] validated 1 triage decision(s)');
  } finally {
    rmSync(artifactDirectory, { recursive: true, force: true });
  }
});

it('pins bundles with a stable SHA-256 digest', () => {
  expect(bundleDigest('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

describe('GitHub duplicate verification', () => {
  const issueUrl = 'https://github.com/boardsesh/boardsesh/issues/88';
  it.each([
    [200, { number: 88, html_url: issueUrl }, true],
    [404, { message: 'Not Found' }, false],
    [200, { number: 88, html_url: issueUrl, pull_request: { url: 'pull' } }, false],
    [200, { number: 89, html_url: issueUrl }, false],
    [200, { number: 88, html_url: 'https://github.com/other/repo/issues/88' }, false],
  ] as const)('only accepts an existing matching issue: %s %j', async (status, payload, expected) => {
    const fetcher = vi.fn(async () => Response.json(payload, { status }));
    const client = new GitHubIssueClient({ repositoryFullName: 'boardsesh/boardsesh', token: 'test', fetcher });
    expect(await client.findIssueByUrl(issueUrl)).toEqual(expected ? { number: 88, htmlUrl: issueUrl } : null);
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it('rejects URLs outside the configured repository without fetching', async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const client = new GitHubIssueClient({ repositoryFullName: 'boardsesh/boardsesh', token: 'test', fetcher });
    for (const invalidUrl of [
      'https://github.com/other/repo/issues/88',
      issueUrl + '?x=1',
      issueUrl.replace('/issues/', '/pull/'),
      issueUrl.replace('https:', 'http:'),
    ]) {
      expect(await client.findIssueByUrl(invalidUrl)).toBeNull();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('fails closed on a GitHub permission failure', async () => {
    const client = new GitHubIssueClient({
      repositoryFullName: 'boardsesh/boardsesh',
      token: 'test',
      fetcher: vi.fn(async () => Response.json({}, { status: 403 })),
    });
    await expect(client.findIssueByUrl(issueUrl)).rejects.toThrow(/GitHub 403/);
  });
});

describe('REST rate-limit recovery', () => {
  it.each(['user', 'global'])('retries Discord %s limits after the advertised fractional delay', async (scope) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ retry_after: 0.75 }, { status: 429, headers: { 'x-ratelimit-scope': scope } }),
      )
      .mockResolvedValueOnce(Response.json({ id: BOT_ID }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const client = new DiscordClient({ token: 'test', fetcher, sleep });
    expect(await client.getSelfUserId()).toBe(BOT_ID);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1000);
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
  });

  it('stops retrying Discord rate limits after five retries', async () => {
    const fetcher = vi.fn(async () => Response.json({ retry_after: 0.1 }, { status: 429 }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const client = new DiscordClient({ token: 'test', fetcher, sleep });
    await expect(client.getSelfUserId()).rejects.toThrow(/Discord 429/);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(sleep).toHaveBeenCalledTimes(5);
  });

  it.each([401, 403])('does not retry Discord authorization failure %s', async (status) => {
    const fetcher = vi.fn(async () => Response.json({}, { status }));
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const client = new DiscordClient({ token: 'test', fetcher, sleep });
    await expect(client.getSelfUserId()).rejects.toThrow(`Discord ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('preserves exact-marker deduplication after a rate-limited GitHub search', async () => {
    const marker = discordFeedbackMarker(COMMAND_ID, 1);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}, { status: 429, headers: { 'Retry-After': '0.5' } }))
      .mockResolvedValueOnce(
        Response.json({
          total_count: 1,
          items: [{ number: 88, html_url: 'https://github.com/boardsesh/boardsesh/issues/88' }],
        }),
      );
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const client = new GitHubIssueClient({ repositoryFullName: 'boardsesh/boardsesh', token: 'test', fetcher, sleep });
    expect(await client.findIssueByMarker(marker)).toEqual({
      number: 88,
      htmlUrl: 'https://github.com/boardsesh/boardsesh/issues/88',
    });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(500);
    expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
    const requestedUrl = new URL(String(fetcher.mock.calls[0]?.[0]));
    expect(requestedUrl.pathname).toBe('/search/issues');
    expect(requestedUrl.searchParams.get('q')).toBe(`repo:boardsesh/boardsesh is:issue "${marker}"`);
  });
});
