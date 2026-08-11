/// <reference types="node" />

/**
 * Discord feedback -> GitHub issues.
 *
 * Runs in two modes so the LLM triage step in between never holds a write tool:
 *
 *   vp run discord:feedback-scan -- --mode collect --out bundle.json
 *   vp run discord:feedback-scan -- --mode apply --bundle bundle.json --decisions decisions.json
 *
 * `collect` reads Discord and emits a redacted bundle of candidate messages.
 * A read-only agent classifies them into a decisions file. `apply` re-validates
 * every decision against the bundle, files the issues, then reacts and replies
 * in Discord. Discord content is written by anyone who can click a public
 * invite, so `apply` trusts the bundle and never the decisions.
 *
 * Idempotency has two independent guards: the processed reaction (read free
 * from the message payload) and the `<!-- discord-feedback:<id> -->` marker on
 * the issue body, found via GitHub search. There is no state file.
 *
 * Env: DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_FEEDBACK_CHANNEL_IDS,
 * DISCORD_EXCLUDE_CHANNEL_IDS, DISCORD_TRIGGER_EMOJI, DISCORD_PROCESSED_EMOJI,
 * DISCORD_TRIGGER_KEYWORDS, GITHUB_TOKEN, GITHUB_REPOSITORY.
 */

import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  buildCollectedMessage,
  clampDiscordMessage,
  containsTriggerKeyword,
  hasReactionByAnyone,
  hasReactionFromMe,
  isCollectableMessage,
  isLikelyNoise,
  snowflakeForTimestamp,
  timestampFromSnowflake,
  type CollectedMessage,
  type DiscordMessage,
  type TriggerKind,
} from './lib/discord-feedback';
import {
  buildIssueDraft,
  buildReplyMessage,
  discordFeedbackMarker,
  isGitHubIssueUrl,
  LABEL_COLORS,
  validateTriageResult,
  type IssueDraft,
  type TriageDecision,
} from './lib/discord-feedback-issue';

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const GITHUB_API_BASE = 'https://api.github.com';
const USER_AGENT = 'DiscordBot (https://github.com/boardsesh/boardsesh, 1.0)';

const DEFAULT_LOOKBACK_HOURS = 6;
const DEFAULT_REACTION_LOOKBACK_DAYS = 14;
const DEFAULT_MAX_MESSAGES = 50;
const DEFAULT_MAX_ISSUES = 5;
const DEFAULT_MAX_PAGES = 5;
const PAGE_LIMIT = 100;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** How much of a thread we read for context. Hitting it is logged, not silent. */
const THREAD_MESSAGE_LIMIT = 50;
/** Ceiling on a proactive rate-limit wait; the header value is an unbounded float. */
const MAX_RATE_LIMIT_SLEEP_SECONDS = 60;

/** Text channel types worth scanning: GUILD_TEXT (0) and GUILD_ANNOUNCEMENT (5). */
const SCANNABLE_CHANNEL_TYPES: ReadonlySet<number> = new Set([0, 5]);

/** Exported so tests can type an injected fake without restating the shape. */
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
type Logger = Pick<Console, 'error' | 'log' | 'warn'>;
type Sleep = (ms: number) => Promise<void>;

export type CollectBundle = {
  guildId: string;
  generatedAt: string;
  messages: CollectedMessage[];
  /** Messages that matched a trigger but were dropped over the cap. */
  deferredCount: number;
};

export type DiscordSource = {
  getSelfUserId(): Promise<string | null>;
  listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string; type: number }>>;
  listChannelMessages(channelId: string, afterSnowflake: string, maxPages: number): Promise<DiscordMessage[]>;
  getMessage(channelId: string, messageId: string): Promise<DiscordMessage | null>;
  listActiveThreads(guildId: string): Promise<Array<{ id: string; parent_id?: string; name?: string }>>;
  listThreadMessages(threadId: string, limit: number): Promise<DiscordMessage[]>;
};

export type DiscordWriter = {
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  postReply(args: {
    channelId: string;
    messageId: string;
    threadId: string | null;
    guildId: string;
    content: string;
  }): Promise<void>;
};

