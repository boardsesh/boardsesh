/// <reference types="node" />

/**
 * Pure helpers for the Discord feedback scanner. No I/O — everything here is a
 * function of its arguments so it can be unit-tested without a Discord token.
 *
 * The I/O shell that drives these lives in `scripts/discord-feedback-scan.ts`.
 */

import { createHash } from 'node:crypto';

import { redactSensitiveText, stripDiscordMentions } from '@boardsesh/text-redaction';

/** Discord snowflakes count milliseconds from 2015-01-01T00:00:00Z. */
export const DISCORD_EPOCH_MS = 1_420_070_400_000;

/** Hard cap Discord enforces on a message body. */
export const DISCORD_MESSAGE_LIMIT = 2000;

/**
 * Message types we treat as real messages: DEFAULT (0), REPLY (19), and
 * THREAD_STARTER_MESSAGE (21). Everything else is a system event — joins, pins,
 * boosts — and never carries feedback.
 */
const COLLECTABLE_MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19, 21]);

/**
 * Short replies that are never worth a triage pass. Matched against the whole
 * message once mentions, custom emoji, and punctuation are stripped.
 */
const NOISE_PHRASES: ReadonlySet<string> = new Set([
  '+1',
  'agreed',
  'gm',
  'lol',
  'nice',
  'ok',
  'okay',
  'same',
  'thank you',
  'thanks',
  'this',
  'ty',
  'yes',
  'yep',
]);

const MIN_SIGNAL_LENGTH = 12;

export type DiscordEmoji = {
  id?: string | null;
  name?: string | null;
};

export type DiscordReaction = {
  count?: number;
  /** True when the token's own user has reacted — our "already processed" signal. */
  me?: boolean;
  emoji?: DiscordEmoji;
};

export type DiscordAttachment = {
  id: string;
  filename?: string;
  size?: number;
  content_type?: string;
  url?: string;
  width?: number | null;
  height?: number | null;
};

export type DiscordAuthor = {
  id: string;
  bot?: boolean;
  username?: string;
  global_name?: string | null;
  discriminator?: string;
  avatar?: string | null;
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  type?: number;
  content?: string;
  timestamp?: string;
  author?: DiscordAuthor;
  webhook_id?: string;
  reactions?: DiscordReaction[];
  attachments?: DiscordAttachment[];
  thread?: { id: string } | null;
};

/** How a message came to our attention. Recorded on the issue for provenance. */
export type TriggerKind = 'feedback-channel' | 'reaction' | 'thread-keyword';

export type CollectedAttachment = {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  /** Signed Discord CDN URL — expires in roughly 24h, so download promptly. */
  url: string;
};

export type CollectedMessage = {
  messageId: string;
  channelId: string;
  channelName: string | null;
  guildId: string;
  threadId: string | null;
  trigger: TriggerKind;
  /** Opaque, stable per reporter. Never the Discord user id. */
  authorRef: string;
  timestamp: string;
  jumpUrl: string;
  /** Redacted and mention-stripped. */
  content: string;
  /** Redacted and mention-stripped, oldest first. */
  threadContext: Array<{ authorRef: string; content: string }>;
  attachments: CollectedAttachment[];
};

/**
 * Lowest snowflake that could have been created at `ms`.
 *
 * Lets a lookback window become an `after=` query parameter with no state file
 * to persist between runs. BigInt throughout — the shifted value exceeds
 * Number.MAX_SAFE_INTEGER, so plain arithmetic silently corrupts it.
 */
export function snowflakeForTimestamp(ms: number): string {
  const offset = BigInt(Math.max(0, Math.floor(ms) - DISCORD_EPOCH_MS));
  return (offset << 22n).toString();
}

/** Creation time encoded in a snowflake. */
export function timestampFromSnowflake(id: string): number {
  return Number((BigInt(id) >> 22n) + BigInt(DISCORD_EPOCH_MS));
}

/**
 * Match a reaction's emoji against a configured spec.
 *
 * Unicode emoji are configured directly ("🐛"). Custom server emoji have no
 * unicode form, so they're configured as "name:id" and matched on the id, which
 * is the part that can't be spoofed by renaming.
 */
export function matchesEmoji(emoji: DiscordEmoji | undefined, spec: string): boolean {
  if (!emoji || !spec) return false;
  const separator = spec.lastIndexOf(':');
  if (separator > 0) {
    const specId = spec.slice(separator + 1);
    return Boolean(emoji.id) && emoji.id === specId;
  }
  return !emoji.id && emoji.name === spec;
}

/** True when the bot itself has already reacted with `spec`. */
export function hasReactionFromMe(message: DiscordMessage, spec: string): boolean {
  return (message.reactions ?? []).some((reaction) => reaction.me === true && matchesEmoji(reaction.emoji, spec));
}

