/// <reference types="node" />

/**
 * Targeted Discord mention -> GitHub issues pipeline.
 *
 * `collect` re-fetches one bot mention, re-authorizes its maintainer, and emits
 * a redacted conversation bundle. `apply` validates the isolated model output,
 * creates/reuses every issue, then updates the original Discord command.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  THREAD_CHANNEL_TYPES,
  authorRef,
  buildCollectedContextMessage,
  clampDiscordMessage,
  collectImageAttachments,
  extractCommandInstruction,
  isCollectableMessage,
  mentionsUser,
  messageJumpUrl,
  sanitizeText,
  type CollectBundle,
  type CollectedSource,
  type DiscordChannel,
  type DiscordMessage,
} from './lib/discord-feedback';
import {
  LABEL_COLORS,
  buildIssueDraft,
  buildReplyMessage,
  discordFeedbackMarker,
  validateTriageResult,
  type AppliedIssue,
  type IssueDraft,
} from './lib/discord-feedback-issue';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'DiscordBot (https://github.com/boardsesh/boardsesh, 2.0)';
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const MAX_RATE_LIMIT_SLEEP_SECONDS = 60;
const THREAD_CONTEXT_LIMIT = 50;
const CHANNEL_CONTEXT_LIMIT = 10;
const CHANNEL_CONTEXT_LOOKBACK_MS = 30 * 60 * 1000;

export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Logger = Pick<Console, 'error' | 'log' | 'warn'>;
type Sleep = (milliseconds: number) => Promise<void>;

export type DiscordSource = {
  getSelfUserId(): Promise<string>;
  getChannel(channelId: string): Promise<DiscordChannel>;
  getMessage(channelId: string, messageId: string): Promise<DiscordMessage>;
  listRecentMessages(channelId: string, limit: number): Promise<DiscordMessage[]>;
  listMessagesBefore(channelId: string, beforeMessageId: string, limit: number): Promise<DiscordMessage[]>;
};

export type DiscordWriter = {
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  postReply(channelId: string, messageId: string, guildId: string, content: string): Promise<void>;
};

export type IssueSink = {
  findIssueByMarker(marker: string): Promise<{ number: number; htmlUrl: string } | null>;
  ensureLabels(labels: string[]): Promise<void>;
  createIssue(issue: IssueDraft): Promise<{ number: number; htmlUrl: string }>;
  uploadAttachment(filename: string, bytes: Uint8Array, contentType: string | null): Promise<string | null>;
};

const sleepReal: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function bundleDigest(serializedBundle: string): string {
  return createHash('sha256').update(serializedBundle).digest('hex');
}

function readJsonSafely(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class DiscordClient implements DiscordSource, DiscordWriter {
  private readonly fetcher: Fetcher;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly sleep: Sleep;
  private readonly logger: Logger;

  constructor(args: { fetcher?: Fetcher; token: string; apiBase?: string; sleep?: Sleep; logger?: Logger }) {
    this.fetcher = args.fetcher ?? fetch;
    this.token = args.token;
    this.apiBase = args.apiBase ?? DISCORD_API_BASE;
    this.sleep = args.sleep ?? sleepReal;
    this.logger = args.logger ?? console;
  }

  private async discordFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const headers = new Headers({
      Authorization: `Bot ${this.token}`,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    });
    new Headers(init.headers).forEach((headerValue, headerName) => headers.set(headerName, headerValue));
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      ...init,
      headers,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Discord ${response.status} for ${path}; check the bot token and channel permissions.`);
    }
    if (response.status === 429 && attempt < 5) {
      const body = readJsonSafely(await response.text().catch(() => '')) as { retry_after?: number } | null;
      const retryAfterMilliseconds = Math.max(0, (body?.retry_after ?? 1) * 1000) + 250;
      await this.sleep(retryAfterMilliseconds);
      return this.discordFetch(path, init, attempt + 1);
    }
    if (response.status >= 500 && attempt < 3) {
      await this.sleep(500 * 2 ** attempt);
      return this.discordFetch(path, init, attempt + 1);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new Error(`Discord ${response.status} for ${path}: ${detail}`);
    }
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const resetAfterSeconds = Number(response.headers.get('x-ratelimit-reset-after') ?? '0');
      if (resetAfterSeconds > 0) {
        await this.sleep(Math.min(resetAfterSeconds, MAX_RATE_LIMIT_SLEEP_SECONDS) * 1000);
      }
    }
    return response;
  }

  private async getJson<Result>(path: string): Promise<Result> {
    const response = await this.discordFetch(path, { method: 'GET' });
    return (await response.json()) as Result;
  }

  async getSelfUserId(): Promise<string> {
    const user = await this.getJson<{ id?: string }>('/users/@me');
    if (!user.id) throw new Error('Discord bot identity response had no id');
    return user.id;
  }

  getChannel(channelId: string): Promise<DiscordChannel> {
    return this.getJson<DiscordChannel>(`/channels/${encodeURIComponent(channelId)}`);
  }

  getMessage(channelId: string, messageId: string): Promise<DiscordMessage> {
    return this.getJson<DiscordMessage>(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}`,
    );
  }

  async listRecentMessages(channelId: string, limit: number): Promise<DiscordMessage[]> {
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const messages = await this.getJson<DiscordMessage[]>(
      `/channels/${encodeURIComponent(channelId)}/messages?limit=${boundedLimit}`,
    );
    return messages.reverse();
  }

  async listMessagesBefore(channelId: string, beforeMessageId: string, limit: number): Promise<DiscordMessage[]> {
    const boundedLimit = Math.min(100, Math.max(1, limit));
    const messages = await this.getJson<DiscordMessage[]>(
      `/channels/${encodeURIComponent(channelId)}/messages?limit=${boundedLimit}&before=${encodeURIComponent(beforeMessageId)}`,
    );
    return messages.reverse();
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.discordFetch(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: 'PUT' },
    );
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.discordFetch(
      `/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}/@me`,
      { method: 'DELETE' },
    );
  }

  async postReply(channelId: string, messageId: string, guildId: string, content: string): Promise<void> {
    await this.discordFetch(`/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content: clampDiscordMessage(content),
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: {
          message_id: messageId,
          channel_id: channelId,
          guild_id: guildId,
          fail_if_not_exists: false,
        },
      }),
    });
  }
}

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

export class GitHubIssueClient implements IssueSink {
  private readonly fetcher: Fetcher;
  private readonly sleep: Sleep;
  private readonly owner: string;
  private readonly repository: string;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly logger: Logger;
  private readonly ensuredLabels = new Set<string>();
  private releaseId: number | null = null;

  constructor(args: {
    fetcher?: Fetcher;
    repositoryFullName: string;
    token: string;
    apiBase?: string;
    logger?: Logger;
    sleep?: Sleep;
  }) {
    const [owner, repository] = args.repositoryFullName.split('/');
    if (!owner || !repository) throw new Error(`Invalid GitHub repository "${args.repositoryFullName}".`);
    this.fetcher = args.fetcher ?? fetch;
    this.sleep = args.sleep ?? sleepReal;
    this.owner = owner;
    this.repository = repository;
    this.token = args.token;
    this.apiBase = args.apiBase ?? GITHUB_API_BASE;
    this.logger = args.logger ?? console;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'boardsesh-discord-feedback',
      ...extra,
    };
  }

  private async githubFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const headers = new Headers(this.headers());
    new Headers(init.headers).forEach((headerValue, headerName) => headers.set(headerName, headerValue));
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      ...init,
      headers,
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfterSeconds = Number(response.headers.get('retry-after') ?? '0');
      await this.sleep(retryAfterSeconds > 0 ? retryAfterSeconds * 1000 : 1000 * 2 ** attempt);
      return this.githubFetch(path, init, attempt + 1);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new GitHubApiError(response.status, `GitHub ${response.status} for ${path}: ${detail}`);
    }
    return response;
  }

  async findIssueByMarker(marker: string): Promise<{ number: number; htmlUrl: string } | null> {
    const query = encodeURIComponent(`repo:${this.owner}/${this.repository} is:issue "${marker}"`);
    const response = await this.githubFetch(`/search/issues?q=${query}&per_page=1`);
    const payload = (await response.json()) as {
      total_count?: number;
      items?: Array<{ number: number; html_url: string }>;
    };
    const hit = payload.items?.[0];
    return hit && (payload.total_count ?? 0) > 0 ? { number: hit.number, htmlUrl: hit.html_url } : null;
  }

  async ensureLabels(labels: string[]): Promise<void> {
    for (const label of labels) {
      if (this.ensuredLabels.has(label)) continue;
      this.ensuredLabels.add(label);
      try {
        await this.githubFetch(`/repos/${this.owner}/${this.repository}/labels`, {
          method: 'POST',
          body: JSON.stringify({ name: label, color: LABEL_COLORS[label] ?? 'ededed' }),
        });
      } catch (error) {
        if (!(error instanceof GitHubApiError && error.status === 422)) {
          this.logger.warn(`[discord-feedback] ensure label ${label}: ${String(error)}`);
        }
      }
    }
  }

  async createIssue(issue: IssueDraft): Promise<{ number: number; htmlUrl: string }> {
    const response = await this.githubFetch(`/repos/${this.owner}/${this.repository}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title: issue.title, body: issue.body, labels: issue.labels }),
    });
    const created = (await response.json()) as { number: number; html_url: string };
    return { number: created.number, htmlUrl: created.html_url };
  }

  async uploadAttachment(filename: string, bytes: Uint8Array, contentType: string | null): Promise<string | null> {
    try {
      const releaseId = await this.ensureAttachmentRelease();
      const uniqueName = `${Date.now()}-${filename}`.replace(/[^\w.-]/g, '_');
      const response = await this.fetcher(
        `https://uploads.github.com/repos/${this.owner}/${this.repository}/releases/${releaseId}/assets?name=${encodeURIComponent(uniqueName)}`,
        {
          method: 'POST',
          headers: this.headers({ 'Content-Type': contentType ?? 'application/octet-stream' }),
          body: bytes as unknown as BodyInit,
        },
      );
      if (!response.ok) return null;
      const asset = (await response.json()) as { browser_download_url?: string };
      return asset.browser_download_url ?? null;
    } catch (error) {
      this.logger.warn(`[discord-feedback] attachment upload error for ${filename}: ${String(error)}`);
      return null;
    }
  }

  private async ensureAttachmentRelease(): Promise<number> {
    if (this.releaseId !== null) return this.releaseId;
    try {
      const response = await this.githubFetch(
        `/repos/${this.owner}/${this.repository}/releases/tags/discord-attachments`,
      );
      const release = (await response.json()) as { id: number };
      this.releaseId = release.id;
    } catch (error) {
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;
      const response = await this.githubFetch(`/repos/${this.owner}/${this.repository}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          tag_name: 'discord-attachments',
          name: 'Discord feedback attachments',
          body: 'Screenshots copied from Discord feedback so issue images remain available.',
          prerelease: true,
        }),
      });
      const release = (await response.json()) as { id: number };
      this.releaseId = release.id;
    }
    return this.releaseId;
  }
}

export type CollectOptions = {
  guildId: string;
  channelId: string;
  triggerMessageId: string;
  allowedUserIds: ReadonlySet<string>;
};

function messageTimestampMilliseconds(message: DiscordMessage): number {
  if (message.timestamp) return Date.parse(message.timestamp);
  return Number((BigInt(message.id) >> 22n) + 1_420_070_400_000n);
}

function humanMessages(messages: DiscordMessage[], selfUserId: string): DiscordMessage[] {
  return messages.filter((message) => isCollectableMessage(message, selfUserId));
}

function collectedSource(args: {
  primary: DiscordMessage;
  context: DiscordMessage[];
  attachmentMessages: DiscordMessage[];
  guildId: string;
  channel: DiscordChannel;
  threadId: string | null;
}): CollectedSource {
  return {
    messageId: args.primary.id,
    channelId: args.primary.channel_id,
    channelName: args.channel.name ?? null,
    guildId: args.guildId,
    threadId: args.threadId,
    authorRef: authorRef(args.guildId, args.primary.author?.id ?? 'unknown'),
    timestamp: args.primary.timestamp ?? '',
    jumpUrl: messageJumpUrl(args.guildId, args.primary.channel_id, args.primary.id),
    content: sanitizeText(args.primary.content ?? ''),
    context: args.context.map((message) => buildCollectedContextMessage(message, args.guildId)),
    attachments: collectImageAttachments(args.attachmentMessages),
  };
}

/** Re-fetch and re-authorize the exact command; workflow inputs are never trusted. */
export async function collectMentionCommand(
  options: CollectOptions,
  deps: { source: DiscordSource; now?: () => Date },
): Promise<CollectBundle> {
  const now = deps.now ?? (() => new Date());
  for (const [label, discordId] of [
    ['guild', options.guildId],
    ['channel', options.channelId],
    ['message', options.triggerMessageId],
  ] as const) {
    if (!/^\d{16,20}$/.test(discordId)) throw new Error(`Invalid Discord ${label} id`);
  }
  const [selfUserId, commandChannel, command] = await Promise.all([
    deps.source.getSelfUserId(),
    deps.source.getChannel(options.channelId),
    deps.source.getMessage(options.channelId, options.triggerMessageId),
  ]);

  if (commandChannel.guild_id !== options.guildId) throw new Error('Command channel is outside the configured guild');
  if (
    commandChannel.id !== options.channelId ||
    command.channel_id !== options.channelId ||
    command.id !== options.triggerMessageId
  ) {
    throw new Error('Discord returned command coordinates that do not match the requested message');
  }
  if (!isCollectableMessage(command, selfUserId)) throw new Error('Command was not sent by a human');
  if (!command.author?.id || !options.allowedUserIds.has(command.author.id)) {
    throw new Error('Command author is not in DISCORD_ISSUE_TRIGGER_USER_IDS');
  }
  if (!mentionsUser(command, selfUserId)) throw new Error('Command does not mention this bot');
  const instruction = extractCommandInstruction(command.content ?? '', selfUserId);
  if (!instruction) throw new Error('Command has no instruction after the bot mention');

  let source: CollectedSource;
  let sourceKind: CollectBundle['command']['sourceKind'];
  if (THREAD_CHANNEL_TYPES.has(commandChannel.type ?? -1)) {
    if (!commandChannel.parent_id) throw new Error('Discord thread has no parent channel');
    const [parentChannel, rawThreadMessages] = await Promise.all([
      deps.source.getChannel(commandChannel.parent_id),
      deps.source.listRecentMessages(commandChannel.id, 100),
    ]);
    const humanThreadMessages = humanMessages(rawThreadMessages, selfUserId).filter(
      (message) => message.id !== command.id,
    );
    let starter = await deps.source
      .getMessage(commandChannel.parent_id, commandChannel.id)
      .catch(() => humanThreadMessages[0]);
    if (!starter || !isCollectableMessage(starter, selfUserId)) starter = humanThreadMessages[0];
    if (!starter) throw new Error('Thread contains no human feedback message');
    const context = humanThreadMessages
      .filter((message) => message.id !== starter.id && message.id !== command.id)
      .slice(-THREAD_CONTEXT_LIMIT);
    source = collectedSource({
      primary: starter,
      context,
      attachmentMessages: [starter, ...context, command],
      guildId: options.guildId,
      channel: starter.channel_id === parentChannel.id ? parentChannel : commandChannel,
      threadId: commandChannel.id,
    });
    sourceKind = 'thread';
  } else if (command.message_reference?.message_id) {
    const sourceChannelId = command.message_reference.channel_id ?? command.channel_id;
    const [sourceChannel, referencedMessage] = await Promise.all([
      deps.source.getChannel(sourceChannelId),
      deps.source.getMessage(sourceChannelId, command.message_reference.message_id),
    ]);
    if (sourceChannel.guild_id !== options.guildId)
      throw new Error('Referenced message is outside the configured guild');
    if (!isCollectableMessage(referencedMessage, selfUserId))
      throw new Error('Referenced message was not sent by a human');
    source = collectedSource({
      primary: referencedMessage,
      context: [],
      attachmentMessages: [referencedMessage, command],
      guildId: options.guildId,
      channel: sourceChannel,
      threadId: null,
    });
    sourceKind = 'reply';
  } else {
    const priorMessages = await deps.source.listMessagesBefore(command.channel_id, command.id, 100);
    const commandAt = messageTimestampMilliseconds(command);
    const context = humanMessages(priorMessages, selfUserId)
      .filter((message) => {
        const ageMilliseconds = commandAt - messageTimestampMilliseconds(message);
        return ageMilliseconds >= 0 && ageMilliseconds <= CHANNEL_CONTEXT_LOOKBACK_MS;
      })
      .slice(-CHANNEL_CONTEXT_LIMIT);
    source = collectedSource({
      primary: command,
      context,
      attachmentMessages: [...context, command],
      guildId: options.guildId,
      channel: commandChannel,
      threadId: null,
    });
    sourceKind = 'channel-context';
  }

  return {
    version: 2,
    guildId: options.guildId,
    generatedAt: now().toISOString(),
    command: {
      messageId: command.id,
      channelId: command.channel_id,
      channelName: commandChannel.name ?? null,
      guildId: options.guildId,
      sourceKind,
      instruction,
      authorRef: authorRef(options.guildId, command.author.id),
      timestamp: command.timestamp ?? '',
      jumpUrl: messageJumpUrl(options.guildId, command.channel_id, command.id),
    },
    source,
  };
}

