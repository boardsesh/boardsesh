/// <reference types="node" />

import { createHash } from 'node:crypto';

import { redactSensitiveText, stripDiscordMentions } from '@boardsesh/text-redaction';

export const DISCORD_MESSAGE_LIMIT = 2000;
export const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

const COLLECTABLE_MESSAGE_TYPES: ReadonlySet<number> = new Set([0, 19, 21]);

export type DiscordAttachment = {
  id: string;
  filename?: string;
  size?: number;
  content_type?: string;
  url?: string;
};

export type DiscordAuthor = {
  id: string;
  bot?: boolean;
};

export type DiscordMessage = {
  id: string;
  channel_id: string;
  type?: number;
  content?: string;
  timestamp?: string;
  author?: DiscordAuthor;
  webhook_id?: string;
  attachments?: DiscordAttachment[];
  mentions?: Array<{ id?: string }>;
  message_reference?: {
    message_id?: string;
    channel_id?: string;
    guild_id?: string;
  };
};

export type DiscordChannel = {
  id: string;
  name?: string;
  type?: number;
  guild_id?: string;
  parent_id?: string | null;
};

export type CommandSourceKind = 'thread' | 'reply' | 'channel-context';

export type CollectedAttachment = {
  id: string;
  sourceMessageId: string;
  filename: string;
  contentType: string | null;
  size: number | null;
  /** Signed Discord CDN URL. The apply job downloads it immediately. */
  url: string;
};

export type CollectedContextMessage = {
  messageId: string;
  authorRef: string;
  timestamp: string;
  content: string;
};

export type CollectedCommand = {
  messageId: string;
  channelId: string;
  channelName: string | null;
  guildId: string;
  sourceKind: CommandSourceKind;
  /** Redacted text after the bot mention. This is the maintainer's instruction. */
  instruction: string;
  authorRef: string;
  timestamp: string;
  jumpUrl: string;
};

export type CollectedSource = {
  messageId: string;
  channelId: string;
  channelName: string | null;
  guildId: string;
  threadId: string | null;
  authorRef: string;
  timestamp: string;
  jumpUrl: string;
  content: string;
  /** Human discussion only, oldest first. */
  context: CollectedContextMessage[];
  attachments: CollectedAttachment[];
};

export type CollectBundle = {
  version: 2;
  guildId: string;
  generatedAt: string;
  command: CollectedCommand;
  source: CollectedSource;
};

export function authorRef(guildId: string, authorId: string): string {
  return `discord-${createHash('sha256').update(`${guildId}:${authorId}`).digest('hex').slice(0, 12)}`;
}

export function messageJumpUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

export function sanitizeText(text: string): string {
  return redactSensitiveText(stripDiscordMentions(text ?? '')).trim();
}

export function clampDiscordMessage(content: string): string {
  if (content.length <= DISCORD_MESSAGE_LIMIT) return content;
  return `${content.slice(0, DISCORD_MESSAGE_LIMIT - 1)}…`;
}

export function isCollectableMessage(message: DiscordMessage, selfUserId: string): boolean {
  if (message.webhook_id || message.author?.bot) return false;
  if (!message.author?.id || message.author.id === selfUserId) return false;
  return COLLECTABLE_MESSAGE_TYPES.has(message.type ?? 0);
}

export function mentionsUser(message: DiscordMessage, userId: string): boolean {
  return (message.mentions ?? []).some((mentionedUser) => mentionedUser.id === userId);
}

export function extractCommandInstruction(content: string, botUserId: string): string {
  const mentionMatch = content.match(new RegExp(`<@!?${botUserId}>`));
  if (mentionMatch?.index === undefined) return '';
  return sanitizeText(
    content
      .slice(mentionMatch.index + mentionMatch[0].length)
      .replaceAll(`<@${botUserId}>`, ' ')
      .replaceAll(`<@!${botUserId}>`, ' '),
  );
}

export function collectImageAttachments(
  messages: readonly DiscordMessage[],
  maxAttachments = 4,
): CollectedAttachment[] {
  const attachments: CollectedAttachment[] = [];
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachments.length >= maxAttachments) return attachments;
      if (!attachment.url || !(attachment.content_type ?? '').startsWith('image/')) continue;
      attachments.push({
        id: attachment.id,
        sourceMessageId: message.id,
        filename: attachment.filename ?? `${attachment.id}.png`,
        contentType: attachment.content_type ?? null,
        size: attachment.size ?? null,
        url: attachment.url,
      });
    }
  }
  return attachments;
}

export function buildCollectedContextMessage(message: DiscordMessage, guildId: string): CollectedContextMessage {
  return {
    messageId: message.id,
    authorRef: authorRef(guildId, message.author?.id ?? 'unknown'),
    timestamp: message.timestamp ?? '',
    content: sanitizeText(message.content ?? ''),
  };
}