/** True when anyone has reacted with `spec`. */
export function hasReactionByAnyone(message: DiscordMessage, spec: string): boolean {
  return (message.reactions ?? []).some((reaction) => (reaction.count ?? 0) > 0 && matchesEmoji(reaction.emoji, spec));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True when `text` contains any keyword as a whole phrase.
 *
 * Word-boundary anchored so "bug" does not fire on "debugging" — a substring
 * match here would sweep half of a dev channel into the tracker.
 */
export function containsTriggerKeyword(text: string, keywords: readonly string[]): boolean {
  if (!text) return false;
  return keywords.some((keyword) => {
    const trimmed = keyword.trim();
    if (!trimmed) return false;
    return new RegExp(`(?:^|\\W)${escapeRegExp(trimmed)}(?:\\W|$)`, 'i').test(text);
  });
}

/**
 * Cheap pre-filter for chatter, applied before any model tokens are spent.
 *
 * Deliberately conservative: it only drops things that cannot be a bug report
 * under any reading. Anything borderline goes to the classifier.
 */
export function isLikelyNoise(content: string): boolean {
  const stripped = stripDiscordMentions(content)
    .replace(/<a?:\w+:\d+>/g, '') // custom emoji
    .replace(/https?:\/\/\S+/g, '')
    .trim();

  if (stripped.length < MIN_SIGNAL_LENGTH) return true;
  if (!/\p{Letter}/u.test(stripped)) return true;

  const normalized = stripped
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s+]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return NOISE_PHRASES.has(normalized);
}

/**
 * Structural filter: is this a human message at all?
 *
 * Drops bots (including our own replies), webhook posts such as the deploy
 * notifications, and system events.
 */
export function isCollectableMessage(message: DiscordMessage, selfUserId: string | null): boolean {
  if (message.webhook_id) return false;
  if (message.author?.bot) return false;
  if (selfUserId && message.author?.id === selfUserId) return false;
  return COLLECTABLE_MESSAGE_TYPES.has(message.type ?? 0);
}

/**
 * Stable pseudonym for a reporter.
 *
 * Lets a maintainer notice the same person filing three issues, and lets an
 * admin resolve identity privately, without publishing a Discord id. Salted with
 * the guild id so the digest isn't a lookup table across servers.
 */
export function authorRef(guildId: string, authorId: string): string {
  return `discord-${createHash('sha256').update(`${guildId}:${authorId}`).digest('hex').slice(0, 12)}`;
}

/** Deep link that opens the Discord client on the message. Carries no user id. */
export function messageJumpUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Mentions first, then PII patterns. Order matters: mentions are ids, not prose. */
export function sanitizeText(text: string): string {
  return redactSensitiveText(stripDiscordMentions(text ?? ''));
}

/** Truncate to Discord's per-message cap, leaving room for the ellipsis. */
export function clampDiscordMessage(content: string): string {
  if (content.length <= DISCORD_MESSAGE_LIMIT) return content;
  return `${content.slice(0, DISCORD_MESSAGE_LIMIT - 1)}…`;
}

function collectAttachments(message: DiscordMessage, maxAttachments: number): CollectedAttachment[] {
  return (message.attachments ?? [])
    .filter((attachment) => attachment.url && (attachment.content_type ?? '').startsWith('image/'))
    .slice(0, maxAttachments)
    .map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename ?? `${attachment.id}.png`,
      contentType: attachment.content_type ?? null,
      size: attachment.size ?? null,
      url: attachment.url as string,
    }));
}

export type BuildCollectedMessageInput = {
  message: DiscordMessage;
  guildId: string;
  channelName?: string | null;
  trigger: TriggerKind;
  threadId?: string | null;
  threadMessages?: DiscordMessage[];
  maxAttachments?: number;
  maxThreadMessages?: number;
};

/**
 * Shape a raw Discord message into the redacted record handed to the model.
 *
 * Built from an explicit field list and never spread from the raw message, so a
 * new Discord API field cannot silently start leaking identity into a public
 * issue. Everything identity-bearing (`author.username`, `author.id`, avatars,
 * nicknames) is dropped here and replaced with `authorRef`.
 */
export function buildCollectedMessage({
  message,
  guildId,
  channelName = null,
  trigger,
  threadId = null,
  threadMessages = [],
  maxAttachments = 4,
  maxThreadMessages = 20,
}: BuildCollectedMessageInput): CollectedMessage {
  const authorId = message.author?.id ?? 'unknown';

  return {
    messageId: message.id,
    channelId: message.channel_id,
    channelName,
    guildId,
    threadId,
    trigger,
    authorRef: authorRef(guildId, authorId),
    timestamp: message.timestamp ?? '',
    jumpUrl: messageJumpUrl(guildId, message.channel_id, message.id),
    content: sanitizeText(message.content ?? ''),
    threadContext: threadMessages.slice(0, maxThreadMessages).map((threadMessage) => ({
      authorRef: authorRef(guildId, threadMessage.author?.id ?? 'unknown'),
      content: sanitizeText(threadMessage.content ?? ''),
    })),
    attachments: collectAttachments(message, maxAttachments),
  };
}