export type IssueSink = {
  findIssueByMarker(marker: string): Promise<{ number: number; htmlUrl: string } | null>;
  ensureLabels(labels: string[]): Promise<void>;
  createIssue(issue: IssueDraft): Promise<{ number: number; htmlUrl: string }>;
  uploadAttachment(filename: string, bytes: Uint8Array, contentType: string | null): Promise<string | null>;
};

const sleepReal: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Digest of the collected bundle, used to prove it was not edited between the
 * collect step and the apply step — the window in which the triage agent runs.
 */
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

// --- Discord ---------------------------------------------------------------

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

  /**
   * Single retry/backoff choke point for every Discord call.
   *
   * 401 fails immediately and deliberately: repeated unauthorized requests earn
   * a Cloudflare ban on the runner's egress IP, which would take out unrelated
   * CI jobs.
   */
  private async discordFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Authorization: `Bot ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
        ...init.headers,
      },
    });

    if (response.status === 401 || response.status === 403) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new Error(
        `Discord ${response.status} for ${path} — check the bot token and channel permissions: ${detail}`,
      );
    }

    if (response.status === 429 && attempt < 5) {
      const body = readJsonSafely(await response.text().catch(() => '')) as { retry_after?: number } | null;
      const retryAfterMs = Math.max(0, (body?.retry_after ?? 1) * 1000) + 250;
      const scope = response.headers.get('x-ratelimit-scope');
      this.logger.warn(`[discord-feedback] 429 on ${path} (scope=${scope ?? 'unknown'}), waiting ${retryAfterMs}ms`);
      await this.sleep(scope === 'global' ? retryAfterMs + 1000 : retryAfterMs);
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

    // Stay ahead of the bucket rather than earning a 429 we then have to sleep
    // off. Capped: reset-after is an unbounded float from Discord, and an
    // absurd value would otherwise stall the whole job on one header.
    if (response.headers.get('x-ratelimit-remaining') === '0') {
      const resetAfter = Number(response.headers.get('x-ratelimit-reset-after') ?? '0');
      if (resetAfter > 0) await this.sleep(Math.min(resetAfter, MAX_RATE_LIMIT_SLEEP_SECONDS) * 1000);
    }

    return response;
  }

  private async getJson<T>(path: string): Promise<T> {
    const response = await this.discordFetch(path, { method: 'GET' });
    return (await response.json()) as T;
  }

  async getSelfUserId(): Promise<string | null> {
    const user = await this.getJson<{ id?: string }>('/users/@me');
    return user.id ?? null;
  }

  async listGuildChannels(guildId: string): Promise<Array<{ id: string; name: string; type: number }>> {
    const channels = await this.getJson<Array<{ id: string; name?: string; type?: number }>>(
      `/guilds/${guildId}/channels`,
    );
    return channels
      .filter((channel) => SCANNABLE_CHANNEL_TYPES.has(channel.type ?? -1))
      .map((channel) => ({ id: channel.id, name: channel.name ?? channel.id, type: channel.type ?? 0 }));
  }

  /**
   * Page forward through a channel from `afterSnowflake`.
   *
   * Callers also filter on the message timestamp: Discord's `after` semantics
   * when more than `limit` messages qualify are ambiguous, and the timestamp
   * check keeps the window correct under either reading.
   */
  async listChannelMessages(channelId: string, afterSnowflake: string, maxPages: number): Promise<DiscordMessage[]> {
    const collected: DiscordMessage[] = [];
    let after = afterSnowflake;

    for (let page = 0; page < maxPages; page += 1) {
      const messages = await this.getJson<DiscordMessage[]>(
        `/channels/${channelId}/messages?limit=${PAGE_LIMIT}&after=${after}`,
      );
      if (messages.length === 0) break;
      collected.push(...messages);

      // Snowflakes sort lexically only at equal length, so compare numerically.
      after = messages.reduce(
        (highest, message) => (BigInt(message.id) > BigInt(highest) ? message.id : highest),
        after,
      );

      if (messages.length < PAGE_LIMIT) break;
      if (page === maxPages - 1) {
        this.logger.warn(
          `[discord-feedback] channel ${channelId} still full at page ${maxPages} — raise --max-pages if this recurs`,
        );
      }
    }

    return collected;
  }

  async getMessage(channelId: string, messageId: string): Promise<DiscordMessage | null> {
    try {
      return await this.getJson<DiscordMessage>(`/channels/${channelId}/messages/${messageId}`);
    } catch (error) {
      this.logger.warn(`[discord-feedback] could not read message ${messageId}: ${String(error)}`);
      return null;
    }
  }

  async listActiveThreads(guildId: string): Promise<Array<{ id: string; parent_id?: string; name?: string }>> {
    const response = await this.getJson<{ threads?: Array<{ id: string; parent_id?: string; name?: string }> }>(
      `/guilds/${guildId}/threads/active`,
    );
    return response.threads ?? [];
  }

  async listThreadMessages(threadId: string, limit: number): Promise<DiscordMessage[]> {
    const messages = await this.getJson<DiscordMessage[]>(`/channels/${threadId}/messages?limit=${limit}`);
    return messages.reverse(); // Discord returns newest-first; read order is chronological.
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.discordFetch(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`, {
      method: 'PUT',
    });
  }

  /**
   * Reply in the thread when one exists, otherwise inline in the channel.
   *
   * Creating a thread per message would be unbearable noise in a channel where
   * every message is feedback, so the no-thread case uses message_reference.
   */
  async postReply(args: {
    channelId: string;
    messageId: string;
    threadId: string | null;
    guildId: string;
    content: string;
  }): Promise<void> {
    const target = args.threadId ?? args.channelId;
    const payload: Record<string, unknown> = {
      content: clampDiscordMessage(args.content),
      allowed_mentions: { parse: [] },
    };
    if (!args.threadId) {
      payload.message_reference = {
        message_id: args.messageId,
        channel_id: args.channelId,
        guild_id: args.guildId,
        fail_if_not_exists: false,
      };
    }
    await this.discordFetch(`/channels/${target}/messages`, { method: 'POST', body: JSON.stringify(payload) });
  }
}