async function downloadAttachments(
  bundle: CollectBundle,
  deps: { issueSink: IssueSink; fetcher: Fetcher; logger: Logger },
): Promise<string[]> {
  const urls: string[] = [];
  for (const attachment of bundle.source.attachments) {
    if (attachment.size !== null && attachment.size > MAX_ATTACHMENT_BYTES) continue;
    try {
      const response = await deps.fetcher(attachment.url);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
      const hostedUrl = await deps.issueSink.uploadAttachment(attachment.filename, bytes, attachment.contentType);
      if (hostedUrl) urls.push(hostedUrl);
    } catch (error) {
      deps.logger.warn(`[discord-feedback] attachment ${attachment.filename} failed: ${String(error)}`);
    }
  }
  return urls;
}

export type ApplyResult = { filed: number; recovered: number; duplicates: number };

export async function applyTriage(
  bundle: CollectBundle,
  rawDecisions: unknown,
  options: { dryRun: boolean },
  deps: { issueSink: IssueSink; writer: DiscordWriter; fetcher: Fetcher; logger: Logger },
): Promise<ApplyResult> {
  const { accepted, rejected } = validateTriageResult(rawDecisions, bundle);
  if (rejected.length > 0) {
    const details = rejected.map((rejection) => `${rejection.issueIndex ?? '?'}: ${rejection.reason}`).join(' | ');
    throw new Error(`Refusing all writes because triage output is invalid: ${details}`);
  }
  if (options.dryRun) {
    for (const decision of accepted)
      deps.logger.log(`[discord-feedback] (dry run) ${decision.verdict}: ${decision.title}`);
    return { filed: 0, recovered: 0, duplicates: 0 };
  }

  const outcomes: AppliedIssue[] = [];
  const result: ApplyResult = { filed: 0, recovered: 0, duplicates: 0 };
  const existingIssueByIndex = new Map<number, { number: number; htmlUrl: string }>();
  for (const decision of accepted) {
    if (decision.verdict === 'duplicate') continue;
    const marker = discordFeedbackMarker(bundle.command.messageId, decision.issueIndex);
    const existing = await deps.issueSink.findIssueByMarker(marker);
    if (existing) existingIssueByIndex.set(decision.issueIndex, existing);
  }
  const needsNewIssue = accepted.some(
    (decision) => decision.verdict !== 'duplicate' && !existingIssueByIndex.has(decision.issueIndex),
  );
  const attachmentUrls = needsNewIssue ? await downloadAttachments(bundle, deps) : [];

  for (const decision of accepted) {
    if (decision.verdict === 'duplicate') {
      outcomes.push({ kind: 'duplicate', title: decision.title, issueUrl: decision.duplicateOf! });
      result.duplicates += 1;
      continue;
    }
    const existing = existingIssueByIndex.get(decision.issueIndex);
    if (existing) {
      outcomes.push({ kind: 'filed', title: decision.title, issueUrl: existing.htmlUrl });
      result.recovered += 1;
      continue;
    }
    const draft = buildIssueDraft(decision, bundle, attachmentUrls);
    await deps.issueSink.ensureLabels(draft.labels);
    const created = await deps.issueSink.createIssue(draft);
    outcomes.push({ kind: 'filed', title: draft.title, issueUrl: created.htmlUrl });
    result.filed += 1;
  }

  await deps.writer.removeReaction(bundle.command.channelId, bundle.command.messageId, '👀');
  await deps.writer.removeReaction(bundle.command.channelId, bundle.command.messageId, '❌');
  await deps.writer.addReaction(bundle.command.channelId, bundle.command.messageId, '✅');
  await deps.writer.postReply(
    bundle.command.channelId,
    bundle.command.messageId,
    bundle.guildId,
    buildReplyMessage(outcomes, attachmentUrls.length > 0),
  );
  return result;
}

