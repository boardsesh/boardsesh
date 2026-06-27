/**
 * Discord webhook forwarding for user-submitted feedback.
 *
 * Posts a compact embed to a single webhook URL. Fire-and-forget: a slow or
 * broken Discord endpoint must never fail the originating mutation.
 *
 * Privacy: the payload intentionally omits userId, username, and email. Only
 * the feedback row id is included so a moderator can correlate the Discord
 * message with a DB row by id alone.
 */

import type { AppFeedbackPlatform, AppFeedbackSource, FeedbackContextInput } from '@boardsesh/shared-schema';
import { logger } from '../utils/logger';

const BUG_SOURCES: ReadonlySet<AppFeedbackSource> = new Set(['shake-bug', 'drawer-bug']);

const COLOR_GREEN = 0x57f287;
const COLOR_YELLOW = 0xfee75c;
const COLOR_RED = 0xed4245;

export type FeedbackDiscordPayload = {
  feedbackId: string | number | bigint;
  rating: number | null;
  comment: string | null;
  platform: AppFeedbackPlatform;
  appVersion: string | null;
  source: AppFeedbackSource;
  boardName?: string | null;
  layoutId?: number | null;
  sizeId?: number | null;
  setIds?: number[] | null;
  angle?: number | null;
  context?: FeedbackContextInput | null;
};

function formatBoard(payload: FeedbackDiscordPayload): string | null {
  if (!payload.boardName) return null;
  const parts: string[] = [payload.boardName];
  if (payload.layoutId != null) parts.push(`layout ${payload.layoutId}`);
  if (payload.sizeId != null) parts.push(`size ${payload.sizeId}`);
  if (payload.setIds && payload.setIds.length > 0) parts.push(`sets [${payload.setIds.join(',')}]`);
  const base = parts.join(' / ');
  return payload.angle != null ? `${base} @ ${payload.angle}°` : base;
}

// Discord caps an embed field value at 1024 chars. Wrap the BLE report in a
// fenced code block (preserves the line-oriented layout) and truncate the text
// so the fences always fit.
const DISCORD_FIELD_MAX = 1024;
const BLE_FENCE_OVERHEAD = '```\n\n```'.length;

function formatBleDiagnostics(report: string): string {
  const budget = DISCORD_FIELD_MAX - BLE_FENCE_OVERHEAD;
  const body = report.length > budget ? `${report.slice(0, budget - 1)}…` : report;
  return `\`\`\`\n${body}\n\`\`\``;
}

/** @internal exported for testing only; do not call from resolver code. */
export function buildWebhookBody(payload: FeedbackDiscordPayload): Record<string, unknown> {
  const isBug = BUG_SOURCES.has(payload.source);
  const title = isBug ? '🐞 Bug report' : `⭐ Rating: ${payload.rating ?? '?'}/5`;
  let color: number;
  if (isBug) {
    color = COLOR_RED;
  } else if (payload.rating !== null && payload.rating >= 4) {
    color = COLOR_GREEN;
  } else if (payload.rating !== null && payload.rating >= 3) {
    color = COLOR_YELLOW;
  } else {
    color = COLOR_RED;
  }

  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Platform', value: payload.platform, inline: true },
    { name: 'Source', value: payload.source, inline: true },
    { name: 'App version', value: payload.appVersion ?? 'unknown', inline: true },
  ];

  const board = formatBoard(payload);
  if (board) fields.push({ name: 'Board', value: board, inline: false });

  const ctx = payload.context;
  if (ctx?.climbName || ctx?.climbUuid) {
    let climbValue: string;
    if (ctx.climbName) {
      climbValue = ctx.difficulty ? `${ctx.climbName} (${ctx.difficulty})` : ctx.climbName;
    } else {
      climbValue = ctx.climbUuid ?? '';
    }
    fields.push({ name: 'Climb', value: climbValue, inline: false });
  }
  if (ctx?.sessionId) {
    fields.push({
      name: 'Session',
      value: ctx.sessionName ? `${ctx.sessionName} (${ctx.sessionId})` : ctx.sessionId,
      inline: false,
    });
  }
  if (ctx?.url) fields.push({ name: 'URL', value: ctx.url, inline: false });
  if (ctx?.userAgent) fields.push({ name: 'User agent', value: ctx.userAgent, inline: false });
  if (ctx?.bleDiagnostics) {
    fields.push({ name: 'Bluetooth diagnostics', value: formatBleDiagnostics(ctx.bleDiagnostics), inline: false });
  }

  return {
    username: 'Boardsesh Feedback',
    embeds: [
      {
        title,
        description: payload.comment ?? '(no comment)',
        color,
        fields,
        footer: { text: `feedback #${payload.feedbackId}` },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Post a feedback row to the Discord webhook. Never throws.
 * Safe to call without `await` — errors are logged and swallowed.
 */
export async function postFeedbackToDiscord(payload: FeedbackDiscordPayload): Promise<void> {
  const url = process.env.DISCORD_FEEDBACK_URL;
  if (!url) return;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWebhookBody(payload)),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '<unreadable>');
      logger.error(`[Discord] Webhook POST failed: ${response.status} ${errorText}`);
    }
  } catch (error) {
    logger.error('[Discord] Webhook POST error:', error);
  }
}