// --- GitHub ----------------------------------------------------------------

/**
 * Carries the HTTP status as a field.
 *
 * Callers branch on specific codes (404 "create it", 422 "already exists"), and
 * sniffing the digits out of a message string breaks the moment the wording
 * changes — or matches a 404 that happened to appear in a response body.
 */
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
  private readonly attachmentReleaseTag: string;
  private readonly ensuredLabels = new Set<string>();
  private releaseId: number | null = null;

  constructor(args: {
    fetcher?: Fetcher;
    repositoryFullName: string;
    token: string;
    apiBase?: string;
    logger?: Logger;
    attachmentReleaseTag?: string;
    sleep?: Sleep;
  }) {
    const [owner, repository] = args.repositoryFullName.split('/');
    if (!owner || !repository) {
      throw new Error(`Invalid GitHub repository "${args.repositoryFullName}". Expected owner/name.`);
    }
    this.fetcher = args.fetcher ?? fetch;
    this.sleep = args.sleep ?? sleepReal;
    this.owner = owner;
    this.repository = repository;
    this.token = args.token;
    this.apiBase = args.apiBase ?? GITHUB_API_BASE;
    this.logger = args.logger ?? console;
    this.attachmentReleaseTag = args.attachmentReleaseTag ?? 'discord-attachments';
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

  /**
   * Retries transient failures, like the Discord client does.
   *
   * The search API used by `findIssueByMarker` allows only 30 requests a
   * minute. A search that dies un-retried after an issue was already filed
   * would leave the marker guard unable to fire next run, which is exactly the
   * path that produces a duplicate issue.
   */
  private async githubFetch(path: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const response = await this.fetcher(`${this.apiBase}${path}`, {
      ...init,
      headers: { ...this.headers(), ...init.headers },
    });

    const retriable = response.status === 429 || (response.status >= 500 && response.status < 600);
    if (retriable && attempt < 3) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '0');
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
      this.logger.warn(`[discord-feedback] GitHub ${response.status} on ${path}, retrying in ${waitMs}ms`);
      await this.sleep(waitMs);
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
    if (!hit || (payload.total_count ?? 0) === 0) return null;
    return { number: hit.number, htmlUrl: hit.html_url };
  }

  /**
   * Create any labels that don't exist yet.
   *
   * Memoized per run: labels repeat across almost every issue, and without this
   * each one costs a POST per issue that only ever returns "already exists".
   */
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
        // 422 is "already exists", the common case. Never block issue creation on this.
        if (!(error instanceof GitHubApiError && error.status === 422)) {
          this.logger.warn(`[discord-feedback] ensureLabel ${label}: ${String(error)}`);
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

  /**
   * Host an image so it survives.
   *
   * GitHub has no API for attaching a file to an issue — the drag-and-drop
   * uploader is web-only — and Discord CDN links are signed and expire in about
   * a day. Release assets are the durable option: stable URLs, and they live
   * outside git history so the repo doesn't grow.
   */
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
      if (!response.ok) {
        this.logger.warn(`[discord-feedback] attachment upload failed (${response.status}) for ${filename}`);
        return null;
      }
      const asset = (await response.json()) as { browser_download_url?: string };
      return asset.browser_download_url ?? null;
    } catch (error) {
      this.logger.warn(`[discord-feedback] attachment upload error for ${filename}: ${String(error)}`);
      return null;
    }
  }

  private async ensureAttachmentRelease(): Promise<number> {
    if (this.releaseId != null) return this.releaseId;
    try {
      const response = await this.githubFetch(
        `/repos/${this.owner}/${this.repository}/releases/tags/${this.attachmentReleaseTag}`,
      );
      const release = (await response.json()) as { id: number };
      this.releaseId = release.id;
      return release.id;
    } catch (error) {
      // Only "it isn't there yet" means create it. A 5xx or an auth failure must
      // surface as itself rather than being reported as a freshly created release.
      if (!(error instanceof GitHubApiError && error.status === 404)) throw error;

      const response = await this.githubFetch(`/repos/${this.owner}/${this.repository}/releases`, {
        method: 'POST',
        body: JSON.stringify({
          tag_name: this.attachmentReleaseTag,
          name: 'Discord feedback attachments',
          body: 'Screenshots re-hosted from Discord feedback so issue images do not rot when the Discord CDN link expires.',
          prerelease: true,
        }),
      });
      const release = (await response.json()) as { id: number };
      this.releaseId = release.id;
      return release.id;
    }
  }
}