export async function notifyFailure(
  args: { channelId: string; triggerMessageId: string; guildId: string },
  writer: DiscordWriter,
): Promise<void> {
  await writer.removeReaction(args.channelId, args.triggerMessageId, '👀').catch(() => undefined);
  await writer.removeReaction(args.channelId, args.triggerMessageId, '✅').catch(() => undefined);
  await writer.addReaction(args.channelId, args.triggerMessageId, '❌');
  await writer.postReply(
    args.channelId,
    args.triggerMessageId,
    args.guildId,
    'I could not create the issue. Mention me again to retry.',
  );
}

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv) {
  const mode = flagValue(argv, 'mode') ?? 'collect';
  if (mode !== 'collect' && mode !== 'apply' && mode !== 'notify-failure') {
    throw new Error(`Unknown --mode "${mode}".`);
  }
  return {
    mode,
    dryRun: argv.includes('--dry-run'),
    out: flagValue(argv, 'out') ?? 'discord-bundle.json',
    bundlePath: flagValue(argv, 'bundle') ?? 'discord-bundle.json',
    decisionsPath: flagValue(argv, 'decisions') ?? 'discord-decisions.json',
    bundleSha256: flagValue(argv, 'bundle-sha256') ?? '',
    channelId: flagValue(argv, 'channel-id') ?? '',
    triggerMessageId: flagValue(argv, 'trigger-message-id') ?? '',
    guildId: env.DISCORD_GUILD_ID?.trim() ?? '',
    discordToken: env.DISCORD_BOT_TOKEN?.trim() ?? '',
    allowedUserIds: new Set(csv(env.DISCORD_ISSUE_TRIGGER_USER_IDS)),
    githubToken: env.GITHUB_TOKEN?.trim() ?? '',
    repositoryFullName: env.GITHUB_REPOSITORY ?? 'boardsesh/boardsesh',
  };
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, logger: Logger): Promise<number> {
  const options = parseCliOptions(argv, env);
  if (!options.discordToken || !options.guildId || !options.channelId || !options.triggerMessageId) {
    logger.error('[discord-feedback] Discord token, guild id, channel id, and trigger message id are required.');
    return 1;
  }
  if (
    ![options.guildId, options.channelId, options.triggerMessageId].every((discordId) => /^\d{16,20}$/.test(discordId))
  ) {
    logger.error('[discord-feedback] Guild, channel, and trigger message ids must be Discord snowflakes.');
    return 1;
  }
  const discord = new DiscordClient({ token: options.discordToken, logger });

  if (options.mode === 'notify-failure') {
    if (options.dryRun) {
      logger.log('[discord-feedback] (dry run) skipped Discord failure notification');
      return 0;
    }
    await notifyFailure(
      { channelId: options.channelId, triggerMessageId: options.triggerMessageId, guildId: options.guildId },
      discord,
    );
    return 0;
  }

  if (options.mode === 'collect') {
    if (options.allowedUserIds.size === 0) {
      logger.error('[discord-feedback] DISCORD_ISSUE_TRIGGER_USER_IDS is empty.');
      return 1;
    }
    const bundle = await collectMentionCommand(
      {
        guildId: options.guildId,
        channelId: options.channelId,
        triggerMessageId: options.triggerMessageId,
        allowedUserIds: options.allowedUserIds,
      },
      { source: discord },
    );
    const serialized = JSON.stringify(bundle, null, 2);
    writeFileSync(options.out, serialized);
    logger.log(`[discord-feedback] collected command ${bundle.command.messageId} -> ${options.out}`);
    logger.log(`[discord-feedback] bundle-sha256=${bundleDigest(serialized)}`);
    return 0;
  }

  if (!options.githubToken) {
    logger.error('[discord-feedback] GITHUB_TOKEN is not set.');
    return 1;
  }
  const bundleRaw = readFileSync(options.bundlePath, 'utf8');
  if (!options.bundleSha256 || bundleDigest(bundleRaw) !== options.bundleSha256) {
    logger.error('[discord-feedback] bundle digest missing or mismatched; refusing to write.');
    return 1;
  }
  const bundle = JSON.parse(bundleRaw) as CollectBundle;
  if (
    bundle.version !== 2 ||
    bundle.guildId !== options.guildId ||
    bundle.command.channelId !== options.channelId ||
    bundle.command.messageId !== options.triggerMessageId
  ) {
    logger.error('[discord-feedback] bundle coordinates do not match the workflow inputs.');
    return 1;
  }
  const decisions = JSON.parse(readFileSync(options.decisionsPath, 'utf8')) as unknown;
  const result = await applyTriage(
    bundle,
    decisions,
    { dryRun: options.dryRun },
    {
      issueSink: new GitHubIssueClient({
        repositoryFullName: options.repositoryFullName,
        token: options.githubToken,
        logger,
      }),
      writer: discord,
      fetcher: fetch,
      logger,
    },
  );
  logger.log(
    `[discord-feedback] filed ${result.filed}, recovered ${result.recovered}, duplicates ${result.duplicates}`,
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runCli(process.argv.slice(2), process.env, console)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(`[discord-feedback] ${String(error)}`);
      process.exitCode = 1;
    });
}