// --- Collect ---------------------------------------------------------------

export type CollectOptions = {
  guildId: string;
  feedbackChannelIds: string[];
  excludeChannelIds: string[];
  triggerEmoji: string;
  processedEmoji: string;
  triggerKeywords: string[];
  lookbackHours: number;
  reactionLookbackDays: number;
  maxMessages: number;
  maxPages: number;
};

/**
 * Three passes, because one lookback window silently misses things: someone can
 * react to a three-week-old message today, or open a thread on an ancient one.
 *
 *   A — every human message in the feedback channels, recent window
 *   B — trigger-reacted messages anywhere else, wider window
 *   C — keyword threads, active window but any age of parent message
 */
export async function collectFeedback(
  options: CollectOptions,
  deps: { source: DiscordSource; logger: Logger },
): Promise<CollectBundle> {
  const { source, logger } = deps;
  const selfUserId = await source.getSelfUserId();
  const now = Date.now();
  const feedbackCutoff = now - options.lookbackHours * 3600_000;
  const reactionCutoff = now - options.reactionLookbackDays * 86_400_000;

  // Losing the channel list costs us the reaction pass, not the run: the
  // explicitly-configured feedback channels are still readable by id.
  let channels: Array<{ id: string; name: string; type: number }> = [];
  try {
    channels = await source.listGuildChannels(options.guildId);
  } catch (error) {
    logger.warn(`[discord-feedback] could not list guild channels, skipping the reaction pass: ${String(error)}`);
  }
  const channelNames = new Map(channels.map((channel) => [channel.id, channel.name]));
  const excluded = new Set(options.excludeChannelIds);
  const feedbackChannels = new Set(options.feedbackChannelIds);

  const collected = new Map<string, CollectedMessage>();
  let deferredCount = 0;
  let emptyContentCount = 0;
  let seenCount = 0;

  const add = (
    message: DiscordMessage,
    trigger: TriggerKind,
    threadId: string | null,
    threadMessages: DiscordMessage[],
  ) => {
    if (collected.has(message.id)) return;
    if (collected.size >= options.maxMessages) {
      // Leave it unreacted so the next run picks it up; a backlog drains
      // gradually instead of dumping every issue at once.
      deferredCount += 1;
      return;
    }
    collected.set(
      message.id,
      buildCollectedMessage({
        message,
        guildId: options.guildId,
        channelName: channelNames.get(message.channel_id) ?? null,
        trigger,
        threadId,
        threadMessages,
      }),
    );
  };

  const usable = (message: DiscordMessage, cutoff: number): boolean => {
    if (!isCollectableMessage(message, selfUserId)) return false;
    if (hasReactionFromMe(message, options.processedEmoji)) return false;
    const at = message.timestamp ? Date.parse(message.timestamp) : timestampFromSnowflake(message.id);
    return at >= cutoff;
  };

  const readThread = async (
    message: DiscordMessage,
  ): Promise<{ threadId: string | null; messages: DiscordMessage[] }> => {
    const threadId = message.thread?.id ?? null;
    if (!threadId) return { threadId: null, messages: [] };
    try {
      const messages = await source.listThreadMessages(threadId, THREAD_MESSAGE_LIMIT);
      if (messages.length >= THREAD_MESSAGE_LIMIT) {
        logger.warn(
          `[discord-feedback] thread ${threadId} hit the ${THREAD_MESSAGE_LIMIT}-message cap; older replies not read`,
        );
      }
      return { threadId, messages };
    } catch {
      return { threadId, messages: [] };
    }
  };

  // Pass A — the always-feedback channels.
  if (options.feedbackChannelIds.length === 0) {
    logger.warn(
      '[discord-feedback] DISCORD_FEEDBACK_CHANNEL_IDS is empty — only reaction and thread triggers will be picked up.',
    );
  }
  for (const channelId of options.feedbackChannelIds) {
    if (excluded.has(channelId)) continue;
    const messages = await source.listChannelMessages(
      channelId,
      snowflakeForTimestamp(feedbackCutoff),
      options.maxPages,
    );
    for (const message of messages) {
      seenCount += 1;
      if (!message.content && (message.attachments ?? []).length === 0) emptyContentCount += 1;
      if (!usable(message, feedbackCutoff)) continue;
      if (isLikelyNoise(message.content ?? '')) continue;
      const thread = await readThread(message);
      add(message, 'feedback-channel', thread.threadId, thread.messages);
    }
  }

  // Pass B — trigger reactions anywhere else the bot can see.
  for (const channel of channels) {
    if (feedbackChannels.has(channel.id) || excluded.has(channel.id)) continue;
    let messages: DiscordMessage[];
    try {
      messages = await source.listChannelMessages(channel.id, snowflakeForTimestamp(reactionCutoff), options.maxPages);
    } catch (error) {
      // A channel the bot cannot read is normal — permissions are how scanning is scoped.
      logger.warn(`[discord-feedback] skipping #${channel.name}: ${String(error)}`);
      continue;
    }
    for (const message of messages) {
      seenCount += 1;
      if (!message.content && (message.attachments ?? []).length === 0) emptyContentCount += 1;
      if (!hasReactionByAnyone(message, options.triggerEmoji)) continue;
      if (!usable(message, reactionCutoff)) continue;
      // No isLikelyNoise() here on purpose: someone deliberately reacted, and
      // that human signal outranks a length heuristic.
      const thread = await readThread(message);
      add(message, 'reaction', thread.threadId, thread.messages);
    }
  }

  // Pass C — keyword threads. A public thread started from a message shares the
  // message's id, so the parent resolves directly with no search.
  let threads: Array<{ id: string; parent_id?: string; name?: string }> = [];
  try {
    threads = await source.listActiveThreads(options.guildId);
  } catch (error) {
    logger.warn(`[discord-feedback] could not list active threads, skipping the thread pass: ${String(error)}`);
  }
  for (const thread of threads) {
    if (!thread.parent_id || excluded.has(thread.parent_id)) continue;
    let threadMessages: DiscordMessage[];
    try {
      threadMessages = await source.listThreadMessages(thread.id, THREAD_MESSAGE_LIMIT);
      if (threadMessages.length >= THREAD_MESSAGE_LIMIT) {
        logger.warn(`[discord-feedback] thread ${thread.id} hit the ${THREAD_MESSAGE_LIMIT}-message cap`);
      }
    } catch {
      continue;
    }
    const triggered = threadMessages.some((message) =>
      containsTriggerKeyword(message.content ?? '', options.triggerKeywords),
    );
    if (!triggered) continue;

    const parent = await source.getMessage(thread.parent_id, thread.id);
    if (!parent) continue;
    if (!isCollectableMessage(parent, selfUserId)) continue;
    if (hasReactionFromMe(parent, options.processedEmoji)) continue;
    // No isLikelyNoise() on the parent here, deliberately. In a keyword thread
    // the report usually lives in the replies — the parent is often a screenshot
    // or a one-liner — so filtering on the parent would drop the very reports
    // this pass exists to catch. The thread text goes to the model as context.
    add(parent, 'thread-keyword', thread.id, threadMessages);
  }

  // A disabled Message Content intent is indistinguishable from a quiet server
  // except by this ratio, and it is the single most common setup mistake.
  if (seenCount >= 10 && emptyContentCount / seenCount > 0.5) {
    throw new Error(
      `[discord-feedback] ${emptyContentCount}/${seenCount} messages came back with no content. ` +
        'The MESSAGE CONTENT privileged intent is almost certainly disabled for this bot.',
    );
  }

  return {
    guildId: options.guildId,
    generatedAt: new Date(now).toISOString(),
    messages: [...collected.values()],
    deferredCount,
  };
}

// --- Apply -----------------------------------------------------------------

export type ApplyOptions = {
  guildId: string;
  processedEmoji: string;
  maxIssues: number;
  dryRun: boolean;
};

export type ApplyResult = {
  filed: number;
  duplicates: number;
  acknowledged: number;
  deferred: number;
  rejected: number;
};

async function downloadAttachments(
  message: CollectedMessage,
  deps: { issueSink: IssueSink; fetcher: Fetcher; logger: Logger },
): Promise<string[]> {
  const urls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.size != null && attachment.size > MAX_ATTACHMENT_BYTES) continue;
    try {
      const response = await deps.fetcher(attachment.url);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
      const hosted = await deps.issueSink.uploadAttachment(attachment.filename, bytes, attachment.contentType);
      if (hosted) urls.push(hosted);
    } catch (error) {
      deps.logger.warn(`[discord-feedback] attachment ${attachment.filename} failed: ${String(error)}`);
    }
  }
  return urls;
}

/**
 * File, react, reply — in that order, one message at a time.
 *
 * The ordering is the correctness core. Filing first means a crash before the
 * reaction is recoverable: the marker lookup finds the issue next run and we
 * react and reply without filing twice. The reverse order would turn a missing
 * reply into a duplicate reply on every subsequent run, which is worse.
 *
 * Writes are sequential on purpose — Discord's per-channel buckets punish
 * parallelism with 429s.
 */
export async function applyTriage(
  options: ApplyOptions,
  bundle: CollectBundle,
  rawDecisions: unknown,
  deps: { issueSink: IssueSink; writer: DiscordWriter; fetcher: Fetcher; logger: Logger },
): Promise<ApplyResult> {
  const { accepted, rejected } = validateTriageResult(rawDecisions, bundle);
  for (const rejection of rejected) {
    deps.logger.warn(`[discord-feedback] dropped decision (${rejection.messageId ?? 'unknown'}): ${rejection.reason}`);
  }

  const byId = new Map(bundle.messages.map((message) => [message.messageId, message]));
  const result: ApplyResult = { filed: 0, duplicates: 0, acknowledged: 0, deferred: 0, rejected: rejected.length };
  // A message the model marked as duplicating a sibling replies with whatever
  // URL that sibling ended up at.
  const filedUrlByMessageId = new Map<string, string>();

  // Duplicates go last: one pointing at a sibling can only be answered with a
  // link once that sibling has actually been filed.
  const ordered = [...accepted].sort(
    (left, right) => Number(left.verdict === 'duplicate') - Number(right.verdict === 'duplicate'),
  );

  for (const decision of ordered) {
    const message = byId.get(decision.messageId);
    if (!message) continue;

    if (options.dryRun) {
      deps.logger.log(`[discord-feedback] (dry run) ${decision.verdict}: ${decision.title || message.messageId}`);
      continue;
    }

    try {
      const outcome = await applyOne(decision, message, options, result, filedUrlByMessageId, deps);
      if (outcome) filedUrlByMessageId.set(decision.messageId, outcome);
    } catch (error) {
      deps.logger.error(`[discord-feedback] failed on message ${decision.messageId}: ${String(error)}`);
    }
  }

  result.deferred = bundle.deferredCount;
  return result;
}

async function applyOne(
  decision: TriageDecision,
  message: CollectedMessage,
  options: ApplyOptions,
  result: ApplyResult,
  filedUrlByMessageId: Map<string, string>,
  deps: { issueSink: IssueSink; writer: DiscordWriter; fetcher: Fetcher; logger: Logger },
): Promise<string | null> {
  const react = () => deps.writer.addReaction(message.channelId, message.messageId, options.processedEmoji);
  const reply = (content: string) =>
    deps.writer.postReply({
      channelId: message.channelId,
      messageId: message.messageId,
      threadId: message.threadId,
      guildId: options.guildId,
      content,
    });

  if (decision.verdict === 'question' || decision.verdict === 'noise') {
    await react();
    result.acknowledged += 1;
    return null;
  }

  if (decision.verdict === 'duplicate') {
    const target = decision.duplicateOf && filedUrlByMessageId.get(decision.duplicateOf);
    const issueUrl = target ?? decision.duplicateOf ?? '';
    await react();
    // Belt to validateTriageResult's braces: this string becomes a clickable
    // link the bot posts into Discord, so it must be a GitHub issue or nothing.
    if (isGitHubIssueUrl(issueUrl)) await reply(buildReplyMessage({ kind: 'duplicate', issueUrl }));
    result.duplicates += 1;
    return null;
  }

  if (result.filed >= options.maxIssues) {
    // Left unreacted deliberately: the next run picks it up.
    deps.logger.log(`[discord-feedback] issue cap reached, deferring ${message.messageId}`);
    return null;
  }

  const marker = discordFeedbackMarker(message.messageId);
  const existing = await deps.issueSink.findIssueByMarker(marker);

  let issue: { number: number; htmlUrl: string };
  let hadAttachments = false;

  if (existing) {
    // Crash recovery: a previous run filed this and died before reacting.
    deps.logger.log(`[discord-feedback] issue #${existing.number} already exists for ${message.messageId}`);
    issue = existing;
  } else {
    const attachmentUrls = await downloadAttachments(message, deps);
    hadAttachments = attachmentUrls.length > 0;
    const draft = buildIssueDraft(decision, message, attachmentUrls);
    await deps.issueSink.ensureLabels(draft.labels);
    issue = await deps.issueSink.createIssue(draft);
    result.filed += 1;
  }

  await react();
  await reply(buildReplyMessage({ kind: 'filed', issueUrl: issue.htmlUrl, hadAttachments }));
  return issue.htmlUrl;
}

// --- CLI -------------------------------------------------------------------

function flagValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function csv(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function parseCliOptions(argv: string[], env: NodeJS.ProcessEnv) {
  const mode = flagValue(argv, 'mode') ?? 'collect';
  if (mode !== 'collect' && mode !== 'apply') {
    throw new Error(`Unknown --mode "${mode}". Expected "collect" or "apply".`);
  }

  return {
    mode,
    dryRun: argv.includes('--dry-run'),
    out: flagValue(argv, 'out') ?? 'discord-bundle.json',
    bundlePath: flagValue(argv, 'bundle') ?? 'discord-bundle.json',
    decisionsPath: flagValue(argv, 'decisions') ?? 'discord-decisions.json',
    bundleSha256: flagValue(argv, 'bundle-sha256') ?? '',
    guildId: env.DISCORD_GUILD_ID ?? '',
    discordToken: env.DISCORD_BOT_TOKEN ?? '',
    githubToken: env.GITHUB_TOKEN ?? '',
    repositoryFullName: env.GITHUB_REPOSITORY ?? 'boardsesh/boardsesh',
    feedbackChannelIds: csv(env.DISCORD_FEEDBACK_CHANNEL_IDS),
    excludeChannelIds: csv(env.DISCORD_EXCLUDE_CHANNEL_IDS),
    triggerEmoji: env.DISCORD_TRIGGER_EMOJI || '🐛',
    processedEmoji: env.DISCORD_PROCESSED_EMOJI || '✅',
    triggerKeywords: csv(env.DISCORD_TRIGGER_KEYWORDS || 'bug,issue,file this,feature request'),
    lookbackHours: positiveInt(flagValue(argv, 'lookback-hours'), DEFAULT_LOOKBACK_HOURS),
    reactionLookbackDays: positiveInt(flagValue(argv, 'reaction-lookback-days'), DEFAULT_REACTION_LOOKBACK_DAYS),
    maxMessages: positiveInt(flagValue(argv, 'max-messages'), DEFAULT_MAX_MESSAGES),
    maxIssues: positiveInt(flagValue(argv, 'max-issues'), DEFAULT_MAX_ISSUES),
    maxPages: positiveInt(flagValue(argv, 'max-pages'), DEFAULT_MAX_PAGES),
  };
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv, logger: Logger): Promise<number> {
  const options = parseCliOptions(argv, env);

  if (!options.discordToken) {
    logger.error('[discord-feedback] DISCORD_BOT_TOKEN is not set.');
    return 1;
  }
  if (!options.guildId) {
    logger.error('[discord-feedback] DISCORD_GUILD_ID is not set.');
    return 1;
  }

  const discord = new DiscordClient({ token: options.discordToken, logger });

  if (options.mode === 'collect') {
    const bundle = await collectFeedback(options, { source: discord, logger });
    const serialized = JSON.stringify(bundle, null, 2);
    writeFileSync(options.out, serialized);
    logger.log(
      `[discord-feedback] collected ${bundle.messages.length} message(s), deferred ${bundle.deferredCount} -> ${options.out}`,
    );
    // The caller pins this and hands it back to `apply` — see bundleDigest.
    logger.log(`[discord-feedback] bundle-sha256=${bundleDigest(serialized)}`);
    return 0;
  }

  if (!options.githubToken) {
    logger.error('[discord-feedback] GITHUB_TOKEN is not set.');
    return 1;
  }

  const bundleRaw = readFileSync(options.bundlePath, 'utf8');

  // The triage agent runs between collect and apply with a Write tool. Without
  // this check, an injected prompt could rewrite the bundle *and* the decisions
  // to match, and validateTriageResult — which cross-checks one against the
  // other — would happily pass fabricated issues through. The digest is pinned
  // by the workflow before the agent runs, somewhere it cannot write.
  if (options.bundleSha256) {
    const actual = bundleDigest(bundleRaw);
    if (actual !== options.bundleSha256) {
      logger.error(
        `[discord-feedback] bundle digest mismatch: expected ${options.bundleSha256}, got ${actual}. ` +
          'The bundle changed after collection — refusing to file anything.',
      );
      return 1;
    }
  } else {
    logger.warn('[discord-feedback] no --bundle-sha256 given; skipping the bundle tamper check.');
  }

  const bundle = JSON.parse(bundleRaw) as CollectBundle;
  const decisions = JSON.parse(readFileSync(options.decisionsPath, 'utf8')) as unknown;

  const result = await applyTriage(
    {
      guildId: options.guildId,
      processedEmoji: options.processedEmoji,
      maxIssues: options.maxIssues,
      dryRun: options.dryRun,
    },
    bundle,
    decisions,
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
    `[discord-feedback] filed ${result.filed}, duplicates ${result.duplicates}, acknowledged ${result.acknowledged}, ` +
      `deferred ${result.deferred}, rejected ${result.rejected}`,
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
